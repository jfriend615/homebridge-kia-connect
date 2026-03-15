import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { KiaAuthManager } from './kia/auth.js';
import { KiaApiClient } from './kia/client.js';
import { AuthenticationError } from './kia/types.js';
import type { KiaConnectConfig, OtpState } from './kia/types.js';
import { VehicleAccessory } from './vehicle-accessory.js';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  DEFAULT_POLL_INTERVAL_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
} from './settings.js';

export class KiaConnectPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly kiaConfig: KiaConnectConfig;
  private authManager!: KiaAuthManager;
  private apiClient!: KiaApiClient;
  private pollTimer?: ReturnType<typeof setInterval>;
  private otpWatcher?: ReturnType<typeof setInterval>;
  private vehicleAccessory?: VehicleAccessory;

  // Exposed for custom UI server
  public otpState?: OtpState;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.kiaConfig = config as KiaConnectConfig;

    if (!this.kiaConfig.username || !this.kiaConfig.password) {
      this.log.error('Kia Connect username and password are required in config');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((e) => {
        this.log.error('Failed to discover devices:', e);
      });
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      this.stopOtpWatcher();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    this.stopOtpWatcher();

    this.authManager = new KiaAuthManager(this.api.user.storagePath(), this.log);
    this.apiClient = new KiaApiClient(this.authManager, this.log, this.kiaConfig.username, this.kiaConfig.password);

    if (this.authManager.isTokenValid()) {
      this.log.info('Using persisted Kia Connect session');
      await this.setupVehicle();
      return;
    }

    // Attempt login
    const loginResult = await this.apiClient.login();

    if (!loginResult.success) {
      if (loginResult.otpRequired) {
        this.otpState = loginResult.otpState;
        this.log.warn('OTP authentication required. Please open the plugin settings in Homebridge Config UI to complete the OTP flow.');
        this.startOtpWatcher();
        return;
      }
      this.log.error('Login failed. Check your credentials.');
      return;
    }

    await this.setupVehicle();
  }

  private async setupVehicle(): Promise<void> {
    this.stopOtpWatcher();
    this.otpState = undefined;

    // Get vehicles
    const vehicles = await this.apiClient.getVehicles();
    if (vehicles.length === 0) {
      this.log.error('No vehicles found on this account');
      this.removeCachedAccessories();
      return;
    }

    const vehicleIndex = this.kiaConfig.vehicleIndex ?? 0;
    if (vehicleIndex >= vehicles.length) {
      this.log.error(`Vehicle index ${vehicleIndex} out of range (${vehicles.length} vehicles found)`);
      this.removeCachedAccessories();
      return;
    }

    const vehicle = vehicles[vehicleIndex]!;
    this.log.info(`Found vehicle: ${vehicle.name} (${vehicle.model}) VIN: ${vehicle.vin}`);

    // Store the current session key plus stable vehicle identity for future re-logins
    this.authManager.setVehicleIdentity(vehicle.key, vehicle.id, vehicle.vin);

    // Create or restore accessory
    const accessoryIdentity = vehicle.vin || vehicle.id || vehicle.key;
    const uuid = this.api.hap.uuid.generate(accessoryIdentity);
    let accessory = this.accessories.get(uuid);

    if (accessory) {
      this.log.info('Restoring existing accessory from cache:', vehicle.name);
    } else {
      this.log.info('Adding new accessory:', vehicle.name);
      accessory = new this.api.platformAccessory(vehicle.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    this.removeCachedAccessories(uuid);

    // Create VehicleAccessory
    this.vehicleAccessory = new VehicleAccessory(
      this,
      accessory,
      this.apiClient,
      vehicle.key,
      vehicle,
      this.kiaConfig,
    );

    // Fetch initial state
    try {
      const state = await this.apiClient.getVehicleStatus(vehicle.key);
      this.vehicleAccessory.updateState(state);
      this.log.info('Initial vehicle state loaded');
    } catch (e) {
      this.log.warn('Failed to fetch initial vehicle state:', e);
    }

    // Start polling
    this.startPolling(vehicle.key);
  }

  private startPolling(vehicleKey: string): void {
    // Clear any existing poll timer to prevent duplicates
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    const intervalMinutes = Math.max(
      this.kiaConfig.pollIntervalMinutes ?? DEFAULT_POLL_INTERVAL_MINUTES,
      MIN_POLL_INTERVAL_MINUTES,
    );
    const intervalMs = intervalMinutes * 60 * 1000;

    this.log.info(`Starting polling every ${intervalMinutes} minutes`);

    this.pollTimer = setInterval(() => {
      this.pollVehicleState(vehicleKey).catch((e) => {
        this.log.warn('Poll error:', e);
      });
    }, intervalMs);
  }

  private removeCachedAccessories(keepUuid?: string): void {
    for (const [cachedUuid, cachedAccessory] of this.accessories) {
      if (cachedUuid === keepUuid) {
        continue;
      }
      this.log.info('Removing stale accessory:', cachedAccessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cachedAccessory]);
      this.accessories.delete(cachedUuid);
    }
  }

  private startOtpWatcher(): void {
    if (this.otpWatcher) {
      return;
    }

    this.otpWatcher = setInterval(() => {
      this.resumeAfterOtp().catch((e) => {
        this.log.debug('OTP completion check failed:', e);
      });
    }, 10000);
  }

  private stopOtpWatcher(): void {
    if (this.otpWatcher) {
      clearInterval(this.otpWatcher);
      this.otpWatcher = undefined;
    }
  }

  private async resumeAfterOtp(): Promise<void> {
    if (!this.otpState) {
      this.stopOtpWatcher();
      return;
    }

    this.authManager.reloadToken();
    if (!this.authManager.isTokenValid()) {
      return;
    }

    this.log.info('Detected completed OTP authentication, resuming vehicle setup');
    await this.setupVehicle();
  }

  private async pollVehicleState(vehicleKey: string): Promise<void> {
    try {
      const state = await this.apiClient.getVehicleStatus(vehicleKey);
      this.vehicleAccessory?.updateState(state);
      this.log.debug('Vehicle state updated via poll');
    } catch (e) {
      if (e instanceof AuthenticationError) {
        this.log.error('Authentication error during poll, stopping polling. Re-authenticate via Config UI.');
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = undefined;
        }
      } else {
        this.log.warn('Failed to poll vehicle state:', e);
      }
    }
  }
}
