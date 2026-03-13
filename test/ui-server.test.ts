import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSavedCredentials } from '../homebridge-ui/config.js';

describe('readSavedCredentials', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('loads saved plugin credentials from the Homebridge config file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kia-ui-server-'));
    const configPath = join(tempDir, 'config.json');

    writeFileSync(configPath, JSON.stringify({
      platforms: [
        { platform: 'OtherPlugin', username: 'ignore', password: 'ignore' },
        { platform: 'KiaConnect', username: 'driver@example.com', password: 'secret' },
      ],
    }));

    expect(readSavedCredentials(configPath)).toEqual({
      username: 'driver@example.com',
      password: 'secret',
    });
  });

  it('returns undefined when the plugin config is missing or incomplete', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kia-ui-server-'));
    const configPath = join(tempDir, 'config.json');

    writeFileSync(configPath, JSON.stringify({
      platforms: [
        { platform: 'KiaConnect', username: 'driver@example.com' },
      ],
    }));

    expect(readSavedCredentials(configPath)).toBeUndefined();
    expect(readSavedCredentials(join(tempDir, 'missing.json'))).toBeUndefined();
  });
});
