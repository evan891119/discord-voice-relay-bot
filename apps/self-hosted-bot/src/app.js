import { randomInt } from 'node:crypto';
import { createBridgeEngine } from '@discord-voice-relay-bot/bridge-core';
import { loadLocalConfig } from '@discord-voice-relay-bot/config-provider-local';
import { createDiscordVoiceAdapter } from '@discord-voice-relay-bot/discord-adapter';
import { createLocalStateStore } from '@discord-voice-relay-bot/state-store-local';
import { createLogger } from './logger.js';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function expiresAtIso(ttlMs = PAIRING_CODE_TTL_MS) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function generatePairingCode() {
  return String(randomInt(100_000, 1_000_000));
}

function normalizePairingCode(code) {
  return code.trim().toUpperCase();
}

function endpointsMatch(left, right) {
  return left?.guildId === right?.guildId
    && left?.voiceChannelId === right?.voiceChannelId;
}

function endpointFromCaller(endpoint, side, code) {
  return {
    ...endpoint,
    id: `dynamic:${code}:${side}`,
    name: side,
    label: endpoint.label ?? endpoint.name ?? `Side ${side}`,
  };
}

function createRuntimeBridge({ code, sourceEndpoint, targetEndpoint }) {
  const bridgeId = `dynamic-${code.toLowerCase()}`;

  return {
    id: bridgeId,
    name: bridgeId,
    enabled: true,
    endpoints: [
      endpointFromCaller(sourceEndpoint, 'A', code),
      endpointFromCaller(targetEndpoint, 'B', code),
    ],
  };
}

function createPermissionCheckBridge({ id, endpoint }) {
  return {
    id,
    name: id,
    enabled: true,
    endpoints: [endpoint],
  };
}

function bridgeMatchesEndpoint(bridge, endpoint) {
  return bridge.endpoints.some((bridgeEndpoint) => {
    if (endpoint?.voiceChannelId) {
      return bridgeEndpoint.guildId === endpoint.guildId
        && bridgeEndpoint.voiceChannelId === endpoint.voiceChannelId;
    }

    return bridgeEndpoint.guildId === endpoint?.guildId;
  });
}

function isBridgeActiveState(state) {
  return ['running', 'starting', 'recovering'].includes(state?.status);
}

function pendingCodeMatchesEndpoint(record, endpoint) {
  return endpointsMatch(record.sourceEndpoint, endpoint);
}

export function createSelfHostedBot({
  config = loadLocalConfig(),
  logger = createLogger(config.logLevel),
  discordAdapter = createDiscordVoiceAdapter({
    logger,
    selfDeaf: config.selfDeaf,
    selfMute: config.selfMute,
    token: config.token,
  }),
  stateStore = createLocalStateStore(),
} = {}) {
  const cleanupHandlers = [];
  const activeBridgeIds = new Set();
  const bridgeEngine = createBridgeEngine({
    configProvider: config.configProvider,
    disconnectEndpoint: discordAdapter.disconnectEndpoint,
    joinEndpoint: discordAdapter.joinEndpoint,
    logger,
    permissionPolicy: config.permissionPolicy,
    stateStore,
    startRecovery: discordAdapter.startConnectionRecovery,
    startTwoWayForwarding: discordAdapter.startTwoWayForwarding,
    startVoiceStateMonitor: discordAdapter.startVoiceStateMonitor,
  });
  let started = false;
  let stopped = false;

  async function findActiveBridgeForEndpoint(endpoint) {
    if (!endpoint) {
      return undefined;
    }

    for (const bridgeId of activeBridgeIds) {
      const state = await bridgeEngine.getBridgeState(bridgeId);
      if (!isBridgeActiveState(state)) {
        activeBridgeIds.delete(bridgeId);
        continue;
      }

      const bridge = await config.configProvider.getBridge(bridgeId);
      if (bridge && bridgeMatchesEndpoint(bridge, endpoint)) {
        return bridge;
      }
    }

    return undefined;
  }

  async function findPendingCodeForEndpoint(endpoint) {
    const records = await stateStore.listPairingCodes?.() ?? [];
    return records.find((record) => pendingCodeMatchesEndpoint(record, endpoint));
  }

  async function generateAvailablePairingCode() {
    const records = await stateStore.listPairingCodes?.() ?? [];
    const existingCodes = new Set(records.map((record) => record.code));

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generatePairingCode();
      if (!existingCodes.has(code)) {
        return code;
      }
    }

    throw new Error('Could not generate an unused pairing code');
  }

  async function start() {
    if (started) {
      return;
    }

    logger.info('starting voice relay for discord', {
      autoStart: config.bridgeAutoStart,
      bridgeName: config.bridgeName,
      commandGuildIds: config.commandGuildIds,
      staticBridgeEnabled: config.staticBridgeEnabled,
    });

    await discordAdapter.login();
    await discordAdapter.registerBridgeCommands({
      guildIds: config.commandGuildIds,
    });
    cleanupHandlers.push(discordAdapter.onBridgeCommand(handleBridgeCommand));

    if (config.bridgeAutoStart && config.staticBridgeEnabled) {
      await bridgeEngine.startBridge(config.bridgeName);
      activeBridgeIds.add(config.bridgeName);
    } else {
      logger.info('bridge auto-start disabled; waiting for /bridge create or /bridge join', {
        bridgeName: config.bridgeName,
      });
    }

    started = true;
  }

  async function stop(signal = 'manual') {
    if (stopped) {
      return;
    }

    stopped = true;
    logger.info('bridge stopping', { signal });
    for (const cleanup of cleanupHandlers.splice(0).reverse()) {
      cleanup.destroy();
    }
    if (started) {
      for (const bridgeId of [...activeBridgeIds].reverse()) {
        await bridgeEngine.stopBridge(bridgeId);
        activeBridgeIds.delete(bridgeId);
      }

      if (config.staticBridgeEnabled) {
        await bridgeEngine.stopBridge(config.bridgeName);
      }
    }
    discordAdapter.destroy();
    logger.info('bridge stopped', { signal });
  }

  async function handleBridgeCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'help') {
      await interaction.reply({
        content: [
          '`/bridge status` - Show the bridge connected to your current voice channel.',
          '`/bridge leave` - Make the bot leave the bridge connected to your current voice channel.',
          '`/bridge create` - Create a 10-minute pairing code from your current voice channel.',
          '`/bridge join <code>` - Join a pairing code from another server and start a dynamic bridge.',
        ].join('\n'),
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'status') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a bridged voice channel first, then run `/bridge status` again.',
          ephemeral: true,
        });
        return;
      }

      const bridge = await findActiveBridgeForEndpoint(endpoint);
      if (!bridge) {
        await interaction.reply({
          content: 'No active bridge was found for your current voice channel.',
          ephemeral: true,
        });
        return;
      }

      const state = await bridgeEngine.getBridgeState(bridge.id);
      await interaction.reply({
        content: `Bridge \`${bridge.id}\` status: \`${state?.status ?? 'unknown'}\`.`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'leave') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      const context = discordAdapter.commandContextFromInteraction(interaction, endpoint);
      const bridge = await findActiveBridgeForEndpoint(endpoint ?? {
        guildId: interaction.guildId,
      });
      if (!bridge) {
        await interaction.reply({
          content: 'No active bridge was found for this server or your current voice channel.',
          ephemeral: true,
        });
        return;
      }

      const decision = await config.permissionPolicy.can('stop_bridge', context);
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to make the bot leave this bridge.',
          ephemeral: true,
        });
        return;
      }

      const state = await bridgeEngine.stopBridge(bridge.id);
      activeBridgeIds.delete(bridge.id);
      await interaction.reply({
        content: `Bridge \`${bridge.id}\` status: \`${state.status}\`. The bot left the bridged voice channels.`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'create') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a normal voice channel first, then run this command again.',
          ephemeral: true,
        });
        return;
      }

      const context = discordAdapter.commandContextFromInteraction(interaction, endpoint);
      const activeBridge = await findActiveBridgeForEndpoint(endpoint);
      if (activeBridge) {
        await interaction.reply({
          content: `This voice channel is already connected to bridge \`${activeBridge.id}\`. Use \`/bridge status\` or \`/bridge leave\`.`,
          ephemeral: true,
        });
        return;
      }

      const pendingRecord = await findPendingCodeForEndpoint(endpoint);
      if (pendingRecord) {
        await interaction.reply({
          content: `This voice channel already has pending pairing code \`${pendingRecord.code}\` until \`${pendingRecord.expiresAt}\`.`,
          ephemeral: true,
        });
        return;
      }

      const decision = await config.permissionPolicy.can(
        'create_bridge',
        context,
        createPermissionCheckBridge({
          id: 'dynamic-create-candidate',
          endpoint,
        }),
      );
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to manage this bridge.',
          ephemeral: true,
        });
        return;
      }

      const code = await generateAvailablePairingCode();
      const record = {
        code,
        bridgeId: `dynamic-${code.toLowerCase()}`,
        createdAt: nowIso(),
        createdByUserId: interaction.user.id,
        expiresAt: expiresAtIso(),
        sourceEndpoint: endpointFromCaller(endpoint, 'A', code),
      };
      await stateStore.savePairingCode(record);
      logger.info('dynamic bridge pairing code created', {
        bridgeId: record.bridgeId,
        code,
        createdByUserId: record.createdByUserId,
        expiresAt: record.expiresAt,
        guildId: endpoint.guildId,
        voiceChannelId: endpoint.voiceChannelId,
      });

      await interaction.reply({
        content: `Pairing code created: \`${code}\`\nAsk the other server to join a voice channel and run \`/bridge join\` with code \`${code}\` within 10 minutes.`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'join') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a normal voice channel first, then run this command again.',
          ephemeral: true,
        });
        return;
      }

      const context = discordAdapter.commandContextFromInteraction(interaction, endpoint);
      const activeTargetBridge = await findActiveBridgeForEndpoint(endpoint);
      if (activeTargetBridge) {
        await interaction.reply({
          content: `This voice channel is already connected to bridge \`${activeTargetBridge.id}\`. Use \`/bridge status\` or \`/bridge leave\`.`,
          ephemeral: true,
        });
        return;
      }

      const code = normalizePairingCode(interaction.options.getString('code', true));
      const record = await stateStore.consumePairingCode(code);
      if (!record) {
        await interaction.reply({
          content: 'Invalid or expired pairing code. Ask the other server to run `/bridge create` again.',
          ephemeral: true,
        });
        return;
      }

      if (record.sourceEndpoint.guildId === endpoint.guildId) {
        await interaction.reply({
          content: 'Pairing must use a voice channel from a different Discord server.',
          ephemeral: true,
        });
        return;
      }

      if (record.sourceEndpoint.voiceChannelId === endpoint.voiceChannelId) {
        await interaction.reply({
          content: 'Pairing must use two different voice channels.',
          ephemeral: true,
        });
        return;
      }

      const activeSourceBridge = await findActiveBridgeForEndpoint(record.sourceEndpoint);
      if (activeSourceBridge) {
        await interaction.reply({
          content: `The pairing source voice channel is already connected to bridge \`${activeSourceBridge.id}\`. Ask the other server to run \`/bridge create\` again.`,
          ephemeral: true,
        });
        return;
      }

      const bridge = createRuntimeBridge({
        code,
        sourceEndpoint: record.sourceEndpoint,
        targetEndpoint: endpoint,
      });

      const decision = await config.permissionPolicy.can('join_bridge', context, bridge);
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to manage this bridge.',
          ephemeral: true,
        });
        return;
      }

      await config.configProvider.saveBridge(bridge);
      const state = await bridgeEngine.startBridge(bridge.id, context);
      activeBridgeIds.add(bridge.id);
      logger.info('dynamic bridge paired and started', {
        bridgeId: bridge.id,
        code,
        sourceGuildId: bridge.endpoints[0].guildId,
        sourceVoiceChannelId: bridge.endpoints[0].voiceChannelId,
        targetGuildId: bridge.endpoints[1].guildId,
        targetVoiceChannelId: bridge.endpoints[1].voiceChannelId,
      });

      await interaction.reply({
        content: `Bridge \`${bridge.id}\` status: \`${state.status}\`.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: 'Unknown bridge command. Use `/bridge help`.',
      ephemeral: true,
    });
  }

  return {
    start,
    stop,
  };
}
