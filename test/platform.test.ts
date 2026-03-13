import { describe, it, expect, vi } from 'vitest';
import { KiaConnectPlatform } from '../src/platform.js';
import { KiaAuthManager } from '../src/kia/auth.js';
import { KiaApiClient } from '../src/kia/client.js';

function makeApi() {
  return {
    hap: {
      Service: {},
      Characteristic: {},
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
    platformAccessory: vi.fn((displayName: string, UUID: string) => ({ displayName, UUID })),
  } as any;
}

describe('KiaConnectPlatform', () => {
  it('reuses a valid persisted token before attempting login', async () => {
    const api = makeApi();
    const platform = new KiaConnectPlatform({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any, {
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
    const platform = new KiaConnectPlatform({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any, {
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
    const api = makeApi();
    const platform = new KiaConnectPlatform({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any, {
      username: 'user@example.com',
      password: 'secret',
    } as any, api);

    const cachedAccessory = { UUID: 'cached-uuid', displayName: 'Cached Vehicle' };
    (platform as any).accessories.set(cachedAccessory.UUID, cachedAccessory);
    (platform as any).apiClient = {
      getVehicles: vi.fn().mockResolvedValue([]),
    };

    await (platform as any).setupVehicle();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [cachedAccessory],
    );
    expect((platform as any).accessories.size).toBe(0);
  });

  it('unregisters cached accessories when vehicleIndex is out of range', async () => {
    const api = makeApi();
    const platform = new KiaConnectPlatform({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any, {
      username: 'user@example.com',
      password: 'secret',
      vehicleIndex: 2,
    } as any, api);

    const cachedAccessory = { UUID: 'cached-uuid', displayName: 'Cached Vehicle' };
    (platform as any).accessories.set(cachedAccessory.UUID, cachedAccessory);
    (platform as any).apiClient = {
      getVehicles: vi.fn().mockResolvedValue([{ key: 'vehicle-1', name: 'Car', model: 'EV' }]),
    };

    await (platform as any).setupVehicle();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [cachedAccessory],
    );
    expect((platform as any).accessories.size).toBe(0);
  });
});
