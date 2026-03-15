import { describe, it, expect, vi } from 'vitest';
import { KiaConnectPlatform } from '../src/platform.js';
import { KiaAuthManager } from '../src/kia/auth.js';
import { KiaApiClient } from '../src/kia/client.js';

class MockCharacteristicHandle {
  onSet(): this {
    return this;
  }
}

class MockService {
  constructor(
    public readonly type: string,
    public readonly name: string,
    public readonly subtype?: string,
  ) {}

  setCharacteristic(): this {
    return this;
  }

  getCharacteristic(): MockCharacteristicHandle {
    return new MockCharacteristicHandle();
  }

  updateCharacteristic(): this {
    return this;
  }
}

class MockPlatformAccessory {
  public readonly services: MockService[] = [];

  constructor(
    public displayName: string,
    public readonly UUID: string,
  ) {}

  getService(type: string): MockService | undefined {
    return this.services.find((service) => service.type === type && !service.subtype);
  }

  getServiceById(type: string, subtype: string): MockService | undefined {
    return this.services.find((service) => service.type === type && service.subtype === subtype);
  }

  addService(type: string, name?: string, subtype?: string): MockService {
    const service = new MockService(type, name ?? type, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service: MockService): void {
    const index = this.services.indexOf(service);
    if (index >= 0) {
      this.services.splice(index, 1);
    }
  }
}

function makeApi() {
  const platformAccessory = vi.fn(function (this: unknown, displayName: string, UUID: string) {
    return new MockPlatformAccessory(displayName, UUID);
  });

  return {
    hap: {
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
      uuid: {
        generate: vi.fn((value: string) => `uuid-${value}`),
      },
    },
    user: {
      storagePath: () => '/tmp/kia-platform-test',
    },
    on: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    registerPlatformAccessories: vi.fn(),
    platformAccessory,
  } as any;
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeVehicle() {
  return {
    id: 'vehicle-id',
    key: 'vehicle-key',
    name: 'My Sorento',
    model: 'SORENTO',
    vin: 'VIN123',
  };
}

function makeState() {
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
  };
}

function makePlatform(configOverrides: Record<string, unknown> = {}) {
  const api = makeApi();
  const platform = new KiaConnectPlatform(makeLog(), {
    username: 'user@example.com',
    password: 'secret',
    ...configOverrides,
  } as any, api);

  (platform as any).authManager = {
    setVehicleIdentity: vi.fn(),
  };
  (platform as any).apiClient = {
    getVehicles: vi.fn().mockResolvedValue([makeVehicle()]),
    getVehicleStatus: vi.fn().mockResolvedValue(makeState()),
    lockDoors: vi.fn(),
    unlockDoors: vi.fn(),
    startClimate: vi.fn(),
    stopClimate: vi.fn(),
    waitForAction: vi.fn(),
  };

  return { api, platform };
}

function getRegisteredAccessories(api: ReturnType<typeof makeApi>): MockPlatformAccessory[] {
  return api.registerPlatformAccessories.mock.calls.flatMap((call: unknown[]) => call[2] as MockPlatformAccessory[]);
}

describe('KiaConnectPlatform', () => {
  it('reuses a valid persisted token before attempting login', async () => {
    const api = makeApi();
    const platform = new KiaConnectPlatform(makeLog(), {
      username: 'user@example.com',
      password: 'secret',
    } as any, api);

    const validTokenSpy = vi.spyOn(KiaAuthManager.prototype, 'isTokenValid').mockReturnValue(true);
    const loginSpy = vi.spyOn(KiaApiClient.prototype, 'login');
    const setupVehicleSpy = vi.spyOn(platform as any, 'setupVehicle').mockResolvedValue(undefined);

    await (platform as any).discoverDevices();

    expect(validTokenSpy).toHaveBeenCalledOnce();
    expect(setupVehicleSpy).toHaveBeenCalledOnce();
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('resumes setup after OTP when a valid token appears on disk', async () => {
    const api = makeApi();
    const platform = new KiaConnectPlatform(makeLog(), {
      username: 'user@example.com',
      password: 'secret',
    } as any, api);

    const reloadToken = vi.fn();
    const isTokenValid = vi.fn(() => true);
    const setupVehicle = vi.fn().mockResolvedValue(undefined);

    (platform as any).authManager = {
      reloadToken,
      isTokenValid,
    };
    (platform as any).otpState = {
      otpKey: 'otp-key',
      xid: 'xid',
    };
    (platform as any).setupVehicle = setupVehicle;

    await (platform as any).resumeAfterOtp();

    expect(reloadToken).toHaveBeenCalledOnce();
    expect(isTokenValid).toHaveBeenCalledOnce();
    expect(setupVehicle).toHaveBeenCalledOnce();
  });

  it('unregisters cached accessories when no vehicles are returned', async () => {
    const { api, platform } = makePlatform();
    const cachedAccessory = new MockPlatformAccessory('Cached Vehicle', 'cached-uuid');
    (platform as any).accessories.set(cachedAccessory.UUID, cachedAccessory);
    (platform as any).apiClient.getVehicles.mockResolvedValue([]);

    await (platform as any).setupVehicle();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [cachedAccessory],
    );
    expect((platform as any).accessories.size).toBe(0);
  });

  it('unregisters cached accessories when vehicleIndex is out of range', async () => {
    const { api, platform } = makePlatform({ vehicleIndex: 2 });
    const cachedAccessory = new MockPlatformAccessory('Cached Vehicle', 'cached-uuid');
    (platform as any).accessories.set(cachedAccessory.UUID, cachedAccessory);

    await (platform as any).setupVehicle();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [cachedAccessory],
    );
    expect((platform as any).accessories.size).toBe(0);
  });

  it('creates only enabled grouped accessories with the recommended defaults', async () => {
    const { api, platform } = makePlatform();

    await (platform as any).setupVehicle();

    const registeredNames = getRegisteredAccessories(api).map((accessory) => accessory.displayName);
    expect(registeredNames).toEqual([
      'My Sorento Lock',
      'My Sorento Climate',
      'My Sorento Status',
      'My Sorento Battery',
    ]);
  });

  it('removes stale cached accessories when category visibility changes', async () => {
    const { api, platform } = makePlatform({
      showBattery: false,
      showBody: false,
    });
    const staleBatteryAccessory = new MockPlatformAccessory('My Sorento Battery', 'uuid-VIN123:battery');
    const staleBodyAccessory = new MockPlatformAccessory('My Sorento Body', 'uuid-VIN123:body');
    (platform as any).accessories.set(staleBatteryAccessory.UUID, staleBatteryAccessory);
    (platform as any).accessories.set(staleBodyAccessory.UUID, staleBodyAccessory);

    await (platform as any).setupVehicle();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [staleBatteryAccessory],
    );
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [staleBodyAccessory],
    );
  });
});
