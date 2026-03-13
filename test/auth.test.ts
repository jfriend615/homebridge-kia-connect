import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KiaAuthManager } from '../src/kia/auth.js';
import type { PersistedToken } from '../src/kia/types.js';

const stubLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  log: () => {},
  success: () => {},
  prefix: 'test',
} as any;

function makeToken(overrides?: Partial<PersistedToken>): PersistedToken {
  return {
    accessToken: 'sid-123',
    refreshToken: 'rm-456',
    deviceId: 'DEVICE-ID',
    validUntil: Date.now() + 60_000,
    ...overrides,
  };
}

describe('KiaAuthManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kia-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null token when no file exists', () => {
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr.getAccessToken()).toBeNull();
    expect(mgr.getRefreshToken()).toBeNull();
    expect(mgr.isTokenValid()).toBe(false);
  });

  it('loads a valid token from disk', () => {
    const token = makeToken();
    writeFileSync(join(tmpDir, 'kia-connect-token.json'), JSON.stringify(token));

    const mgr = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr.getAccessToken()).toBe('sid-123');
    expect(mgr.getRefreshToken()).toBe('rm-456');
    expect(mgr.isTokenValid()).toBe(true);
  });

  it('detects expired tokens', () => {
    const token = makeToken({ validUntil: Date.now() - 1000 });
    writeFileSync(join(tmpDir, 'kia-connect-token.json'), JSON.stringify(token));

    const mgr = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr.isTokenValid()).toBe(false);
  });

  it('saves and reloads a token', () => {
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    mgr.updateToken('new-sid', 'new-rm', 'NEW-DEVICE');

    const mgr2 = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr2.getAccessToken()).toBe('new-sid');
    expect(mgr2.getRefreshToken()).toBe('new-rm');
    expect(mgr2.isTokenValid()).toBe(true);
  });

  it('preserves vehicleKey across updateToken', () => {
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    mgr.updateToken('sid', 'rm', 'DEV');
    mgr.setVehicleKey('VK-789');

    mgr.updateToken('sid-2', 'rm-2');
    expect(mgr.getVehicleKey()).toBe('VK-789');
  });

  it('clears token', () => {
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    mgr.updateToken('sid', 'rm', 'DEV');
    expect(mgr.isTokenValid()).toBe(true);

    mgr.clearToken();
    expect(mgr.isTokenValid()).toBe(false);
    expect(mgr.getAccessToken()).toBeNull();
  });

  it('caches device ID within a session', () => {
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    const id1 = mgr.getDeviceId();
    const id2 = mgr.getDeviceId();
    expect(id1).toBe(id2);
  });

  it('uses persisted device ID over generating new one', () => {
    const token = makeToken({ deviceId: 'PERSISTED-ID' });
    writeFileSync(join(tmpDir, 'kia-connect-token.json'), JSON.stringify(token));

    const mgr = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr.getDeviceId()).toBe('PERSISTED-ID');
  });

  it('ignores malformed token file', () => {
    writeFileSync(join(tmpDir, 'kia-connect-token.json'), '{ broken json');
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr.getAccessToken()).toBeNull();
  });

  it('ignores token file missing required fields', () => {
    writeFileSync(join(tmpDir, 'kia-connect-token.json'), JSON.stringify({ accessToken: 'x' }));
    const mgr = new KiaAuthManager(tmpDir, stubLog);
    expect(mgr.getAccessToken()).toBeNull();
  });
});
