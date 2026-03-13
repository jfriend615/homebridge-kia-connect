import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KiaApiClient } from '../src/kia/client.js';
import type { KiaAuthManager } from '../src/kia/auth.js';

// Stub auth manager — only the methods client actually calls
function stubAuth(overrides?: Partial<KiaAuthManager>): KiaAuthManager {
  return {
    getDeviceId: () => 'TEST-DEVICE-ID',
    getAccessToken: () => 'test-sid',
    getRefreshToken: () => 'test-rmtoken',
    updateToken: vi.fn(),
    clearToken: vi.fn(),
    isTokenValid: () => true,
    getVehicleKey: () => null,
    setVehicleKey: vi.fn(),
    ...overrides,
  } as any;
}

const stubLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  log: () => {},
  prefix: 'test',
} as any;

// Access private parseVehicleStatus via prototype
function parseStatus(status: any, location?: any) {
  const client = new KiaApiClient(stubAuth(), stubLog, 'u', 'p');
  return (client as any).parseVehicleStatus(status, location);
}

describe('parseVehicleStatus', () => {
  it('parses a full status payload', () => {
    const status = {
      doorStatus: {
        frontLeft: 0, frontRight: 0,
        backLeft: 0, backRight: 0,
        hood: 0, trunk: 1,
        lockStatus: 1,
      },
      windowStatus: {
        frontLeft: 0, frontRight: 1,
        backLeft: 0, backRight: 0,
      },
      engine: { ignition: true },
      climate: { airCtrl: true, defrost: false },
      battery: { batSoc: 85 },
      fuel: { fuelLevel: 72, lowFuelLight: false, drivingRange: 350 },
      outsideTemp: '68',
      tirePressure: { tirePressureWarningLamp: false },
      odometer: { value: 12500 },
      lastStatusDate: '2025-01-15T10:00:00Z',
    };
    const location = { lat: 40.7128, lon: -74.006 };

    const state = parseStatus(status, location);

    // Doors
    expect(state.frontLeftDoorOpen).toBe(false);
    expect(state.trunkOpen).toBe(true);
    expect(state.locked).toBe(true);

    // Windows
    expect(state.frontLeftWindowOpen).toBe(false);
    expect(state.frontRightWindowOpen).toBe(true);

    // Engine/climate
    expect(state.engineRunning).toBe(true);
    expect(state.airControlOn).toBe(true);
    expect(state.defrostOn).toBe(false);

    // Sensors
    expect(state.batteryPercentage).toBe(85);
    expect(state.fuelLevel).toBe(72);
    expect(state.fuelLevelLow).toBe(false);
    expect(state.fuelDrivingRange).toBe(350);
    expect(state.outsideTemperature).toBe(68);
    expect(state.tirePressureWarning).toBe(false);
    expect(state.odometer).toBe(12500);

    // Location
    expect(state.latitude).toBe(40.7128);
    expect(state.longitude).toBe(-74.006);

    expect(state.lastUpdated).toBe('2025-01-15T10:00:00Z');
  });

  it('handles empty/missing status gracefully', () => {
    const state = parseStatus(undefined, undefined);

    expect(state.frontLeftDoorOpen).toBe(false);
    expect(state.locked).toBe(false);
    expect(state.engineRunning).toBe(false);
    expect(state.airControlOn).toBe(false);
    expect(state.outsideTemperature).toBeNull();
    expect(state.batteryPercentage).toBeNull();
    expect(state.fuelLevel).toBeNull();
    expect(state.tirePressureWarning).toBe(false);
    expect(state.odometer).toBeNull();
    expect(state.latitude).toBeNull();
    expect(state.lastUpdated).toBeNull();
  });

  it('detects tire pressure warning from individual tire flags', () => {
    const status = {
      tirePressure: {
        tirePressureWarningLamp: false,
        frontLeft: { warning: true },
        frontRight: { warning: false },
        rearLeft: { warning: false },
        rearRight: { warning: false },
      },
    };
    expect(parseStatus(status).tirePressureWarning).toBe(true);
  });

  it('uses fallback fields (doorLock, airCtrlOn, etc.)', () => {
    const status = {
      doorLock: true,
      engine: true,
      airCtrlOn: true,
      defrost: true,
      fuelLevel: 50,
      lowFuelLight: true,
      distanceToEmpty: 200,
      batteryStatus: { stateOfCharge: 90 },
      syncDate: { utc: '2025-06-01' },
    };
    const state = parseStatus(status);

    expect(state.locked).toBe(true);
    expect(state.engineRunning).toBe(true);
    expect(state.airControlOn).toBe(true);
    expect(state.defrostOn).toBe(true);
    expect(state.fuelLevel).toBe(50);
    expect(state.fuelLevelLow).toBe(true);
    expect(state.fuelDrivingRange).toBe(200);
    expect(state.batteryPercentage).toBe(90);
    expect(state.lastUpdated).toBe('2025-06-01');
  });
});

describe('parseNumber (via parseVehicleStatus)', () => {
  it('parses string numbers', () => {
    const state = parseStatus({ outsideTemp: '75' });
    expect(state.outsideTemperature).toBe(75);
  });

  it('returns null for empty string', () => {
    const state = parseStatus({ outsideTemp: '' });
    expect(state.outsideTemperature).toBeNull();
  });

  it('returns null for non-numeric string', () => {
    const state = parseStatus({ outsideTemp: 'N/A' });
    expect(state.outsideTemperature).toBeNull();
  });
});
