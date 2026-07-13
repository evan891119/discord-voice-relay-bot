import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLocalConfig } from '../src/index.js';

function load(env) {
  return loadLocalConfig({
    env: {
      DISCORD_TOKEN: 'test-token',
      ...env,
    },
    envFile: new URL('./missing.env', import.meta.url),
  });
}

test('group bridges are disabled by default with a bounded endpoint default', () => {
  const config = load();

  assert.equal(config.groupBridgesEnabled, false);
  assert.equal(config.maxGroupEndpoints, 3);
});

test('group bridge enablement and endpoint limit can be configured', () => {
  const config = load({
    ENABLE_GROUP_BRIDGES: 'true',
    MAX_GROUP_ENDPOINTS: '4',
  });

  assert.equal(config.groupBridgesEnabled, true);
  assert.equal(config.maxGroupEndpoints, 4);
});

test('group endpoint limit rejects values below three', () => {
  assert.throws(
    () => load({ MAX_GROUP_ENDPOINTS: '2' }),
    /MAX_GROUP_ENDPOINTS must be at least 3/,
  );
});

test('group endpoint limit rejects values above the first supported limit', () => {
  assert.throws(
    () => load({ MAX_GROUP_ENDPOINTS: '5' }),
    /MAX_GROUP_ENDPOINTS must be at most 4/,
  );
});
