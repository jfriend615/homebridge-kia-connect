import { describe, it, expect, vi } from 'vitest';
import {
  BatteryAccessory,
  BodyAccessory,
  ClimateAccessory,
  LockAccessory,
  StatusAccessory,
} from '../src/vehicle-accessory.js';
import type { VehicleState } from '../src/kia/types.js';

class FakeCharacteristicHandle {
  public handler?: (value: unknown) => Promise<void>;

  onSet(handler: (value: unknown) => Promise<void>): this {
    this.handler = handler;
    return this;
  }
}

class FakeService {
  public readonly updates = new Map<string, unknown>();
  public readonly characteristicHandles = new Map<unknown, FakeCharacteristicHandle>();

  constructor(
    public readonly type: string,
    public name: string,
    public readonly subtype?: string,
  ) {}

  setCharacteristic(characteristic: string, value: unknown): this {
    this.updates.set(characteristic, value);
    if (characteristic === 'Name' && typeof value === 'string') {
      this.name = value;
    }
    return this;
  }

  updateCharacteristic(characteristic: string, value: unknown): this {
    this.updates.set(characteristic, value);
    return this;
  }

  getCharacteristic(characteristic: unknown): FakeCharacteristicHandle {
    const existing = this.characteristicHandles.get(characteristic);
    if (existing) {
      return existing;
    }

    const handle = new FakeCharacteristicHandle();
    this.characteristicHandles.set(characteristic, handle);
    return handle;
  }
}

class FakeAccessory {
  public readonly services: FakeService[] = [];

  getService(type: string): FakeService | undefined {
    return this.services.find((service) => service.type === type && !service.subtype);
  }

  getServiceById(type: string, subtype: string): FakeService | undefined {
    return this.services.find((service) => service.type === type && service.subtype === subtype);
  }

  addService(type: string, name?: string, subtype?: string): FakeService {
    const service = new FakeService(type, name ?? type, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service: FakeService): void {
    const index = this.services.indexOf(service);
    if (index >= 0) {
      this.services.splice(index, 1);
    }
  }
}

function makePlatform() {
  return {
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      LockMechanism: 'LockMechanism',
      Switch: 'Switch',
      Battery: 'Battery',
      HumiditySensor: 'HumiditySensor',
      TemperatureSensor: 'TemperatureSensor',
      OccupancySensor: 'OccupancySensor',
      ContactSensor: 'ContactSensor',
      LeakSensor: 'LeakSensor',
    },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      Name: 'Name',
      LockTargetState: { SECURED: 1, UNSECURED: 0 },
      LockCurrentState: { SECURED: 1, UNSECURED: 0 },
      On: 'On',
      BatteryLevel: 'BatteryLevel',
      StatusLowBattery: {
        BATTERY_LEVEL_LOW: 1,
        BATTERY_LEVEL_NORMAL: 0,
      },
      ChargingState: {
        NOT_CHARGING: 0,
      },
      CurrentRelativeHumidity: 'CurrentRelativeHumidity',
      CurrentTemperature: 'CurrentTemperature',
      OccupancyDetected: {
        OCCUPANCY_DETECTED: 1,
        OCCUPANCY_NOT_DETECTED: 0,
      },
      ContactSensorState: {
        CONTACT_DETECTED: 0,
        CONTACT_NOT_DETECTED: 1,
      },
      LeakDetected: {
        LEAK_DETECTED: 1,
        LEAK_NOT_DETECTED: 0,
      },
    },
    config: {},
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    api: {
      hap: {
        HAPStatus: {
          RESOURCE_BUSY: -70403,
          SERVICE_COMMUNICATION_FAILURE: -70402,
        },
        HapStatusError: class extends Error {},
      },
    },
  } as any;
}

function makeState(overrides: Partial<VehicleState> = {}): VehicleState {
  return {
    frontLeftDoorOpen: false,
    frontRightDoorOpen: false,
    rearLeftDoorOpen: false,
    rearRightDoorOpen: false,
    hoodOpen: false,
    trunkOpen: false,
    locked: true,
    engineRunning: false,
    airControlOn: false,
    defrostOn: false,
    outsideTemperature: 68,
    batteryPercentage: 80,
    fuelLevel: 55,
    fuelLevelLow: false,
    fuelDrivingRange: 220,
    frontLeftWindowOpen: false,
    frontRightWindowOpen: false,
    rearLeftWindowOpen: false,
    rearRightWindowOpen: false,
    tirePressureWarning: false,
    odometer: 10000,
    latitude: null,
    longitude: null,
    lastUpdated: null,
    ...overrides,
  };
}

describe('VehicleAccessory', () => {
  const vehicle = {
    id: 'vehicle-id',
    key: 'vehicle-key',
    name: 'EV6',
    model: 'EV6',
    vin: 'VIN123',
  };

  function makeApiClient() {
    return {
      lockDoors: vi.fn().mockResolvedValue(undefined),
      unlockDoors: vi.fn().mockResolvedValue(undefined),
      startClimate: vi.fn().mockResolvedValue(undefined),
      stopClimate: vi.fn().mockResolvedValue(undefined),
      waitForAction: vi.fn().mockResolvedValue(true),
      getVehicleStatus: vi.fn().mockResolvedValue(makeState()),
    };
  }

  it('grouped accessory classes expose only their intended services', () => {
    const platform = makePlatform();

    const lockAccessory = new FakeAccessory();
    new LockAccessory(platform, lockAccessory as any, makeApiClient() as any, 'vehicle-key', vehicle);
    expect(lockAccessory.getServiceById('LockMechanism', 'lock')).toBeDefined();
    expect(lockAccessory.getServiceById('Switch', 'climate')).toBeUndefined();
    expect(lockAccessory.getServiceById('Battery', 'battery')).toBeUndefined();

    const climateAccessory = new FakeAccessory();
    new ClimateAccessory(platform, climateAccessory as any, makeApiClient() as any, 'vehicle-key', vehicle);
    expect(climateAccessory.getServiceById('Switch', 'climate')).toBeDefined();
    expect(climateAccessory.getServiceById('LockMechanism', 'lock')).toBeUndefined();

    const statusAccessory = new FakeAccessory();
    new StatusAccessory(platform, statusAccessory as any, vehicle);
    expect(statusAccessory.getServiceById('HumiditySensor', 'fuel')).toBeDefined();
    expect(statusAccessory.getServiceById('LeakSensor', 'tire')).toBeDefined();
    expect(statusAccessory.getServiceById('ContactSensor', 'door-fl')).toBeUndefined();

    const bodyAccessory = new FakeAccessory();
    new BodyAccessory(platform, bodyAccessory as any, vehicle);
    expect(bodyAccessory.getServiceById('ContactSensor', 'door-fl')).toBeDefined();
    expect(bodyAccessory.getServiceById('HumiditySensor', 'fuel')).toBeUndefined();
  });

  it('keeps the battery only on the dedicated grouped battery accessory', () => {
    const platform = makePlatform();
    const statusAccessory = new FakeAccessory();
    const batteryAccessory = new FakeAccessory();

    new StatusAccessory(platform, statusAccessory as any, vehicle);
    new BatteryAccessory(platform, batteryAccessory as any, vehicle);

    expect(statusAccessory.getServiceById('Battery', 'battery')).toBeUndefined();
    expect(batteryAccessory.getServiceById('Battery', 'battery')?.name).toBe('12V Battery');
  });

  it('does not overwrite fuel characteristics when values are unknown', () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory();

    const statusInstance = new StatusAccessory(
      platform,
      accessory as any,
      vehicle,
    );

    statusInstance.updateState(makeState());
    statusInstance.updateState(makeState({
      fuelLevel: null,
    }));

    const fuelService = accessory.getServiceById('HumiditySensor', 'fuel');
    expect(fuelService?.updates.get('CurrentRelativeHumidity')).toBe(55);
  });

  it('exposes low fuel and tire warnings as leak sensors', () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory();

    const statusInstance = new StatusAccessory(
      platform,
      accessory as any,
      vehicle,
    );

    statusInstance.updateState(makeState({
      fuelLevelLow: true,
      tirePressureWarning: true,
    }));

    const lowFuelService = accessory.getServiceById('LeakSensor', 'fuel-low');
    const tireService = accessory.getServiceById('LeakSensor', 'tire');

    expect(lowFuelService?.name).toBe('Low Fuel Warning');
    expect(lowFuelService?.updates.get(platform.Characteristic.LeakDetected)).toBe(1);
    expect(tireService?.name).toBe('Tire Pressure Warning');
    expect(tireService?.updates.get(platform.Characteristic.LeakDetected)).toBe(1);
  });

  it('routes lock and climate commands through the shared handlers', async () => {
    const platform = makePlatform();

    const groupedApiClient = makeApiClient();
    const lockHost = new FakeAccessory();
    const climateHost = new FakeAccessory();
    new LockAccessory(platform, lockHost as any, groupedApiClient as any, 'vehicle-key', vehicle);
    new ClimateAccessory(platform, climateHost as any, groupedApiClient as any, 'vehicle-key', vehicle);
    await lockHost.getServiceById('LockMechanism', 'lock')
      ?.getCharacteristic(platform.Characteristic.LockTargetState).handler?.(1);
    await climateHost.getServiceById('Switch', 'climate')
      ?.getCharacteristic(platform.Characteristic.On).handler?.(true);

    expect(groupedApiClient.lockDoors).toHaveBeenCalledWith('vehicle-key');
    expect(groupedApiClient.startClimate).toHaveBeenCalledWith('vehicle-key', expect.objectContaining({ temperature: expect.any(Number) }));
  });
});
