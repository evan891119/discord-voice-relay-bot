import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMemoryStateStore } from '@discord-voice-relay-bot/bridge-core';
import { createLocalConfigProvider } from '@discord-voice-relay-bot/config-provider-local';
import { createSelfHostedBot } from '../src/app.js';

function endpoint(guildId, voiceChannelId) {
  return {
    id: `${guildId}:${voiceChannelId}`,
    kind: 'discord',
    guildId,
    label: voiceChannelId,
    name: voiceChannelId,
    voiceChannelId,
  };
}

function session() {
  return {
    receiver: {
      speaking: new EventEmitter(),
      subscribe() {
        return new EventEmitter();
      },
    },
    async disconnect() {},
  };
}

function createDiscordAdapterMock() {
  let bridgeCommandHandler;

  return {
    async login() {},
    async registerBridgeCommands() {},
    onBridgeCommand(handler) {
      bridgeCommandHandler = handler;
      return { destroy() {} };
    },
    async resolveCallerVoiceEndpoint(interaction) {
      return interaction.endpoint;
    },
    commandContextFromInteraction(interaction, resolvedEndpoint) {
      const currentEndpoint = resolvedEndpoint ?? interaction.endpoint;
      return {
        subject: {
          guildId: interaction.guildId,
          roleIds: [],
          userId: interaction.user.id,
        },
        voiceChannelId: currentEndpoint?.voiceChannelId,
      };
    },
    async joinEndpoint() {
      return session();
    },
    startGroupForwarding() {
      return { destroy() {} };
    },
    startTwoWayForwarding() {
      return { destroy() {} };
    },
    startConnectionRecovery() {
      return { destroy() {} };
    },
    startVoiceStateMonitor() {
      return { destroy() {} };
    },
    async disconnectEndpoint(_endpoint, bridgeSession) {
      await bridgeSession.disconnect();
    },
    destroy() {},
    async runBridgeCommand(interaction) {
      assert.equal(typeof bridgeCommandHandler, 'function');
      await bridgeCommandHandler(interaction);
    },
  };
}

function createConfig({ groupBridgesEnabled = true } = {}) {
  return {
    bridgeAutoStart: false,
    bridgeName: 'default',
    commandGuildIds: [],
    configProvider: createLocalConfigProvider(),
    groupBridgesEnabled,
    logLevel: 'error',
    maxGroupEndpoints: 3,
    permissionPolicy: {
      async can() {
        return { allowed: true };
      },
    },
    selfDeaf: false,
    selfMute: false,
    staticBridgeEnabled: false,
  };
}

function createLoggerMock() {
  return {
    debug() {},
    error() {},
    info() {},
    warn() {},
  };
}

function interaction({ endpoint: currentEndpoint, subcommand, options = {}, userId = 'user-1' }) {
  const replies = [];

  return {
    endpoint: currentEndpoint,
    guildId: currentEndpoint.guildId,
    member: {
      roles: {
        cache: new Map(),
      },
    },
    options: {
      getInteger(name) {
        return options[name] ?? null;
      },
      getString(name) {
        return options[name];
      },
      getSubcommand() {
        return subcommand;
      },
    },
    replies,
    user: {
      id: userId,
    },
    async reply(response) {
      replies.push(response);
      return response;
    },
  };
}

function pairingCodeFromReply(reply) {
  return reply.content.match(/`(\d{6})`/)?.[1];
}

async function createStartedBot({ groupBridgesEnabled = true } = {}) {
  const discordAdapter = createDiscordAdapterMock();
  const stateStore = createMemoryStateStore();
  const bot = createSelfHostedBot({
    config: createConfig({ groupBridgesEnabled }),
    discordAdapter,
    logger: createLoggerMock(),
    stateStore,
  });

  await bot.start();
  return { bot, discordAdapter, stateStore };
}

test('pair bridge initial code is still one-time', async () => {
  const { bot, discordAdapter, stateStore } = await createStartedBot({ groupBridgesEnabled: false });
  try {
    const createInteraction = interaction({
      endpoint: endpoint('guild-a', 'voice-a'),
      subcommand: 'create',
    });
    await discordAdapter.runBridgeCommand(createInteraction);
    const code = pairingCodeFromReply(createInteraction.replies[0]);

    const joinInteraction = interaction({
      endpoint: endpoint('guild-b', 'voice-b'),
      options: { code },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(joinInteraction);

    assert.equal(await stateStore.getPairingCode(code), undefined);
    assert.match(joinInteraction.replies[0].content, /status: `running`/);
  } finally {
    await bot.stop();
  }
});

test('group initial code can fill a three-endpoint bridge', async () => {
  const { bot, discordAdapter, stateStore } = await createStartedBot();
  try {
    const createInteraction = interaction({
      endpoint: endpoint('guild-a', 'voice-a'),
      options: { max_endpoints: 3 },
      subcommand: 'create',
    });
    await discordAdapter.runBridgeCommand(createInteraction);
    const code = pairingCodeFromReply(createInteraction.replies[0]);

    const firstJoin = interaction({
      endpoint: endpoint('guild-b', 'voice-b'),
      options: { code },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(firstJoin);

    assert.match(firstJoin.replies[0].content, /Endpoint count: 2\/3/);
    assert.equal((await stateStore.getPairingCode(code))?.code, code);

    const secondJoin = interaction({
      endpoint: endpoint('guild-c', 'voice-c'),
      options: { code },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(secondJoin);

    assert.match(secondJoin.replies[0].content, /Endpoint count: 3\/3/);

    const fullJoin = interaction({
      endpoint: endpoint('guild-d', 'voice-d'),
      options: { code },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(fullJoin);

    assert.match(fullJoin.replies[0].content, /already has 3 of 3 endpoints/);
  } finally {
    await bot.stop();
  }
});

test('group initial code rejects duplicate guild joins', async () => {
  const { bot, discordAdapter } = await createStartedBot();
  try {
    const createInteraction = interaction({
      endpoint: endpoint('guild-a', 'voice-a'),
      options: { max_endpoints: 3 },
      subcommand: 'create',
    });
    await discordAdapter.runBridgeCommand(createInteraction);
    const code = pairingCodeFromReply(createInteraction.replies[0]);

    const firstJoin = interaction({
      endpoint: endpoint('guild-b', 'voice-b'),
      options: { code },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(firstJoin);

    const duplicateGuildJoin = interaction({
      endpoint: endpoint('guild-b', 'voice-other'),
      options: { code },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(duplicateGuildJoin);

    assert.match(duplicateGuildJoin.replies[0].content, /already has an endpoint from this Discord server/);
  } finally {
    await bot.stop();
  }
});

test('expired group initial code cannot be joined', async () => {
  const { bot, discordAdapter, stateStore } = await createStartedBot();
  try {
    await stateStore.savePairingCode({
      bridgeId: 'dynamic-123456',
      bridgeMode: 'group',
      code: '123456',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      createdByUserId: 'user-1',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      maxEndpoints: 3,
      purpose: 'initial_join',
      sourceEndpoint: endpoint('guild-a', 'voice-a'),
    });

    const joinInteraction = interaction({
      endpoint: endpoint('guild-b', 'voice-b'),
      options: { code: '123456' },
      subcommand: 'join',
    });
    await discordAdapter.runBridgeCommand(joinInteraction);

    assert.match(joinInteraction.replies[0].content, /Invalid or expired pairing code/);
  } finally {
    await bot.stop();
  }
});
