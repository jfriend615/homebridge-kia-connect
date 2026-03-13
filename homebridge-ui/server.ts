import type { Logger } from 'homebridge';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils/dist/server.js';
import { KiaAuthManager } from '../src/kia/auth.js';
import { KiaApiClient } from '../src/kia/client.js';
import { AuthenticationError } from '../src/kia/types.js';
import type { OtpState } from '../src/kia/types.js';
import { readSavedCredentials } from './config.js';

function createConsoleLogger(prefix: string): Logger {
  return {
    info: (...args: unknown[]) => console.log(`[${prefix}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${prefix}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${prefix}]`, ...args),
    debug: (...args: unknown[]) => console.debug(`[${prefix}]`, ...args),
    log: (...args: unknown[]) => console.log(`[${prefix}]`, ...args),
    success: (...args: unknown[]) => console.log(`[${prefix}]`, ...args),
    prefix,
  } satisfies Logger;
}

class KiaConnectUiServer extends HomebridgePluginUiServer {
  private authManager?: KiaAuthManager;
  private apiClient?: KiaApiClient;
  private otpState?: OtpState;
  private pendingCredentials?: { username: string; password: string };

  constructor() {
    super();

    this.onRequest('/auth/status', this.handleAuthStatus.bind(this));
    this.onRequest('/auth/login', this.handleLogin.bind(this));
    this.onRequest('/auth/send-otp', this.handleSendOtp.bind(this));
    this.onRequest('/auth/verify-otp', this.handleVerifyOtp.bind(this));

    this.ready();
  }

  private getClients(): { authManager: KiaAuthManager; apiClient: KiaApiClient } {
    if (!this.authManager) {
      const storagePath = this.homebridgeStoragePath ?? '/tmp';
      const log = createConsoleLogger('KiaConnect');
      const savedCredentials = readSavedCredentials(this.homebridgeConfigPath);

      this.authManager = new KiaAuthManager(storagePath, log);
      const username = this.pendingCredentials?.username ?? savedCredentials?.username ?? '';
      const password = this.pendingCredentials?.password ?? savedCredentials?.password ?? '';
      this.apiClient = new KiaApiClient(this.authManager, log, username, password);
    }
    return { authManager: this.authManager!, apiClient: this.apiClient! };
  }

  private async handleAuthStatus(): Promise<{ authenticated: boolean; vehicleName?: string }> {
    const { authManager, apiClient } = this.getClients();
    authManager.reloadToken();
    const isValid = authManager.isTokenValid();

    if (!isValid) {
      return { authenticated: false };
    }

    try {
      await apiClient.getVehicles();
      return { authenticated: true };
    } catch (e) {
      if (e instanceof AuthenticationError) {
        authManager.clearToken();
      }
      return { authenticated: false };
    }
  }

  private async handleLogin(payload: { username?: string; password?: string }): Promise<{ success: boolean; otpRequired?: boolean; email?: string; sms?: string }> {
    // Re-create clients with credentials if provided
    if (payload?.username && payload?.password) {
      this.authManager = undefined;
      this.apiClient = undefined;
      this.pendingCredentials = { username: payload.username, password: payload.password };
    }
    const { apiClient } = this.getClients();

    try {
      const result = await apiClient.login();

      if (result.success) {
        return { success: true };
      }

      if (result.otpRequired && result.otpState) {
        this.otpState = result.otpState;
        return {
          success: false,
          otpRequired: true,
          email: result.otpState.email,
          sms: result.otpState.sms,
        };
      }

      return { success: false };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Login failed';
      throw new RequestError(message, { status: 500 });
    }
  }

  private async handleSendOtp(payload: { method: 'EMAIL' | 'SMS' }): Promise<{ success: boolean }> {
    if (!this.otpState) {
      throw new RequestError('No OTP session in progress. Login first.', { status: 400 });
    }

    const { apiClient } = this.getClients();

    try {
      await apiClient.sendOtp(this.otpState, payload.method ?? 'EMAIL');
      return { success: true };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to send OTP';
      throw new RequestError(message, { status: 500 });
    }
  }

  private async handleVerifyOtp(payload: { code: string }): Promise<{ success: boolean }> {
    if (!this.otpState) {
      throw new RequestError('No OTP session in progress. Login first.', { status: 400 });
    }

    const { apiClient } = this.getClients();

    try {
      const success = await apiClient.verifyOtp(this.otpState, payload.code);
      if (success) {
        this.otpState = undefined;
        return { success: true };
      }
      throw new RequestError('OTP verification failed', { status: 400 });
    } catch (e: unknown) {
      if (e instanceof RequestError) {
        throw e;
      }
      const message = e instanceof Error ? e.message : 'OTP verification failed';
      throw new RequestError(message, { status: 500 });
    }
  }
}

(() => new KiaConnectUiServer())();
