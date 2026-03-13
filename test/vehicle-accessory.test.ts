import { describe, it, expect, vi } from 'vitest';
import { VehicleAccessory } from '../src/vehicle-accessory.js';
import type { VehicleState } from '../src/kia/types.js';

class FakeCharacteristicHandle {
  onSet(_handler: (value: unknown) => Promise<void>): this {
    return this;
  }
}

class FakeService {
  public readonly updates = new Map<string, unknown>();

  constructor(
    public readonly type: string,
    public readonly name: string,
    public readonly subtype?: string,
  ) {}

  setCharacteristic(characteristic: string, value: unknown): this {
    this.updates.set(characteristic, value);
    return this;
  }

  updateCharacteristic(characteristic: string, value: unknown): this {
    this.updates.set(characteristic, value);
    return this;
  }

  getCharacteristic(_characteristic: string): FakeCharacteristicHandle {
    return new FakeCharacteristicHandle();
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
  it('does not overwrite battery and fuel characteristics when values are unknown', () => {
    const platform = makePlatform();
    const accessory = new FakeAccessory();
    const apiClient = {} as any;

    const vehicleAccessory = new VehicleAccessory(
      platform,
      accessory as any,
      apiClient,
      'vehicle-key',
      {
        id: 'vehicle-id',
        key: 'vehicle-key',
        name: 'EV6',
        model: 'EV6',
        vin: 'VIN123',
      },
      {},
    );

    vehicleAccessory.updateState(makeState());
    vehicleAccessory.updateState(makeState({
      batteryPercentage: null,
      fuelLevel: null,
    }));

    const batteryService = accessory.getServiceById('Battery', 'battery');
    const fuelService = accessory.getServiceById('HumiditySensor', 'fuel');

    expect(batteryService?.updates.get('BatteryLevel')).toBe(80);
    expect(fuelService?.updates.get('CurrentRelativeHumidity')).toBe(55);
  });
});
