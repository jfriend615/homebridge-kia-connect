import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(
  readFileSync(new URL('../config.schema.json', import.meta.url), 'utf-8'),
) as {
  schema: {
    properties: Record<string, {
      default?: unknown;
    }>;
  };
};

describe('config.schema.json', () => {
  it('includes category visibility fields with the documented defaults', () => {
    const properties = schema.schema.properties;

    expect(properties.showLock.default).toBe(true);
    expect(properties.showClimate.default).toBe(true);
    expect(properties.showStatus.default).toBe(true);
    expect(properties.showBody.default).toBe(false);
    expect(properties.showBattery.default).toBe(true);
  });

  it('does not include accessoryLayout', () => {
    const properties = schema.schema.properties;
    expect(properties).not.toHaveProperty('accessoryLayout');
  });
});
