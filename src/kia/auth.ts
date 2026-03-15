import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'homebridge';
import type { PersistedToken } from './types.js';
import { generateDeviceId } from './crypto.js';
import { SESSION_LIFETIME_MS } from '../settings.js';

export class KiaAuthManager {
  private readonly tokenPath: string;
  private token: PersistedToken | null = null;
  private cachedDeviceId: string | null = null;

  constructor(
    private readonly storagePath: string,
    private readonly log: Logger,
  ) {
    this.tokenPath = join(storagePath, 'kia-connect-token.json');
    this.token = this.loadToken();
  }

  loadToken(): PersistedToken | null {
    try {
      if (!existsSync(this.tokenPath)) {
        return null;
      }
      const data = readFileSync(this.tokenPath, 'utf-8');
      const parsed = JSON.parse(data) as PersistedToken;
      if (parsed.accessToken && parsed.refreshToken && parsed.deviceId) {
        this.log.debug('Loaded persisted token');
        return parsed;
      }
      return null;
    } catch (e) {
      this.log.warn('Could not load persisted token:', e);
      return null;
    }
  }

  saveToken(token: PersistedToken): void {
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true });
      }
      const tmpPath = this.tokenPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(token, null, 2), 'utf-8');
      renameSync(tmpPath, this.tokenPath);
      this.token = token;
      this.log.debug('Token persisted to disk');
    } catch (e) {
      this.log.error('Failed to save token:', e);
    }
  }

  isTokenValid(): boolean {
    return this.token !== null && Date.now() < this.token.validUntil;
  }

  getAccessToken(): string | null {
    return this.token?.accessToken ?? null;
  }

  getRefreshToken(): string | null {
    return this.token?.refreshToken ?? null;
  }

  getDeviceId(): string {
    if (this.token?.deviceId) {
      return this.token.deviceId;
    }
    // Cache in memory so all requests in a session use the same device ID
    // (critical for OTP flow where multiple requests must share identity)
    if (this.cachedDeviceId) {
      return this.cachedDeviceId;
    }
    this.cachedDeviceId = generateDeviceId();
    this.log.debug('Generated new device ID:', this.cachedDeviceId);
    return this.cachedDeviceId;
  }

  getVehicleKey(): string | null {
    return this.token?.vehicleKey ?? null;
  }

  getVehicleId(): string | null {
    return this.token?.vehicleId ?? null;
  }

  getVehicleVin(): string | null {
    return this.token?.vehicleVin ?? null;
  }

  reloadToken(): void {
    this.token = this.loadToken();
  }

  updateToken(accessToken: string, refreshToken: string, deviceId?: string): void {
    const token: PersistedToken = {
      accessToken,
      refreshToken,
      deviceId: deviceId ?? this.getDeviceId(),
      vehicleKey: this.token?.vehicleKey,
      vehicleId: this.token?.vehicleId,
      vehicleVin: this.token?.vehicleVin,
      validUntil: Date.now() + SESSION_LIFETIME_MS,
    };
    this.saveToken(token);
  }

  setVehicleIdentity(vehicleKey: string, vehicleId?: string, vehicleVin?: string): void {
    if (this.token) {
      this.token.vehicleKey = vehicleKey;
      this.token.vehicleId = vehicleId;
      this.token.vehicleVin = vehicleVin;
      this.saveToken(this.token);
    }
  }

  clearToken(): void {
    this.token = null;
    try {
      if (existsSync(this.tokenPath)) {
        unlinkSync(this.tokenPath);
      }
    } catch (e) {
      this.log.warn('Failed to clear token file:', e);
    }
  }
}
