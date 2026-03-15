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
import type { KiaConnectConfig, OtpState, VehicleState } from './kia/types.js';
import {
  resolveAccessoryPresentation,
  type AccessoryCategory,
  type AccessoryPresentation,
} from './accessory-layout.js';
import {
  BatteryAccessory,
  BodyAccessory,
  ClimateAccessory,
  LockAccessory,
  StatusAccessory,
  type VehicleAccessoryInstance,
} from './vehicle-accessory.js';
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
  private activeAccessories: VehicleAccessoryInstance[] = [];

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

    this.authManager.setVehicleIdentity(vehicle.key, vehicle.id, vehicle.vin);

    const accessoryIdentity = vehicle.vin || vehicle.id || vehicle.key;
    const presentation = resolveAccessoryPresentation(this.kiaConfig);
    const requiredAccessories = this.buildAccessoryDefinitions(vehicle, accessoryIdentity, presentation);
    const keepUuids = new Set(requiredAccessories.map((definition) => definition.uuid));
    this.activeAccessories = requiredAccessories.map((definition) => {
      const accessory = this.getOrCreateAccessory(definition.name, definition.uuid);
      return definition.create(accessory);
    });

    this.removeCachedAccessories(keepUuids);

    try {
      const state = await this.apiClient.getVehicleStatus(vehicle.key);
      this.updateActiveAccessories(state);
      this.log.info('Initial vehicle state loaded');
    } catch (e) {
      this.log.warn('Failed to fetch initial vehicle state:', e);
    }

    this.startPolling(vehicle.key);
  }

  private buildAccessoryDefinitions(
    vehicle: { name: string; key: string; id: string; vin: string; model: string },
    accessoryIdentity: string,
    presentation: AccessoryPresentation,
  ): Array<{
    name: string;
    uuid: string;
    create: (accessory: PlatformAccessory) => VehicleAccessoryInstance;
  }> {
    return presentation.enabledCategories.map((category) => ({
      name: `${vehicle.name} ${this.getCategorySuffix(category)}`,
      uuid: this.api.hap.uuid.generate(`${accessoryIdentity}:${category}`),
      create: (accessory: PlatformAccessory) => this.createGroupedAccessory(category, accessory, vehicle),
    }));
  }

  private createGroupedAccessory(
    category: AccessoryCategory,
    accessory: PlatformAccessory,
    vehicle: { name: string; key: string; id: string; vin: string; model: string },
  ): VehicleAccessoryInstance {
    switch (category) {
    case 'lock':
      return new LockAccessory(this, accessory, this.apiClient, vehicle.key, vehicle);
    case 'climate':
      return new ClimateAccessory(this, accessory, this.apiClient, vehicle.key, vehicle, this.kiaConfig.climateTemperature);
    case 'status':
      return new StatusAccessory(this, accessory, vehicle);
    case 'body':
      return new BodyAccessory(this, accessory, vehicle);
    case 'battery':
      return new BatteryAccessory(this, accessory, vehicle);
    }
  }

  private getCategorySuffix(category: AccessoryCategory): string {
    switch (category) {
    case 'lock':
      return 'Lock';
    case 'climate':
      return 'Climate';
    case 'status':
      return 'Status';
    case 'body':
      return 'Body';
    case 'battery':
      return 'Battery';
    }
  }

  private getOrCreateAccessory(name: string, uuid: string): PlatformAccessory {
    const existingAccessory = this.accessories.get(uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.displayName = name;
      return existingAccessory;
    }

    this.log.info('Adding new accessory:', name);
    const accessory = new this.api.platformAccessory(name, uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(uuid, accessory);
    return accessory;
  }

  private updateActiveAccessories(state: VehicleState): void {
    for (const accessory of this.activeAccessories) {
      accessory.updateState(state);
    }
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

  private removeCachedAccessories(keepUuids?: Set<string>): void {
    for (const [cachedUuid, cachedAccessory] of this.accessories) {
      if (keepUuids?.has(cachedUuid)) {
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
      this.updateActiveAccessories(state);
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
