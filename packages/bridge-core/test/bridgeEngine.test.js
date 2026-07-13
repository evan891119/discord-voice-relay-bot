import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createBridgeEngine } from '../src/bridgeEngine.js';

function endpoint(id, guildId = id, voiceChannelId = `${id}-voice`) {
  return {
    id,
    kind: 'discord',
    guildId,
    voiceChannelId,
  };
}

function session() {
  return {
    disconnected: false,
    receiver: {
      speaking: new EventEmitter(),
      subscribe() {
        return new EventEmitter();
      },
    },
    async disconnect() {
      this.disconnected = true;
    },
  };
}

function configProvider(bridge) {
  return {
    async getBridge(bridgeId) {
      return bridgeId === bridge.id ? bridge : undefined;
    },
    async listBridges() {
      return [bridge];
    },
  };
}

test('starts and stops an explicit fixed-size group bridge', async () => {
  const bridge = {
    id: 'group-1',
    name: 'group-1',
    mode: 'group',
    maxEndpoints: 3,
    enabled: true,
    endpoints: [
      endpoint('A'),
      endpoint('B'),
      endpoint('C'),
    ],
  };
  const joinedEndpoints = [];
  const groupStarts = [];
  const disconnectedEndpoints = [];
  const engine = createBridgeEngine({
    configProvider: configProvider(bridge),
    joinEndpoint: async (bridgeEndpoint) => {
      joinedEndpoints.push(bridgeEndpoint.id);
      return session();
    },
    startGroupForwarding: (options) => {
      groupStarts.push(options);
      return { destroy() {} };
    },
    startTwoWayForwarding: () => {
      throw new Error('two-way forwarding should not be used for group bridge');
    },
    disconnectEndpoint: async (bridgeEndpoint, bridgeSession) => {
      disconnectedEndpoints.push(bridgeEndpoint.id);
      await bridgeSession.disconnect();
    },
    logger: {},
  });

  const runningState = await engine.startBridge('group-1');

  assert.equal(runningState.status, 'running');
  assert.deepEqual(joinedEndpoints, ['A', 'B', 'C']);
  assert.equal(groupStarts.length, 1);
  assert.deepEqual(groupStarts[0].endpoints.map(({ id }) => id), ['A', 'B', 'C']);
  assert.equal(groupStarts[0].sessions.length, 3);

  const stoppedState = await engine.stopBridge('group-1');

  assert.equal(stoppedState.status, 'stopped');
  assert.deepEqual(disconnectedEndpoints, ['A', 'B', 'C']);
});

test('keeps pair bridges constrained to exactly two endpoints', async () => {
  const bridge = {
    id: 'bad-pair',
    name: 'bad-pair',
    enabled: true,
    endpoints: [
      endpoint('A'),
      endpoint('B'),
      endpoint('C'),
    ],
  };
  const engine = createBridgeEngine({
    configProvider: configProvider(bridge),
    joinEndpoint: async () => session(),
    startTwoWayForwarding: () => ({ destroy() {} }),
    logger: {},
  });

  await assert.rejects(
    () => engine.startBridge('bad-pair'),
    /must have exactly two endpoints/,
  );
});

test('rejects duplicate endpoints in a group bridge', async () => {
  const bridge = {
    id: 'duplicate-group',
    name: 'duplicate-group',
    mode: 'group',
    enabled: true,
    endpoints: [
      endpoint('A', 'guild-1', 'voice-1'),
      endpoint('B', 'guild-2', 'voice-2'),
      endpoint('C', 'guild-1', 'voice-1'),
    ],
  };
  const engine = createBridgeEngine({
    configProvider: configProvider(bridge),
    joinEndpoint: async () => session(),
    startGroupForwarding: () => ({ destroy() {} }),
    startTwoWayForwarding: () => ({ destroy() {} }),
    logger: {},
  });

  await assert.rejects(
    () => engine.startBridge('duplicate-group'),
    /contains duplicate endpoint/,
  );
});

test('rejects group bridges without group forwarding support', async () => {
  const bridge = {
    id: 'unsupported-group',
    name: 'unsupported-group',
    mode: 'group',
    enabled: true,
    endpoints: [
      endpoint('A'),
      endpoint('B'),
      endpoint('C'),
    ],
  };
  const engine = createBridgeEngine({
    configProvider: configProvider(bridge),
    joinEndpoint: async () => session(),
    startTwoWayForwarding: () => ({ destroy() {} }),
    logger: {},
  });

  await assert.rejects(
    () => engine.startBridge('unsupported-group'),
    /needs group forwarding/,
  );
});

test('rejects duplicate endpoint ids before group forwarding starts', async () => {
  const bridge = {
    id: 'duplicate-endpoint-id',
    name: 'duplicate-endpoint-id',
    mode: 'group',
    enabled: true,
    endpoints: [
      endpoint('A', 'guild-1', 'voice-1'),
      endpoint('B', 'guild-2', 'voice-2'),
      endpoint('A', 'guild-3', 'voice-3'),
    ],
  };
  const engine = createBridgeEngine({
    configProvider: configProvider(bridge),
    joinEndpoint: async () => session(),
    startGroupForwarding: () => ({ destroy() {} }),
    startTwoWayForwarding: () => ({ destroy() {} }),
    logger: {},
  });

  await assert.rejects(
    () => engine.startBridge('duplicate-endpoint-id'),
    /duplicate endpoint id/,
  );
});

test('rejects multiple Discord endpoints in one guild', async () => {
  const bridge = {
    id: 'same-guild-group',
    name: 'same-guild-group',
    mode: 'group',
    enabled: true,
    endpoints: [
      endpoint('A', 'guild-1', 'voice-1'),
      endpoint('B', 'guild-2', 'voice-2'),
      endpoint('C', 'guild-1', 'voice-3'),
    ],
  };
  const engine = createBridgeEngine({
    configProvider: configProvider(bridge),
    joinEndpoint: async () => session(),
    startGroupForwarding: () => ({ destroy() {} }),
    startTwoWayForwarding: () => ({ destroy() {} }),
    logger: {},
  });

  await assert.rejects(
    () => engine.startBridge('same-guild-group'),
    /multiple Discord endpoints in guild/,
  );
});
