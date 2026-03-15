import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
  WithUUID,
} from 'homebridge';
import type { KiaConnectPlatform } from './platform.js';
import type { KiaApiClient } from './kia/client.js';
import type { VehicleSummary, VehicleState } from './kia/types.js';
import type { AccessoryCategory } from './accessory-layout.js';

type CommandKey = 'lock' | 'climate';
type ServiceKey = CommandKey | 'fuel' | 'fuel-low' | 'temperature' | 'engine'
  | 'door-fl' | 'door-fr' | 'door-rl' | 'door-rr' | 'hood' | 'trunk'
  | 'window-fl' | 'window-fr' | 'window-rl' | 'window-rr' | 'tire' | 'battery';

export interface VehicleAccessoryInstance {
  updateState(state: VehicleState): void;
}

const CATEGORY_SERVICE_KEYS: Record<AccessoryCategory, readonly ServiceKey[]> = {
  lock: ['lock'],
  climate: ['climate'],
  status: ['fuel', 'fuel-low', 'temperature', 'engine', 'tire'],
  body: ['door-fl', 'door-fr', 'door-rl', 'door-rr', 'hood', 'trunk', 'window-fl', 'window-fr', 'window-rl', 'window-rr'],
  battery: ['battery'],
};

type BooleanStateKey = {
  [K in keyof VehicleState]: VehicleState[K] extends boolean ? K : never;
}[keyof VehicleState];

const CONTACT_SENSOR_MAP: readonly [ServiceKey, BooleanStateKey][] = [
  ['door-fl', 'frontLeftDoorOpen'],
  ['door-fr', 'frontRightDoorOpen'],
  ['door-rl', 'rearLeftDoorOpen'],
  ['door-rr', 'rearRightDoorOpen'],
  ['hood', 'hoodOpen'],
  ['trunk', 'trunkOpen'],
  ['window-fl', 'frontLeftWindowOpen'],
  ['window-fr', 'frontRightWindowOpen'],
  ['window-rl', 'rearLeftWindowOpen'],
  ['window-rr', 'rearRightWindowOpen'],
];

abstract class ConfiguredAccessory implements VehicleAccessoryInstance {
  private readonly services = new Map<ServiceKey, Service>();
  private currentState: VehicleState | null = null;
  private commandsInFlight = new Set<CommandKey>();
  private readonly categories: ReadonlySet<AccessoryCategory>;

  constructor(
    protected readonly platform: KiaConnectPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly vehicle: VehicleSummary,
    private readonly options: {
      categories: readonly AccessoryCategory[];
      apiClient?: KiaApiClient;
      vehicleKey?: string;
      climateTemperature?: number;
    },
  ) {
    this.categories = new Set(options.categories);
    this.setupServices();
  }

  private setupServices(): void {
    const { Service, Characteristic } = this.platform;

    const infoService = this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Kia')
      .setCharacteristic(Characteristic.Model, this.vehicle.model)
      .setCharacteristic(Characteristic.SerialNumber, this.vehicle.vin);

    for (const category of Object.keys(CATEGORY_SERVICE_KEYS) as AccessoryCategory[]) {
      if (!this.categories.has(category)) {
        for (const subtype of CATEGORY_SERVICE_KEYS[category]) {
          this.removeServiceBySubtype(this.getServiceType(subtype), subtype);
          this.services.delete(subtype);
        }
      }
    }

    if (this.categories.has('lock')) {
      const lockService = this.getOrAddService(Service.LockMechanism, 'Door Lock', 'lock');
      lockService.getCharacteristic(Characteristic.LockTargetState)
        .onSet(this.handleLockSet.bind(this));
      this.services.set('lock', lockService);
    }

    if (this.categories.has('climate')) {
      const climateService = this.getOrAddService(Service.Switch, 'Climate', 'climate');
      climateService.getCharacteristic(Characteristic.On)
        .onSet(this.handleClimateSet.bind(this));
      this.services.set('climate', climateService);
    }

    if (this.categories.has('status')) {
      this.services.set('fuel', this.getOrAddService(Service.HumiditySensor, 'Fuel', 'fuel'));
      this.services.set('fuel-low', this.getOrAddService(Service.LeakSensor, 'Low Fuel Warning', 'fuel-low'));
      this.services.set('temperature', this.getOrAddService(Service.TemperatureSensor, 'Outside Temperature', 'temperature'));
      this.services.set('engine', this.getOrAddService(Service.OccupancySensor, 'Engine Running', 'engine'));
      this.services.set('tire', this.getOrAddService(Service.LeakSensor, 'Tire Pressure Warning', 'tire'));
    }

    if (this.categories.has('body')) {
      const bodySensors: [string, ServiceKey][] = [
        ['Front Left Door', 'door-fl'],
        ['Front Right Door', 'door-fr'],
        ['Rear Left Door', 'door-rl'],
        ['Rear Right Door', 'door-rr'],
        ['Hood', 'hood'],
        ['Trunk', 'trunk'],
        ['Front Left Window', 'window-fl'],
        ['Front Right Window', 'window-fr'],
        ['Rear Left Window', 'window-rl'],
        ['Rear Right Window', 'window-rr'],
      ];

      for (const [name, subtype] of bodySensors) {
        this.services.set(subtype, this.getOrAddService(Service.ContactSensor, name, subtype));
      }
    }

    if (this.categories.has('battery')) {
      this.services.set('battery', this.getOrAddService(Service.Battery, '12V Battery', 'battery'));
    }
  }

  private removeServiceBySubtype(serviceType: WithUUID<typeof Service>, subtype: string): void {
    const existing = this.accessory.getServiceById(serviceType, subtype);
    if (existing) {
      this.platform.log.info(`Removing disabled service: ${subtype}`);
      this.accessory.removeService(existing);
    }
  }

  private getOrAddService(
    serviceType: WithUUID<typeof Service>,
    name: string,
    subtype: string,
  ): Service {
    const existing = this.accessory.getServiceById(serviceType, subtype);
    if (existing) {
      existing.setCharacteristic(this.platform.Characteristic.Name, name);
      return existing;
    }
    return this.accessory.addService(serviceType, name, subtype);
  }

  updateState(state: VehicleState): void {
    this.currentState = state;
    const { Characteristic } = this.platform;

    const lockService = this.services.get('lock');
    if (lockService) {
      const lockState = state.locked
        ? Characteristic.LockCurrentState.SECURED
        : Characteristic.LockCurrentState.UNSECURED;
      lockService.updateCharacteristic(Characteristic.LockCurrentState, lockState);
      if (!this.commandsInFlight.has('lock')) {
        const targetState = state.locked
          ? Characteristic.LockTargetState.SECURED
          : Characteristic.LockTargetState.UNSECURED;
        lockService.updateCharacteristic(Characteristic.LockTargetState, targetState);
      }
    }

    const climateService = this.services.get('climate');
    if (climateService) {
      climateService.updateCharacteristic(Characteristic.On, state.airControlOn);
    }

    const fuelService = this.services.get('fuel');
    if (fuelService && state.fuelLevel !== null) {
      fuelService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, state.fuelLevel);
    }

    const lowFuelService = this.services.get('fuel-low');
    if (lowFuelService) {
      lowFuelService.updateCharacteristic(
        Characteristic.LeakDetected,
        state.fuelLevelLow
          ? Characteristic.LeakDetected.LEAK_DETECTED
          : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
    }

    const tempService = this.services.get('temperature');
    if (tempService && state.outsideTemperature !== null) {
      // Kia Connect US API returns temperature in Fahrenheit; HomeKit expects Celsius.
      tempService.updateCharacteristic(
        Characteristic.CurrentTemperature,
        (state.outsideTemperature - 32) * 5 / 9,
      );
    }

    const engineService = this.services.get('engine');
    if (engineService) {
      engineService.updateCharacteristic(
        Characteristic.OccupancyDetected,
        state.engineRunning
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
    }

    for (const [subtype, stateKey] of CONTACT_SENSOR_MAP) {
      this.updateContactSensor(subtype, state[stateKey]);
    }

    const tireService = this.services.get('tire');
    if (tireService) {
      tireService.updateCharacteristic(
        Characteristic.LeakDetected,
        state.tirePressureWarning
          ? Characteristic.LeakDetected.LEAK_DETECTED
          : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
    }

    const batteryService = this.services.get('battery');
    if (batteryService) {
      if (state.batteryPercentage !== null) {
        batteryService.updateCharacteristic(Characteristic.BatteryLevel, state.batteryPercentage);
        batteryService.updateCharacteristic(
          Characteristic.StatusLowBattery,
          state.batteryPercentage < 20
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      }

      batteryService.updateCharacteristic(
        Characteristic.ChargingState,
        Characteristic.ChargingState.NOT_CHARGING,
      );
    }
  }

  private updateContactSensor(subtype: ServiceKey, isOpen: boolean): void {
    const service = this.services.get(subtype);
    if (service) {
      const { Characteristic } = this.platform;
      service.updateCharacteristic(
        Characteristic.ContactSensorState,
        isOpen
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }
  }

  private getServiceType(subtype: ServiceKey): WithUUID<typeof Service> {
    const { Service } = this.platform;

    switch (subtype) {
    case 'lock':
      return Service.LockMechanism;
    case 'climate':
      return Service.Switch;
    case 'fuel':
      return Service.HumiditySensor;
    case 'fuel-low':
    case 'tire':
      return Service.LeakSensor;
    case 'temperature':
      return Service.TemperatureSensor;
    case 'engine':
      return Service.OccupancySensor;
    case 'battery':
      return Service.Battery;
    default:
      return Service.ContactSensor;
    }
  }

  private async handleLockSet(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    if (!this.options.apiClient || !this.options.vehicleKey) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (this.commandsInFlight.has('lock')) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const shouldLock = value === Characteristic.LockTargetState.SECURED;

    this.platform.log.info(`${shouldLock ? 'Locking' : 'Unlocking'} doors...`);
    this.commandsInFlight.add('lock');

    try {
      const actionId = shouldLock
        ? await this.options.apiClient.lockDoors(this.options.vehicleKey)
        : await this.options.apiClient.unlockDoors(this.options.vehicleKey);

      if (actionId) {
        const success = await this.options.apiClient.waitForAction(this.options.vehicleKey, actionId);
        if (!success) {
          throw new Error('Door lock/unlock command did not complete successfully');
        }
      }

      const state = await this.options.apiClient.getVehicleStatus(this.options.vehicleKey);
      this.updateState(state);
    } catch (e) {
      this.platform.log.error('Door lock/unlock failed:', e);

      const lockService = this.services.get('lock');
      if (lockService && this.currentState) {
        lockService.updateCharacteristic(
          Characteristic.LockTargetState,
          this.currentState.locked
            ? Characteristic.LockTargetState.SECURED
            : Characteristic.LockTargetState.UNSECURED,
        );
      }

      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.commandsInFlight.delete('lock');
    }
  }

  private async handleClimateSet(value: CharacteristicValue): Promise<void> {
    if (!this.options.apiClient || !this.options.vehicleKey) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (this.commandsInFlight.has('climate')) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const shouldStart = value === true;

    this.platform.log.info(`${shouldStart ? 'Starting' : 'Stopping'} climate control...`);
    this.commandsInFlight.add('climate');

    try {
      const actionId = shouldStart
        ? await this.options.apiClient.startClimate(this.options.vehicleKey, {
          temperature: this.options.climateTemperature ?? 72,
        })
        : await this.options.apiClient.stopClimate(this.options.vehicleKey);

      if (actionId) {
        const success = await this.options.apiClient.waitForAction(this.options.vehicleKey, actionId);
        if (!success) {
          throw new Error('Climate command did not complete successfully');
        }
      }

      const state = await this.options.apiClient.getVehicleStatus(this.options.vehicleKey);
      this.updateState(state);
    } catch (e) {
      this.platform.log.error('Climate control failed:', e);

      const climateService = this.services.get('climate');
      if (climateService && this.currentState) {
        climateService.updateCharacteristic(this.platform.Characteristic.On, this.currentState.airControlOn);
      }

      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.commandsInFlight.delete('climate');
    }
  }
}

export class LockAccessory extends ConfiguredAccessory {
  constructor(
    platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    apiClient: KiaApiClient,
    vehicleKey: string,
    vehicle: VehicleSummary,
  ) {
    super(platform, accessory, vehicle, {
      categories: ['lock'],
      apiClient,
      vehicleKey,
    });
  }
}

export class ClimateAccessory extends ConfiguredAccessory {
  constructor(
    platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    apiClient: KiaApiClient,
    vehicleKey: string,
    vehicle: VehicleSummary,
    climateTemperature?: number,
  ) {
    super(platform, accessory, vehicle, {
      categories: ['climate'],
      apiClient,
      vehicleKey,
      climateTemperature,
    });
  }
}

export class StatusAccessory extends ConfiguredAccessory {
  constructor(
    platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    vehicle: VehicleSummary,
  ) {
    super(platform, accessory, vehicle, {
      categories: ['status'],
    });
  }
}

export class BodyAccessory extends ConfiguredAccessory {
  constructor(
    platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    vehicle: VehicleSummary,
  ) {
    super(platform, accessory, vehicle, {
      categories: ['body'],
    });
  }
}

export class BatteryAccessory extends ConfiguredAccessory {
  constructor(
    platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    vehicle: VehicleSummary,
  ) {
    super(platform, accessory, vehicle, {
      categories: ['battery'],
    });
  }
}
