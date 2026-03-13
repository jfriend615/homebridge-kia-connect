import { randomUUID, createHash } from 'node:crypto';

/**
 * Generate a device ID. Called once on first run, then persisted.
 */
export function generateDeviceId(): string {
  return randomUUID().toUpperCase();
}

// DNS namespace for UUID v5: 6ba7b810-9dad-11d1-80b4-00c04fd430c8
const DNS_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

/**
 * Minimal UUID v5 implementation using SHA-1.
 * Generates a deterministic UUID from a device ID string.
 */
export function generateClientUuid(deviceId: string): string {
  const hash = createHash('sha1')
    .update(DNS_NAMESPACE)
    .update(deviceId)
    .digest();

  // Set version to 5
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  // Set variant to RFC 4122
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
