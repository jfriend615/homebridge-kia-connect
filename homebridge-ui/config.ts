import { readFileSync } from 'node:fs';

export type SavedCredentials = { username: string; password: string };

export function hasSavedCredentials(savedCredentials?: SavedCredentials): boolean {
  return typeof savedCredentials?.username === 'string'
    && savedCredentials.username.trim() !== ''
    && typeof savedCredentials.password === 'string'
    && savedCredentials.password !== '';
}

export function readSavedCredentials(homebridgeConfigPath?: string): SavedCredentials | undefined {
  if (!homebridgeConfigPath) {
    return undefined;
  }

  try {
    const config = JSON.parse(readFileSync(homebridgeConfigPath, 'utf-8')) as {
      platforms?: Array<Record<string, unknown>>;
    };

    const pluginConfig = config.platforms?.find(platform => (
      platform.platform === 'KiaConnect'
      && typeof platform.username === 'string'
      && typeof platform.password === 'string'
    ));

    if (!pluginConfig) {
      return undefined;
    }

    return {
      username: pluginConfig.username as string,
      password: pluginConfig.password as string,
    };
  } catch {
    return undefined;
  }
}
