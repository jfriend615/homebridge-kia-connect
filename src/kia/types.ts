import type { PlatformConfig } from 'homebridge';

export interface KiaConnectConfig extends PlatformConfig {
  username: string;
  password: string;
  pollIntervalMinutes?: number;
  enableClimateControl?: boolean;
  enableDoorLock?: boolean;
  vehicleIndex?: number;
}

export interface PersistedToken {
  accessToken: string;   // sid
  refreshToken: string;  // rmtoken
  deviceId: string;
  vehicleKey?: string;
  vehicleId?: string;
  vehicleVin?: string;
  validUntil: number;    // epoch ms
}

export interface KiaApiResponse {
  status: {
    statusCode: number;
    errorType: number;
    errorCode: number;
    errorMessage: string;
  };
  payload?: unknown;
}

export interface OtpState {
  otpKey: string;
  xid: string;
  email?: string;
  sms?: string;
}

export interface VehicleSummary {
  id: string;
  name: string;
  model: string;
  key: string;
  vin: string;
}

export interface VehicleState {
  // Doors
  frontLeftDoorOpen: boolean;
  frontRightDoorOpen: boolean;
  rearLeftDoorOpen: boolean;
  rearRightDoorOpen: boolean;
  hoodOpen: boolean;
  trunkOpen: boolean;

  // Lock
  locked: boolean;

  // Engine
  engineRunning: boolean;
  airControlOn: boolean;
  defrostOn: boolean;

  // Temperature
  outsideTemperature: number | null;

  // Battery
  batteryPercentage: number | null;

  // Fuel
  fuelLevel: number | null;
  fuelLevelLow: boolean;
  fuelDrivingRange: number | null;

  // Windows
  frontLeftWindowOpen: boolean;
  frontRightWindowOpen: boolean;
  rearLeftWindowOpen: boolean;
  rearRightWindowOpen: boolean;

  // Tire
  tirePressureWarning: boolean;

  // Odometer
  odometer: number | null;

  // Location
  latitude: number | null;
  longitude: number | null;

  // Meta
  lastUpdated: string | null;
}

export type LoginResult =
  | { success: true }
  | { success: false; otpRequired: true; otpState: OtpState }
  | { success: false; otpRequired?: false };

export interface ClimateOptions {
  temperature?: number;
  defrost?: boolean;
}

export class KiaApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorCode: number,
  ) {
    super(message);
    this.name = 'KiaApiError';
  }
}

export class AuthenticationError extends KiaApiError {
  constructor(message: string, statusCode: number, errorCode: number) {
    super(message, statusCode, errorCode);
    this.name = 'AuthenticationError';
  }
}
