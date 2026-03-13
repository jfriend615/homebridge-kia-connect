import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
  WithUUID,
} from 'homebridge';
import type { KiaConnectPlatform } from './platform.js';
import type { KiaApiClient } from './kia/client.js';
import type { KiaConnectConfig, VehicleSummary, VehicleState } from './kia/types.js';

type CommandKey = 'lock' | 'climate';
type ServiceKey = CommandKey | 'battery' | 'fuel' | 'temperature' | 'engine'
  | 'door-fl' | 'door-fr' | 'door-rl' | 'door-rr' | 'hood' | 'trunk'
  | 'window-fl' | 'window-fr' | 'window-rl' | 'window-rr' | 'tire';

const CONTACT_SENSOR_MAP: readonly [ServiceKey, keyof VehicleState][] = [
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

export class VehicleAccessory {
  private readonly services = new Map<ServiceKey, Service>();
  private currentState: VehicleState | null = null;
  private commandsInFlight = new Set<CommandKey>();

  constructor(
    private readonly platform: KiaConnectPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly apiClient: KiaApiClient,
    private readonly vehicleKey: string,
    private readonly vehicle: VehicleSummary,
    private readonly config: KiaConnectConfig,
  ) {
    this.setupServices();
  }

  private setupServices(): void {
    const { Service, Characteristic } = this.platform;

    // 1. AccessoryInformation
    const infoService = this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Kia')
      .setCharacteristic(Characteristic.Model, this.vehicle.model)
      .setCharacteristic(Characteristic.SerialNumber, this.vehicle.vin);

    // 2. Door Lock
    if (this.config.enableDoorLock !== false) {
      const lockService = this.getOrAddService(Service.LockMechanism, 'Door Lock', 'lock');
      lockService.getCharacteristic(Characteristic.LockTargetState)
        .onSet(this.handleLockSet.bind(this));
      this.services.set('lock', lockService);
    } else {
      this.removeServiceBySubtype(Service.LockMechanism, 'lock');
    }

    // 3. Climate Switch
    if (this.config.enableClimateControl !== false) {
      const climateService = this.getOrAddService(Service.Switch, 'Climate', 'climate');
      climateService.getCharacteristic(Characteristic.On)
        .onSet(this.handleClimateSet.bind(this));
      this.services.set('climate', climateService);
    } else {
      this.removeServiceBySubtype(Service.Switch, 'climate');
    }

    // 4. 12V Battery
    const batteryService = this.getOrAddService(Service.Battery, '12V Battery', 'battery');
    this.services.set('battery', batteryService);

    // 5. Fuel Level (as HumiditySensor)
    const fuelService = this.getOrAddService(Service.HumiditySensor, 'Fuel Level', 'fuel');
    this.services.set('fuel', fuelService);

    // 6. Outside Temperature
    const tempService = this.getOrAddService(Service.TemperatureSensor, 'Outside Temperature', 'temperature');
    this.services.set('temperature', tempService);

    // 7. Engine Running (OccupancySensor)
    const engineService = this.getOrAddService(Service.OccupancySensor, 'Engine Running', 'engine');
    this.services.set('engine', engineService);

    // 8-13. Door ContactSensors
    const doorSensors: [string, ServiceKey][] = [
      ['Front Left Door', 'door-fl'],
      ['Front Right Door', 'door-fr'],
      ['Rear Left Door', 'door-rl'],
      ['Rear Right Door', 'door-rr'],
      ['Hood', 'hood'],
      ['Trunk', 'trunk'],
    ];
    for (const [name, subtype] of doorSensors) {
      this.services.set(subtype, this.getOrAddService(Service.ContactSensor, name, subtype));
    }

    // 14-17. Window ContactSensors
    const windowSensors: [string, ServiceKey][] = [
      ['Front Left Window', 'window-fl'],
      ['Front Right Window', 'window-fr'],
      ['Rear Left Window', 'window-rl'],
      ['Rear Right Window', 'window-rr'],
    ];
    for (const [name, subtype] of windowSensors) {
      this.services.set(subtype, this.getOrAddService(Service.ContactSensor, name, subtype));
    }

    // 18. Tire Pressure (LeakSensor)
    const tireService = this.getOrAddService(Service.LeakSensor, 'Tire Pressure', 'tire');
    this.services.set('tire', tireService);
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

    // Lock
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

    // Climate
    const climateService = this.services.get('climate');
    if (climateService) {
      climateService.updateCharacteristic(
        Characteristic.On,
        state.airControlOn,
      );
    }

    // Battery
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

    // Fuel Level
    const fuelService = this.services.get('fuel');
    if (fuelService) {
      if (state.fuelLevel !== null) {
        fuelService.updateCharacteristic(
          Characteristic.CurrentRelativeHumidity,
          state.fuelLevel,
        );
      }
    }

    // Temperature (convert F to C)
    const tempService = this.services.get('temperature');
    if (tempService && state.outsideTemperature !== null) {
      const celsius = (state.outsideTemperature - 32) * 5 / 9;
      tempService.updateCharacteristic(Characteristic.CurrentTemperature, celsius);
    }

    // Engine
    const engineService = this.services.get('engine');
    if (engineService) {
      engineService.updateCharacteristic(
        Characteristic.OccupancyDetected,
        state.engineRunning
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
    }

    // Door & window sensors (ContactSensor: DETECTED = closed, NOT_DETECTED = open)
    for (const [subtype, stateKey] of CONTACT_SENSOR_MAP) {
      this.updateContactSensor(subtype, state[stateKey] as boolean);
    }

    // Tire pressure
    const tireService = this.services.get('tire');
    if (tireService) {
      tireService.updateCharacteristic(
        Characteristic.LeakDetected,
        state.tirePressureWarning
          ? Characteristic.LeakDetected.LEAK_DETECTED
          : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
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

  // --- Command handlers ---

  private async handleLockSet(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;

    if (this.commandsInFlight.has('lock')) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const shouldLock = value === Characteristic.LockTargetState.SECURED;

    this.platform.log.info(`${shouldLock ? 'Locking' : 'Unlocking'} doors...`);
    this.commandsInFlight.add('lock');

    try {
      const actionId = shouldLock
        ? await this.apiClient.lockDoors(this.vehicleKey)
        : await this.apiClient.unlockDoors(this.vehicleKey);

      if (actionId) {
        const success = await this.apiClient.waitForAction(this.vehicleKey, actionId);
        if (!success) {
          throw new Error('Door lock/unlock command did not complete successfully');
        }
      }

      // Refresh state
      const state = await this.apiClient.getVehicleStatus(this.vehicleKey);
      this.commandsInFlight.delete('lock');
      this.updateState(state);
    } catch (e) {
      this.platform.log.error('Door lock/unlock failed:', e);
      this.commandsInFlight.delete('lock');

      // Revert target state to current
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
    }
  }

  private async handleClimateSet(value: CharacteristicValue): Promise<void> {
    if (this.commandsInFlight.has('climate')) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const shouldStart = value === true;

    this.platform.log.info(`${shouldStart ? 'Starting' : 'Stopping'} climate control...`);
    this.commandsInFlight.add('climate');

    try {
      const actionId = shouldStart
        ? await this.apiClient.startClimate(this.vehicleKey, { temperature: 72 })
        : await this.apiClient.stopClimate(this.vehicleKey);

      if (actionId) {
        const success = await this.apiClient.waitForAction(this.vehicleKey, actionId);
        if (!success) {
          throw new Error('Climate command did not complete successfully');
        }
      }

      // Refresh state
      const state = await this.apiClient.getVehicleStatus(this.vehicleKey);
      this.commandsInFlight.delete('climate');
      this.updateState(state);
    } catch (e) {
      this.platform.log.error('Climate control failed:', e);
      this.commandsInFlight.delete('climate');

      // Revert to previous state
      const climateService = this.services.get('climate');
      if (climateService && this.currentState) {
        climateService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.currentState.airControlOn,
        );
      }

      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
