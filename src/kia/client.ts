import * as https from 'node:https';
import { URL } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { Logger } from 'homebridge';
import type { KiaAuthManager } from './auth.js';
import type { ClimateOptions, KiaApiResponse, LoginResult, OtpState, VehicleSummary, VehicleState } from './types.js';
import { AuthenticationError, KiaApiError } from './types.js';
import { generateClientUuid } from './crypto.js';
import {
  KIA_API_BASE,
  ACTION_STATUS_POLL_INTERVAL_MS,
  ACTION_STATUS_MAX_ATTEMPTS,
} from '../settings.js';

const tlsAgent = new https.Agent({
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ciphers: 'DEFAULT:@SECLEVEL=1',
});

// Matches the Python library's api_headers() exactly
const STATIC_HEADERS: Record<string, string> = {
  'content-type': 'application/json;charset=utf-8',
  'accept': 'application/json',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  'accept-charset': 'utf-8',
  'apptype': 'L',
  'appversion': '7.22.0',
  'clientid': 'SPACL716-APL',
  'from': 'SPA',
  'host': 'api.owners.kia.com',
  'language': '0',
  'ostype': 'iOS',
  'osversion': '15.8.5',
  'phonebrand': 'iPhone',
  'secretkey': 'sydnat-9kykci-Kuhtep-h5nK',
  'to': 'APIGW',
  'tokentype': 'A',
  'user-agent': 'KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0',
};

interface HttpResponse {
  statusCode: number;
  body: KiaApiResponse;
  headers: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeBody(body: Buffer, contentEncoding?: string): string {
  switch (contentEncoding?.toLowerCase()) {
    case 'gzip':
      return gunzipSync(body).toString('utf-8');
    case 'deflate':
      return inflateSync(body).toString('utf-8');
    case 'br':
      return brotliDecompressSync(body).toString('utf-8');
    default:
      return body.toString('utf-8');
  }
}

export class KiaApiClient {
  private readonly username: string;
  private readonly password: string;

  constructor(
    private readonly auth: KiaAuthManager,
    private readonly log: Logger,
    username: string,
    password: string,
  ) {
    this.username = username;
    this.password = password;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const deviceId = this.auth.getDeviceId();
    const now = new Date();
    const offset = -now.getTimezoneOffset() / 60;

    const headers: Record<string, string> = {
      ...STATIC_HEADERS,
      'date': now.toUTCString(),
      'deviceid': deviceId,
      'clientuuid': generateClientUuid(deviceId),
      'offset': String(offset),
    };

    if (extra) {
      Object.assign(headers, extra);
    }

    return headers;
  }

  private request(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, KIA_API_BASE);
      const headers = this.buildHeaders(extraHeaders);
      const postData = body ? JSON.stringify(body) : undefined;

      if (postData) {
        headers['content-length'] = Buffer.byteLength(postData).toString();
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers,
        agent: tlsAgent,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const compressedBody = Buffer.concat(chunks);
            const rawBody = decodeBody(compressedBody, res.headers['content-encoding'] as string | undefined);
            const parsed = JSON.parse(rawBody) as KiaApiResponse;
            const responseHeaders: Record<string, string> = {};
            for (const [key, val] of Object.entries(res.headers)) {
              if (typeof val === 'string') {
                responseHeaders[key] = val;
              } else if (Array.isArray(val)) {
                responseHeaders[key] = val[0]!;
              }
            }
            resolve({
              statusCode: res.statusCode ?? 0,
              body: parsed,
              headers: responseHeaders,
            });
          } catch (e) {
            reject(new Error(`Failed to parse response from ${endpoint}: ${e}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Request to ${endpoint} failed: ${e.message}`));
      });

      req.setTimeout(30000, () => {
        req.destroy(new Error(`Request to ${endpoint} timed out`));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  private async authenticatedRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    vehicleKey?: string,
  ): Promise<HttpResponse> {
    const sid = this.auth.getAccessToken();
    if (!sid) {
      throw new AuthenticationError('No access token available', 0, 0);
    }

    const headers: Record<string, string> = {
      ...extraHeaders,
      'sid': sid,
    };
    if (vehicleKey) {
      headers['vinkey'] = vehicleKey;
    }

    const response = await this.request(method, endpoint, body, headers);
    const status = response.body.status;

    // Check for auth errors
    if (status?.statusCode === 1) {
      const errorCode = status?.errorCode;
      if (errorCode === 1003 || errorCode === 1005) {
        this.log.info('Session expired, attempting re-login...');
        const loginResult = await this.login();
        if (loginResult.success) {
          await this.restoreVehicleContext(vehicleKey);

          // Retry with new token
          const newSid = this.auth.getAccessToken();
          if (newSid) {
            headers['sid'] = newSid;
            const retryResponse = await this.request(method, endpoint, body, headers);
            this.assertSuccess(retryResponse, endpoint);
            return retryResponse;
          }
        }
        throw new AuthenticationError(
          status?.errorMessage ?? 'Authentication failed',
          status?.statusCode,
          errorCode,
        );
      }
    }

    this.assertSuccess(response, endpoint);

    return response;
  }

  private async restoreVehicleContext(vehicleKey?: string): Promise<void> {
    const targetVehicleKey = vehicleKey ?? this.auth.getVehicleKey();
    if (!targetVehicleKey) {
      return;
    }

    const sid = this.auth.getAccessToken();
    if (!sid) {
      throw new AuthenticationError('No access token available after re-login', 0, 0);
    }

    const response = await this.request('GET', 'ownr/gvl', undefined, { sid });
    this.assertSuccess(response, 'ownr/gvl');

    const payload = response.body.payload as Record<string, unknown> | undefined;
    const vehicleList = payload?.vehicleSummary;
    if (!Array.isArray(vehicleList)) {
      throw new AuthenticationError('No vehicles found after re-login', 1, 1005);
    }

    const matchingVehicle = vehicleList.find((vehicle) => {
      const vehicleRecord = vehicle as Record<string, unknown>;
      return (vehicleRecord.vehicleKey as string | undefined) === targetVehicleKey;
    });

    if (!matchingVehicle) {
      throw new AuthenticationError('Selected vehicle is not available after re-login', 1, 1005);
    }

    this.auth.setVehicleKey(targetVehicleKey);
  }

  private assertSuccess(response: HttpResponse, endpoint: string): void {
    const status = response.body.status;
    if (!status || status.statusCode === 0) {
      return;
    }

    if (status.errorCode === 1003 || status.errorCode === 1005) {
      throw new AuthenticationError(
        status.errorMessage || `Authentication failed for ${endpoint}`,
        status.statusCode,
        status.errorCode,
      );
    }

    throw new KiaApiError(
      status.errorMessage || `Kia API request failed for ${endpoint}`,
      status.statusCode,
      status.errorCode,
    );
  }

  // --- Auth flow ---

  async login(): Promise<LoginResult> {
    const deviceId = this.auth.getDeviceId();
    const rmtoken = this.auth.getRefreshToken();

    const extraHeaders: Record<string, string> = {};
    if (rmtoken) {
      extraHeaders['rmtoken'] = rmtoken;
    }

    const response = await this.request('POST', 'prof/authUser', {
      deviceKey: deviceId,
      deviceType: 2,
      userCredential: {
        userId: this.username,
        password: this.password,
      },
      tncFlag: 1,
    }, extraHeaders);

    const status = response.body.status;
    const payload = response.body.payload as Record<string, unknown> | undefined;
    this.log.debug('Login response status:', JSON.stringify(status));

    // Check if OTP is required — no sid header means OTP needed
    const sid = response.headers['sid'];
    if (!sid && payload?.otpKey) {
      const otpState: OtpState = {
        otpKey: payload.otpKey as string,
        xid: response.headers['xid'] ?? '',
        email: payload.email as string | undefined,
        sms: payload.sms as string | undefined,
      };
      this.log.info('OTP authentication required');
      return { success: false, otpRequired: true, otpState };
    }

    if (status?.statusCode === 0 && sid) {
      const newRmtoken = response.headers['rmtoken'] ?? rmtoken ?? '';
      this.auth.updateToken(sid, newRmtoken, deviceId);
      this.log.info('Login successful');
      return { success: true };
    }

    this.log.error('Login failed:', status?.errorMessage ?? 'Unknown error');
    return { success: false };
  }

  async sendOtp(otpState: OtpState, method: 'EMAIL' | 'SMS'): Promise<void> {
    // Python library sends otpkey, notifytype, xid as headers with empty JSON body
    const response = await this.request('POST', 'cmm/sendOTP', {}, {
      'otpkey': otpState.otpKey,
      'notifytype': method,
      'xid': otpState.xid,
    });
    this.assertSuccess(response, 'cmm/sendOTP');

    this.log.info(`OTP sent via ${method}`);
  }

  async verifyOtp(otpState: OtpState, code: string): Promise<boolean> {
    // Step 1: Verify the OTP code
    // Python library sends otpkey, xid as headers with {"otp": code} body
    const verifyResponse = await this.request('POST', 'cmm/verifyOTP', {
      otp: code,
    }, {
      'otpkey': otpState.otpKey,
      'xid': otpState.xid,
    });
    this.assertSuccess(verifyResponse, 'cmm/verifyOTP');

    // Step 2: Complete login — call prof/authUser again with sid+rmtoken from verify response
    const verifySid = verifyResponse.headers['sid'] ?? '';
    const verifyRmtoken = verifyResponse.headers['rmtoken'] ?? '';
    const deviceId = this.auth.getDeviceId();

    const reAuthHeaders: Record<string, string> = {};
    if (verifySid) {
      reAuthHeaders['sid'] = verifySid;
    }
    if (verifyRmtoken) {
      reAuthHeaders['rmtoken'] = verifyRmtoken;
    }

    const loginResponse = await this.request('POST', 'prof/authUser', {
      deviceKey: deviceId,
      deviceType: 2,
      userCredential: {
        userId: this.username,
        password: this.password,
      },
    }, reAuthHeaders);
    this.assertSuccess(loginResponse, 'prof/authUser');

    if (loginResponse.body.status?.statusCode === 0) {
      const loginSid = loginResponse.headers['sid'] ?? '';
      const loginRmtoken = loginResponse.headers['rmtoken'] ?? verifyRmtoken;

      if (loginSid) {
        this.auth.updateToken(loginSid, loginRmtoken, deviceId);
        this.log.info('OTP verification and login successful');
        return true;
      }
    }

    this.log.error('Post-OTP login failed');
    return false;
  }

  // --- Vehicle data ---

  async getVehicles(): Promise<VehicleSummary[]> {
    const response = await this.authenticatedRequest('GET', 'ownr/gvl');

    const payload = response.body.payload as Record<string, unknown> | undefined;
    const vehicleList = payload?.vehicleSummary;
    if (!Array.isArray(vehicleList)) {
      this.log.warn('No vehicles found in response');
      return [];
    }

    return vehicleList.map((v: Record<string, unknown>) => ({
      id: (v.vehicleIdentifier as string) ?? '',
      name: (v.nickName as string) ?? (v.vehicleName as string) ?? 'Kia Vehicle',
      model: (v.modelName as string) ?? (v.modelYear as string) ?? 'Unknown',
      key: (v.vehicleKey as string) ?? '',
      vin: (v.vin as string) ?? '',
    }));
  }

  async getVehicleStatus(vehicleKey: string): Promise<VehicleState> {
    const response = await this.authenticatedRequest('POST', 'cmm/gvi', {
      vehicleConfigReq: {
        airTempRange: '0',
        maintenance: '1',
        seatHeatCoolOption: '0',
        vehicle: '1',
        vehicleFeature: '0',
      },
      vehicleInfoReq: {
        drivingActivty: '0',
        dtc: '1',
        enrollment: '1',
        functionalCards: '0',
        location: '1',
        vehicleStatus: '1',
        weather: '0',
      },
      vinKey: [vehicleKey],
    }, undefined, vehicleKey);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deeply nested API response
    const payload = response.body.payload as any;
    const vehicleInfo = payload?.vehicleInfoList?.[0]?.lastVehicleInfo;
    const vehicleStatus = vehicleInfo?.vehicleStatusRpt?.vehicleStatus;
    const location = vehicleInfo?.location?.coord;

    return this.parseVehicleStatus(vehicleStatus, location);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw API shape varies per vehicle
  private parseVehicleStatus(status: any, location: any): VehicleState {
    const doorStatus = status?.doorStatus;
    const windowStatus = status?.windowStatus;
    const tirePressure = status?.tirePressure;
    const climate = status?.climate;
    const engine = status?.engine;
    const battery = status?.battery;
    const fuel = status?.fuel;

    return {
      // Doors (0 = closed, 1 = open)
      frontLeftDoorOpen: doorStatus?.frontLeft === 1,
      frontRightDoorOpen: doorStatus?.frontRight === 1,
      rearLeftDoorOpen: doorStatus?.backLeft === 1,
      rearRightDoorOpen: doorStatus?.backRight === 1,
      hoodOpen: doorStatus?.hood === 1,
      trunkOpen: doorStatus?.trunk === 1,

      // Lock
      locked: doorStatus?.lockStatus === 1 || status?.doorLock === true,

      // Engine
      engineRunning: engine?.ignition === true || status?.engine === true,
      airControlOn: climate?.airCtrl === true || status?.airCtrlOn === true,
      defrostOn: climate?.defrost === true || status?.defrost === true,

      // Temperature
      outsideTemperature: this.parseNumber(status?.outsideTemp),

      // Battery
      batteryPercentage: this.parseNumber(battery?.batSoc ?? status?.batteryStatus?.stateOfCharge),

      // Fuel
      fuelLevel: this.parseNumber(fuel?.fuelLevel ?? status?.fuelLevel),
      fuelLevelLow: fuel?.lowFuelLight === true || status?.lowFuelLight === true,
      fuelDrivingRange: this.parseNumber(fuel?.drivingRange ?? status?.distanceToEmpty),

      // Windows (0 = closed)
      frontLeftWindowOpen: (windowStatus?.frontLeft ?? 0) !== 0,
      frontRightWindowOpen: (windowStatus?.frontRight ?? 0) !== 0,
      rearLeftWindowOpen: (windowStatus?.backLeft ?? 0) !== 0,
      rearRightWindowOpen: (windowStatus?.backRight ?? 0) !== 0,

      // Tire pressure
      tirePressureWarning: tirePressure?.tirePressureWarningLamp === true ||
        (tirePressure?.frontLeft?.warning === true) ||
        (tirePressure?.frontRight?.warning === true) ||
        (tirePressure?.rearLeft?.warning === true) ||
        (tirePressure?.rearRight?.warning === true) ||
        false,

      // Odometer
      odometer: this.parseNumber(status?.odometer?.value),

      // Location
      latitude: this.parseNumber(location?.lat),
      longitude: this.parseNumber(location?.lon),

      // Meta
      lastUpdated: status?.lastStatusDate ?? status?.syncDate?.utc ?? null,
    };
  }

  private parseNumber(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  async forceRefresh(vehicleKey: string): Promise<string> {
    const response = await this.authenticatedRequest('POST', 'rems/rvs', {
      requestType: 0,
    }, undefined, vehicleKey);
    return response.headers['xid'] ?? '';
  }

  // --- Vehicle commands ---

  async lockDoors(vehicleKey: string): Promise<string> {
    const response = await this.authenticatedRequest('GET', 'rems/door/lock', undefined, undefined, vehicleKey);
    return response.headers['xid'] ?? '';
  }

  async unlockDoors(vehicleKey: string): Promise<string> {
    const response = await this.authenticatedRequest('GET', 'rems/door/unlock', undefined, undefined, vehicleKey);
    return response.headers['xid'] ?? '';
  }

  async startClimate(vehicleKey: string, options?: ClimateOptions): Promise<string> {
    let tempF = options?.temperature ?? 70;
    if (tempF < 62) {
      tempF = 62;
    } else if (tempF > 82) {
      tempF = 82;
    }

    const response = await this.authenticatedRequest('POST', 'rems/start', {
      remoteClimate: {
        airTemp: {
          unit: 1,
          value: String(tempF),
        },
        airCtrl: true,
        defrost: options?.defrost ? 1 : 0,
        heatingAccessory: {
          rearWindow: 0,
          sideMirror: 0,
          steeringWheel: 0,
          steeringWheelStep: 0,
        },
        ignitionOnDuration: {
          unit: 4,
          value: 10,
        },
      },
    }, undefined, vehicleKey);
    return response.headers['xid'] ?? '';
  }

  async stopClimate(vehicleKey: string): Promise<string> {
    const response = await this.authenticatedRequest('GET', 'rems/stop', undefined, undefined, vehicleKey);
    return response.headers['xid'] ?? '';
  }

  // --- Action status ---

  async waitForAction(vehicleKey: string, actionId: string): Promise<boolean> {
    for (let i = 0; i < ACTION_STATUS_MAX_ATTEMPTS; i++) {
      await sleep(ACTION_STATUS_POLL_INTERVAL_MS);

      try {
        const response = await this.authenticatedRequest('POST', 'cmm/gts', {
          xid: actionId,
        }, undefined, vehicleKey);

        const payload = response.body.payload as Record<string, unknown> | undefined;
        const transactionStatus = payload?.transactionStatus as string | undefined;
        this.log.debug(`Action ${actionId} status: ${transactionStatus}`);

        if (payload && Object.values(payload).every((value) => value === 0)) {
          return true;
        }

        if (transactionStatus === 'COMPLETED' || transactionStatus === 'completed') {
          return true;
        }
        if (transactionStatus === 'FAILED' || transactionStatus === 'failed') {
          this.log.warn(`Action ${actionId} failed`);
          return false;
        }
        // Still pending, continue polling
      } catch (e) {
        if (e instanceof AuthenticationError) {
          this.log.warn(`Authentication error polling action status for ${actionId}: ${e.message}`);
          return false;
        }
        this.log.warn(`Transient error polling action status for ${actionId}: ${e}`);
      }
    }

    this.log.warn(`Action ${actionId} timed out after ${ACTION_STATUS_MAX_ATTEMPTS} attempts`);
    return false;
  }
}
