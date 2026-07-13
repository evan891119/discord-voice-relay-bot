import { randomInt } from 'node:crypto';
import { createBridgeEngine } from '@discord-voice-relay-bot/bridge-core';
import { loadLocalConfig } from '@discord-voice-relay-bot/config-provider-local';
import { createDiscordVoiceAdapter } from '@discord-voice-relay-bot/discord-adapter';
import { createLocalStateStore } from '@discord-voice-relay-bot/state-store-local';
import { createLogger } from './logger.js';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const EPHEMERAL_MESSAGE_FLAGS = 64;

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

function nextEndpointName(bridge) {
  return String.fromCharCode(65 + bridge.endpoints.length);
}

function createRuntimeBridge({
  code,
  sourceEndpoint,
  targetEndpoint,
  bridgeMode = 'pair',
  maxEndpoints = undefined,
}) {
  const bridgeId = `dynamic-${code.toLowerCase()}`;
  const endpoints = [
    endpointFromCaller(sourceEndpoint, 'A', code),
    endpointFromCaller(targetEndpoint, 'B', code),
  ];

  return {
    id: bridgeId,
    name: bridgeId,
    enabled: true,
    ...(bridgeMode === 'group' ? { mode: 'group', maxEndpoints } : {}),
    endpoints,
  };
}

function bridgeEndpointFromInvite(endpoint, bridge, code) {
  const side = nextEndpointName(bridge);
  return endpointFromCaller(endpoint, side, code);
}

function createPermissionCheckBridge({
  id,
  endpoint,
  bridgeMode = 'pair',
  maxEndpoints = undefined,
}) {
  return {
    id,
    name: id,
    enabled: true,
    ...(bridgeMode === 'group' ? { mode: 'group', maxEndpoints } : {}),
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

function bridgeHasEndpoint(bridge, endpoint) {
  return bridge.endpoints.some((bridgeEndpoint) => endpointsMatch(bridgeEndpoint, endpoint));
}

function bridgeWithoutEndpoint(bridge, endpoint) {
  return {
    ...bridge,
    generation: (bridge.generation ?? 1) + 1,
    endpoints: bridge.endpoints.filter((bridgeEndpoint) => !endpointsMatch(bridgeEndpoint, endpoint)),
  };
}

function bridgeHasGuild(bridge, endpoint) {
  return bridge.endpoints.some((bridgeEndpoint) => bridgeEndpoint.guildId === endpoint.guildId);
}

function isGroupBridge(bridge) {
  return bridge?.mode === 'group';
}

function isBridgeFull(bridge) {
  return bridge.maxEndpoints !== undefined && bridge.endpoints.length >= bridge.maxEndpoints;
}

function isBridgeActiveState(state) {
  return ['running', 'starting', 'recovering'].includes(state?.status);
}

function isReusableInitialGroupCode(record) {
  return record?.purpose === 'initial_join' && record.bridgeMode === 'group';
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
    onEndpointEmpty: handleBridgeEndpointEmpty,
    permissionPolicy: config.permissionPolicy,
    stateStore,
    startGroupForwarding: discordAdapter.startGroupForwarding,
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

  async function getPairingCode(code) {
    if (stateStore.getPairingCode) {
      return stateStore.getPairingCode(code);
    }

    const records = await stateStore.listPairingCodes?.() ?? [];
    return records.find((record) => record.code === code);
  }

  async function deletePairingCode(code) {
    if (stateStore.deletePairingCode) {
      await stateStore.deletePairingCode(code);
      return;
    }

    await stateStore.consumePairingCode(code);
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

  async function restartBridgeWithUpdatedDefinition(bridge, context) {
    await config.configProvider.saveBridge(bridge);

    if (activeBridgeIds.has(bridge.id)) {
      await bridgeEngine.stopBridge(bridge.id);
      activeBridgeIds.delete(bridge.id);
    }

    const state = await bridgeEngine.startBridge(bridge.id, context);
    activeBridgeIds.add(bridge.id);
    return state;
  }

  async function addEndpointToGroupBridge({ bridge, code, context, endpoint }) {
    if (isBridgeFull(bridge)) {
      return {
        reply: `Bridge \`${bridge.id}\` already has ${bridge.endpoints.length} of ${bridge.maxEndpoints} endpoints.`,
      };
    }

    if (bridgeHasGuild(bridge, endpoint)) {
      return {
        reply: 'This group bridge already has an endpoint from this Discord server.',
      };
    }

    if (bridgeHasEndpoint(bridge, endpoint)) {
      return {
        reply: 'This voice channel is already connected to this group bridge.',
      };
    }

    const nextBridge = {
      ...bridge,
      generation: (bridge.generation ?? 1) + 1,
      endpoints: [
        ...bridge.endpoints,
        bridgeEndpointFromInvite(endpoint, bridge, code),
      ],
    };
    const decision = await config.permissionPolicy.can('join_bridge', context, nextBridge);
    if (!decision.allowed) {
      return {
        reply: decision.message ?? 'You are not allowed to join this group bridge.',
      };
    }

    const nextState = await restartBridgeWithUpdatedDefinition(nextBridge, context);
    logger.info('group bridge endpoint joined', {
      bridgeId: nextBridge.id,
      code,
      endpointCount: nextBridge.endpoints.length,
      guildId: endpoint.guildId,
      maxEndpoints: nextBridge.maxEndpoints,
      voiceChannelId: endpoint.voiceChannelId,
    });

    return {
      bridge: nextBridge,
      reply: `Bridge \`${nextBridge.id}\` status: \`${nextState.status}\`. Endpoint count: ${nextBridge.endpoints.length}/${nextBridge.maxEndpoints}.`,
      state: nextState,
    };
  }

  async function removeEndpointFromGroupBridge(bridge, endpoint, context, reason) {
    const nextBridge = bridgeWithoutEndpoint(bridge, endpoint);
    if (nextBridge.endpoints.length < 2) {
      const state = await bridgeEngine.stopBridge(bridge.id, context);
      activeBridgeIds.delete(bridge.id);
      logger.info('group bridge stopped after endpoint removal', {
        bridgeId: bridge.id,
        endpointCount: nextBridge.endpoints.length,
        guildId: endpoint.guildId,
        reason,
        voiceChannelId: endpoint.voiceChannelId,
      });
      return {
        bridge: nextBridge,
        state,
        stopped: true,
      };
    }

    const state = await restartBridgeWithUpdatedDefinition(nextBridge, context);
    logger.info('group bridge endpoint removed', {
      bridgeId: nextBridge.id,
      endpointCount: nextBridge.endpoints.length,
      guildId: endpoint.guildId,
      maxEndpoints: nextBridge.maxEndpoints,
      reason,
      voiceChannelId: endpoint.voiceChannelId,
    });
    return {
      bridge: nextBridge,
      state,
      stopped: false,
    };
  }

  async function handleBridgeEndpointEmpty({ bridge, endpoint, reason }) {
    if (!isGroupBridge(bridge) || bridge.endpoints.length <= 2) {
      await bridgeEngine.stopBridge(bridge.id);
      activeBridgeIds.delete(bridge.id);
      return;
    }

    await removeEndpointFromGroupBridge(bridge, endpoint, undefined, reason);
  }

  async function start() {
    if (started) {
      return;
    }

    logger.info('starting voice relay for discord', {
      autoStart: config.bridgeAutoStart,
      bridgeName: config.bridgeName,
      commandGuildIds: config.commandGuildIds,
      groupBridgesEnabled: config.groupBridgesEnabled,
      maxGroupEndpoints: config.maxGroupEndpoints,
      staticBridgeEnabled: config.staticBridgeEnabled,
    });

    await discordAdapter.login();
    await discordAdapter.registerBridgeCommands({
      guildIds: config.commandGuildIds,
      groupBridgesEnabled: config.groupBridgesEnabled,
      maxGroupEndpoints: config.maxGroupEndpoints,
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
      const createHelp = config.groupBridgesEnabled
        ? `\`/bridge create [max_endpoints]\` - Create a 10-minute pairing code. Group codes can be reused until full or expired.`
        : '`/bridge create` - Create a 10-minute pairing code from your current voice channel.';
      await interaction.reply({
        content: [
          '`/bridge status` - Show the bridge connected to your current voice channel.',
          '`/bridge leave` - Make the bot leave the bridge connected to your current voice channel.',
          createHelp,
          ...(config.groupBridgesEnabled
            ? ['`/bridge invite` - Optional: create another 10-minute code for your active group bridge.']
            : []),
          '`/bridge join <code>` - Join a pairing code from another server and start a dynamic bridge.',
        ].join('\n'),
        flags: EPHEMERAL_MESSAGE_FLAGS,
      });
      return;
    }

    if (subcommand === 'status') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a bridged voice channel first, then run `/bridge status` again.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const bridge = await findActiveBridgeForEndpoint(endpoint);
      if (!bridge) {
        await interaction.reply({
          content: 'No active bridge was found for your current voice channel.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const state = await bridgeEngine.getBridgeState(bridge.id);
      const endpointCount = isGroupBridge(bridge)
        ? ` Endpoint count: ${bridge.endpoints.length}/${bridge.maxEndpoints}.`
        : '';
      await interaction.reply({
        content: `Bridge \`${bridge.id}\` status: \`${state?.status ?? 'unknown'}\`.${endpointCount}`,
        flags: EPHEMERAL_MESSAGE_FLAGS,
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
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const decision = await config.permissionPolicy.can('stop_bridge', context, bridge);
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to make the bot leave this bridge.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      if (isGroupBridge(bridge) && bridge.endpoints.length > 2 && endpoint) {
        const result = await removeEndpointFromGroupBridge(bridge, endpoint, context, 'command-leave');
        await interaction.reply({
          content: result.stopped
            ? `Bridge \`${bridge.id}\` status: \`${result.state.status}\`. Fewer than two endpoints remained, so the group bridge stopped.`
            : `Your endpoint left bridge \`${bridge.id}\`. Endpoint count: ${result.bridge.endpoints.length}/${result.bridge.maxEndpoints}.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const state = await bridgeEngine.stopBridge(bridge.id);
      activeBridgeIds.delete(bridge.id);
      await interaction.reply({
        content: `Bridge \`${bridge.id}\` status: \`${state.status}\`. The bot left the bridged voice channels.`,
        flags: EPHEMERAL_MESSAGE_FLAGS,
      });
      return;
    }

    if (subcommand === 'invite') {
      if (!config.groupBridgesEnabled) {
        await interaction.reply({
          content: 'Group bridges are not enabled for this self-hosted bot.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a grouped voice channel first, then run `/bridge invite` again.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const context = discordAdapter.commandContextFromInteraction(interaction, endpoint);
      const bridge = await findActiveBridgeForEndpoint(endpoint);
      if (!isGroupBridge(bridge)) {
        await interaction.reply({
          content: 'No active group bridge was found for your current voice channel.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      if (isBridgeFull(bridge)) {
        await interaction.reply({
          content: `Bridge \`${bridge.id}\` already has ${bridge.endpoints.length} of ${bridge.maxEndpoints} endpoints.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const decision = await config.permissionPolicy.can('join_bridge', context, bridge);
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to invite another endpoint to this bridge.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const code = await generateAvailablePairingCode();
      const record = {
        code,
        bridgeGeneration: bridge.generation ?? 1,
        bridgeId: bridge.id,
        bridgeMode: 'group',
        createdAt: nowIso(),
        createdInGuildId: interaction.guildId,
        createdByUserId: interaction.user.id,
        expiresAt: expiresAtIso(),
        maxEndpoints: bridge.maxEndpoints,
        maxUses: 1,
        purpose: 'additional_endpoint',
        sourceEndpoint: endpointFromCaller(endpoint, nextEndpointName(bridge), code),
        usedCount: 0,
      };
      await stateStore.savePairingCode(record);
      logger.info('group bridge invite code created', {
        bridgeId: bridge.id,
        code,
        createdByUserId: record.createdByUserId,
        endpointCount: bridge.endpoints.length,
        expiresAt: record.expiresAt,
        maxEndpoints: bridge.maxEndpoints,
      });

      await interaction.reply({
        content: `Group bridge invite code created: \`${code}\`\nAsk the next server to join a voice channel and run \`/bridge join\` with code \`${code}\` within 10 minutes.`,
        flags: EPHEMERAL_MESSAGE_FLAGS,
      });
      return;
    }

    if (subcommand === 'create') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a normal voice channel first, then run this command again.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const requestedMaxEndpoints = interaction.options.getInteger('max_endpoints', false);
      const bridgeMode = requestedMaxEndpoints === null ? 'pair' : 'group';
      if (bridgeMode === 'group' && !config.groupBridgesEnabled) {
        await interaction.reply({
          content: 'Group bridges are not enabled for this self-hosted bot.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      if (bridgeMode === 'group' && (requestedMaxEndpoints < 3 || requestedMaxEndpoints > config.maxGroupEndpoints)) {
        await interaction.reply({
          content: `This bot allows group bridges with 3 to ${config.maxGroupEndpoints} endpoints.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const context = discordAdapter.commandContextFromInteraction(interaction, endpoint);
      const activeBridge = await findActiveBridgeForEndpoint(endpoint);
      if (activeBridge) {
        await interaction.reply({
          content: `This voice channel is already connected to bridge \`${activeBridge.id}\`. Use \`/bridge status\` or \`/bridge leave\`.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const pendingRecord = await findPendingCodeForEndpoint(endpoint);
      if (pendingRecord) {
        await interaction.reply({
          content: `This voice channel already has pending pairing code \`${pendingRecord.code}\` until \`${pendingRecord.expiresAt}\`.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const decision = await config.permissionPolicy.can(
        'create_bridge',
        context,
        createPermissionCheckBridge({
          id: 'dynamic-create-candidate',
          bridgeMode,
          endpoint,
          maxEndpoints: requestedMaxEndpoints ?? undefined,
        }),
      );
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to manage this bridge.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const code = await generateAvailablePairingCode();
      const record = {
        code,
        bridgeId: `dynamic-${code.toLowerCase()}`,
        bridgeGeneration: 1,
        bridgeMode,
        createdAt: nowIso(),
        createdInGuildId: interaction.guildId,
        createdByUserId: interaction.user.id,
        expiresAt: expiresAtIso(),
        maxEndpoints: requestedMaxEndpoints ?? 2,
        purpose: 'initial_join',
        sourceEndpoint: endpointFromCaller(endpoint, 'A', code),
      };
      await stateStore.savePairingCode(record);
      logger.info('dynamic bridge pairing code created', {
        bridgeId: record.bridgeId,
        bridgeMode: record.bridgeMode,
        code,
        createdByUserId: record.createdByUserId,
        expiresAt: record.expiresAt,
        guildId: endpoint.guildId,
        maxEndpoints: record.maxEndpoints,
        voiceChannelId: endpoint.voiceChannelId,
      });

      const bridgeDescription = bridgeMode === 'group'
        ? `${requestedMaxEndpoints}-endpoint group bridge`
        : 'two-endpoint bridge';
      const joinInstruction = bridgeMode === 'group'
        ? `Ask the other servers to join voice channels and run \`/bridge join\` with this same code within 10 minutes. This code works until the bridge reaches ${requestedMaxEndpoints}/${requestedMaxEndpoints} endpoints or expires.`
        : `Ask the other server to join a voice channel and run \`/bridge join\` with code \`${code}\` within 10 minutes.`;
      await interaction.reply({
        content: `Pairing code created for a ${bridgeDescription}: \`${code}\`\n${joinInstruction}`,
        flags: EPHEMERAL_MESSAGE_FLAGS,
      });
      return;
    }

    if (subcommand === 'join') {
      const endpoint = await discordAdapter.resolveCallerVoiceEndpoint(interaction);
      if (!endpoint) {
        await interaction.reply({
          content: 'Join a normal voice channel first, then run this command again.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const context = discordAdapter.commandContextFromInteraction(interaction, endpoint);
      const activeTargetBridge = await findActiveBridgeForEndpoint(endpoint);
      if (activeTargetBridge) {
        await interaction.reply({
          content: `This voice channel is already connected to bridge \`${activeTargetBridge.id}\`. Use \`/bridge status\` or \`/bridge leave\`.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const code = normalizePairingCode(interaction.options.getString('code', true));
      const candidateRecord = await getPairingCode(code);
      const record = isReusableInitialGroupCode(candidateRecord)
        ? candidateRecord
        : await stateStore.consumePairingCode(code);
      if (!record) {
        await interaction.reply({
          content: 'Invalid or expired pairing code. Ask the other server to run `/bridge create` again.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      if (isReusableInitialGroupCode(record)) {
        if (!config.groupBridgesEnabled) {
          await interaction.reply({
            content: 'Group bridges are not enabled for this self-hosted bot.',
            flags: EPHEMERAL_MESSAGE_FLAGS,
          });
          return;
        }

        const existingBridge = await config.configProvider.getBridge(record.bridgeId);
        const existingState = existingBridge ? await bridgeEngine.getBridgeState(existingBridge.id) : undefined;
        if (existingBridge || existingState) {
          if (!isGroupBridge(existingBridge) || !isBridgeActiveState(existingState)) {
            await interaction.reply({
              content: 'This group bridge code is no longer active. Ask the group to create a new code.',
              flags: EPHEMERAL_MESSAGE_FLAGS,
            });
            return;
          }

          const result = await addEndpointToGroupBridge({
            bridge: existingBridge,
            code,
            context,
            endpoint,
          });
          await interaction.reply({
            content: result.reply,
            flags: EPHEMERAL_MESSAGE_FLAGS,
          });
          return;
        }
      }

      if (record.purpose === 'additional_endpoint') {
        if (!config.groupBridgesEnabled) {
          await interaction.reply({
            content: 'Group bridges are not enabled for this self-hosted bot.',
            flags: EPHEMERAL_MESSAGE_FLAGS,
          });
          return;
        }

        const bridge = await config.configProvider.getBridge(record.bridgeId);
        const state = bridge ? await bridgeEngine.getBridgeState(bridge.id) : undefined;
        if (!isGroupBridge(bridge) || !isBridgeActiveState(state)) {
          await interaction.reply({
            content: 'This group bridge invite is no longer active. Ask the group to create a new invite.',
            flags: EPHEMERAL_MESSAGE_FLAGS,
          });
          return;
        }

        const result = await addEndpointToGroupBridge({
          bridge,
          code,
          context,
          endpoint,
        });
        await interaction.reply({
          content: result.reply,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      if (record.sourceEndpoint.guildId === endpoint.guildId) {
        await interaction.reply({
          content: 'Pairing must use a voice channel from a different Discord server.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      if (record.sourceEndpoint.voiceChannelId === endpoint.voiceChannelId) {
        await interaction.reply({
          content: 'Pairing must use two different voice channels.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const activeSourceBridge = await findActiveBridgeForEndpoint(record.sourceEndpoint);
      if (activeSourceBridge) {
        await interaction.reply({
          content: `The pairing source voice channel is already connected to bridge \`${activeSourceBridge.id}\`. Ask the other server to run \`/bridge create\` again.`,
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      const bridge = createRuntimeBridge({
        bridgeMode: record.bridgeMode ?? 'pair',
        code,
        maxEndpoints: record.maxEndpoints,
        sourceEndpoint: record.sourceEndpoint,
        targetEndpoint: endpoint,
      });

      const decision = await config.permissionPolicy.can('join_bridge', context, bridge);
      if (!decision.allowed) {
        await interaction.reply({
          content: decision.message ?? 'You are not allowed to manage this bridge.',
          flags: EPHEMERAL_MESSAGE_FLAGS,
        });
        return;
      }

      await config.configProvider.saveBridge(bridge);
      const state = await bridgeEngine.startBridge(bridge.id, context);
      activeBridgeIds.add(bridge.id);
      if (!isReusableInitialGroupCode(record) || isBridgeFull(bridge)) {
        await deletePairingCode(code);
      }
      logger.info('dynamic bridge paired and started', {
        bridgeId: bridge.id,
        code,
        sourceGuildId: bridge.endpoints[0].guildId,
        sourceVoiceChannelId: bridge.endpoints[0].voiceChannelId,
        targetGuildId: bridge.endpoints[1].guildId,
        targetVoiceChannelId: bridge.endpoints[1].voiceChannelId,
      });

      await interaction.reply({
        content: isGroupBridge(bridge)
          ? `Bridge \`${bridge.id}\` status: \`${state.status}\`. Endpoint count: ${bridge.endpoints.length}/${bridge.maxEndpoints}.`
          : `Bridge \`${bridge.id}\` status: \`${state.status}\`.`,
        flags: EPHEMERAL_MESSAGE_FLAGS,
      });
      return;
    }

    await interaction.reply({
      content: 'Unknown bridge command. Use `/bridge help`.',
      flags: EPHEMERAL_MESSAGE_FLAGS,
    });
  }

  return {
    start,
    stop,
  };
}
