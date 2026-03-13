import { describe, it, expect } from 'vitest';
import { generateDeviceId, generateClientUuid } from '../src/kia/crypto.js';

describe('generateDeviceId', () => {
  it('returns an uppercase UUID', () => {
    const id = generateDeviceId();
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  });

  it('generates unique IDs', () => {
    expect(generateDeviceId()).not.toBe(generateDeviceId());
  });
});

describe('generateClientUuid', () => {
  it('returns a valid UUID v5 format', () => {
    const uuid = generateClientUuid('TEST-DEVICE-ID');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic for the same input', () => {
    const a = generateClientUuid('SAME-ID');
    const b = generateClientUuid('SAME-ID');
    expect(a).toBe(b);
  });

  it('produces different UUIDs for different inputs', () => {
    expect(generateClientUuid('ID-A')).not.toBe(generateClientUuid('ID-B'));
  });
});
