import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createLocalStateStore } from '../src/index.js';

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-voice-state-'));
  return createLocalStateStore({
    stateFile: join(dir, 'state.json'),
  });
}

function record(overrides = {}) {
  return {
    bridgeId: 'dynamic-123456',
    code: '123456',
    createdAt: new Date().toISOString(),
    createdByUserId: 'user-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEndpoint: {
      guildId: 'guild-a',
      id: 'dynamic:123456:A',
      kind: 'discord',
      voiceChannelId: 'voice-a',
    },
    ...overrides,
  };
}

test('getPairingCode reads an unexpired code without consuming it', async () => {
  const store = await createStore();
  await store.savePairingCode(record());

  assert.equal((await store.getPairingCode('123456')).code, '123456');
  assert.equal((await store.getPairingCode('123456')).code, '123456');
});

test('consumePairingCode remains one-time', async () => {
  const store = await createStore();
  await store.savePairingCode(record());

  assert.equal((await store.consumePairingCode('123456')).code, '123456');
  assert.equal(await store.consumePairingCode('123456'), undefined);
});

test('expired pairing codes cannot be read or consumed', async () => {
  const store = await createStore();
  await store.savePairingCode(record({
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }));

  assert.equal(await store.getPairingCode('123456'), undefined);
  assert.equal(await store.consumePairingCode('123456'), undefined);
});
