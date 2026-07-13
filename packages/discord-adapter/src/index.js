import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { MIXER_LIMITS, createMixSession } from './audioMixer.js';

const REQUIRED_VOICE_PERMISSIONS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.Connect,
  PermissionsBitField.Flags.Speak,
];
const RECOVERABLE_DISCONNECT_REASONS = new Set([
  VoiceConnectionDisconnectReason.AdapterUnavailable,
  VoiceConnectionDisconnectReason.EndpointRemoved,
  VoiceConnectionDisconnectReason.WebSocketClose,
]);
function buildBridgeCommands({
  groupBridgesEnabled = false,
  maxGroupEndpoints = 3,
} = {}) {
  let bridgeCommand = new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Control the Discord voice relay.')
    .addSubcommand((subcommand) => subcommand
      .setName('leave')
      .setDescription('Make the bot leave the bridge connected to your current voice channel.'))
    .addSubcommand((subcommand) => subcommand
      .setName('status')
      .setDescription('Show bridge status.'))
    .addSubcommand((subcommand) => subcommand
      .setName('help')
      .setDescription('Show bridge command help.'));

  if (groupBridgesEnabled) {
    bridgeCommand = bridgeCommand.addSubcommand((subcommand) => subcommand
      .setName('invite')
      .setDescription('Create another short-lived code for an active group bridge.'));
  }

  bridgeCommand = bridgeCommand
    .addSubcommand((subcommand) => {
      const createCommand = subcommand
        .setName('create')
        .setDescription('Create a pending bridge from your current voice channel.');

      if (groupBridgesEnabled) {
        return createCommand.addIntegerOption((option) => option
        .setName('max_endpoints')
        .setDescription('Create an opt-in group bridge with this endpoint limit.')
        .setMinValue(3)
        .setMaxValue(maxGroupEndpoints)
        .setRequired(false));
      }

      return createCommand;
    })
    .addSubcommand((subcommand) => subcommand
      .setName('join')
      .setDescription('Join a pending bridge with a pairing code.')
      .addStringOption((option) => option
        .setName('code')
        .setDescription('Pairing code from the other server.')
        .setRequired(true)));

  return [bridgeCommand].map((command) => command.toJSON());
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function endpointName(endpoint) {
  return endpoint.name ?? endpoint.label ?? endpoint.id;
}

function describeDisconnectState(state) {
  return {
    status: state.status,
    reason: state.reason,
    closeCode: state.closeCode,
  };
}

export function createDiscordVoiceAdapter({
  logger = console,
  selfDeaf = false,
  selfMute = false,
  token,
}) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.on('error', (error) => {
    logger.error('discord client error', {
      code: error?.code,
      error: error?.message,
    });
  });

  function normalizeInteractionResponseOptions(options) {
    if (!options || typeof options !== 'object') {
      return options;
    }

    if (!options.ephemeral) {
      return options;
    }

    const { ephemeral: _ephemeral, flags, ...rest } = options;
    return {
      ...rest,
      flags: flags === undefined ? MessageFlags.Ephemeral : flags,
    };
  }

  async function resolveVoiceChannel(endpoint) {
    const guild = await client.guilds.fetch(endpoint.guildId);
    const channel = await guild.channels.fetch(endpoint.voiceChannelId);
    const side = endpointName(endpoint);

    if (!channel) {
      throw new Error(`Side ${side}: voice channel ${endpoint.voiceChannelId} was not found`);
    }

    if (channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Side ${side}: channel ${endpoint.voiceChannelId} is not a normal voice channel`);
    }

    const botMember = guild.members.me ?? await guild.members.fetchMe();
    const permissions = channel.permissionsFor(botMember);
    const missing = REQUIRED_VOICE_PERMISSIONS.filter((permission) => !permissions?.has(permission));

    if (missing.length > 0) {
      const missingNames = missing.map((permission) => new PermissionsBitField(permission).toArray()[0]);
      throw new Error(`Side ${side}: bot is missing voice permissions: ${missingNames.join(', ')}`);
    }

    return { guild, channel };
  }

  async function login() {
    await client.login(token);

    logger.info('discord client logged in', {
      botId: client.user?.id,
      botTag: client.user?.tag,
    });
  }

  async function registerBridgeCommands({
    guildIds = [],
    groupBridgesEnabled = false,
    maxGroupEndpoints = 3,
  } = {}) {
    const bridgeCommands = buildBridgeCommands({
      groupBridgesEnabled,
      maxGroupEndpoints,
    });

    if (guildIds.length === 0) {
      await client.application.commands.set(bridgeCommands);
      logger.info('registered global bridge slash commands', {
        commandCount: bridgeCommands.length,
        groupBridgesEnabled,
        maxGroupEndpoints,
      });
      return;
    }

    for (const guildId of guildIds) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(bridgeCommands);
      logger.info('registered guild bridge slash commands', {
        guildId,
        guildName: guild.name,
        commandCount: bridgeCommands.length,
        groupBridgesEnabled,
        maxGroupEndpoints,
      });
    }
  }

  function getBotInfo() {
    return {
      botId: client.user?.id,
      botTag: client.user?.tag,
    };
  }

  async function joinEndpoint(endpoint) {
    const { guild, channel } = await resolveVoiceChannel(endpoint);
    const side = endpointName(endpoint);

    logger.info('joining voice channel', {
      side,
      guildId: guild.id,
      guildName: guild.name,
      voiceChannelId: channel.id,
      voiceChannelName: channel.name,
    });

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf,
      selfMute,
    });

    connection.on('stateChange', (oldState, newState) => {
      logger.debug('voice connection state changed', {
        side,
        oldStatus: oldState.status,
        newStatus: newState.status,
      });
    });

    connection.on('error', (error) => {
      logger.error('voice connection error', {
        side,
        error: error.message,
      });
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    logger.info('voice channel joined', {
      side,
      guildId: guild.id,
      voiceChannelId: channel.id,
    });

    return connection;
  }

  async function resolveCallerVoiceEndpoint(interaction) {
    const guild = interaction.guild;
    if (!guild) {
      return undefined;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return undefined;
    }

    return {
      id: `${guild.id}:${channel.id}`,
      kind: 'discord',
      name: channel.name,
      label: channel.name,
      guildId: guild.id,
      voiceChannelId: channel.id,
    };
  }

  function commandContextFromInteraction(interaction, endpoint = undefined) {
    return {
      flags: MessageFlags.Ephemeral,
      subject: {
        userId: interaction.user.id,
        guildId: interaction.guildId ?? endpoint?.guildId ?? 'unknown',
        roleIds: interaction.member?.roles?.cache
          ? [...interaction.member.roles.cache.keys()]
          : [],
      },
      voiceChannelId: endpoint?.voiceChannelId,
    };
  }

  function onBridgeCommand(handler) {
    async function safeInteractionReply(interaction, options) {
      const response = normalizeInteractionResponseOptions(options);

      try {
        if (interaction.deferred) {
          return await interaction.editReply(response);
        }

        if (interaction.replied) {
          return await interaction.followUp(response);
        }

        return await interaction.reply(response);
      } catch (error) {
        logger.error('failed to send interaction response', {
          code: error?.code,
          command: interaction.commandName,
          error: error?.message,
          guildId: interaction.guildId,
          subcommand: interaction.options?.getSubcommand?.(false),
          userId: interaction.user?.id,
        });
        return undefined;
      }
    }

    function createSafeInteraction(interaction) {
      return new Proxy(interaction, {
        get(target, property, receiver) {
          if (property === 'reply') {
            return (options) => safeInteractionReply(target, options);
          }

          if (property === 'followUp') {
            return (options) => safeInteractionReply(target, options);
          }

          if (property === 'editReply') {
            return (options) => safeInteractionReply(target, options);
          }

          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }

    async function handleInteraction(interaction) {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'bridge') {
        return;
      }

      const safeInteraction = createSafeInteraction(interaction);

      try {
        await handler(safeInteraction);
      } catch (error) {
        logger.error('bridge command failed', {
          command: interaction.commandName,
          code: error?.code,
          error: error?.message,
          guildId: interaction.guildId,
          subcommand: interaction.options?.getSubcommand?.(false),
          userId: interaction.user?.id,
        });

        await safeInteractionReply(interaction, {
          content: 'Bridge command failed. Check the bot logs.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    function onInteractionCreate(interaction) {
      handleInteraction(interaction).catch((error) => {
        logger.error('unhandled interaction handler error', {
          code: error?.code,
          command: interaction.commandName,
          error: error?.message,
          guildId: interaction.guildId,
          subcommand: interaction.options?.getSubcommand?.(false),
          userId: interaction.user?.id,
        });
      });
    }

    client.on('interactionCreate', onInteractionCreate);

    return {
      destroy() {
        client.off('interactionCreate', onInteractionCreate);
      },
    };
  }

  function startDirectionalForwarding(sourceEndpoint, sourceConnection, targetEndpoint, targetConnection) {
    const sourceName = endpointName(sourceEndpoint);
    const targetName = endpointName(targetEndpoint);
    const direction = `${sourceName}->${targetName}`;
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });
    let mixSession;
    const subscription = targetConnection.subscribe(player);

    if (!subscription) {
      throw new Error(`Unable to subscribe side ${targetName} voice connection to audio player`);
    }

    player.on('stateChange', (oldState, newState) => {
      logger.debug('audio player state changed', {
        direction,
        oldStatus: oldState.status,
        newStatus: newState.status,
        resource: newState.resource?.metadata,
      });

      if (newState.status === 'idle') {
        mixSession = undefined;
      }
    });

    player.on('error', (error) => {
      logger.error('audio player error', {
        direction,
        error: error.message,
        resource: error.resource?.metadata,
      });
    });

    function onSpeakingStart(userId) {
      if (userId === client.user?.id) {
        logger.debug('ignoring bot audio source', {
          direction,
          userId,
        });
        return;
      }

      if (mixSession?.hasSource(userId)) {
        return;
      }

      if (!mixSession) {
        mixSession = createMixSession({
          direction,
          logger,
        });

        const resource = createAudioResource(mixSession.opusStream, {
          inputType: StreamType.Opus,
          metadata: {
            direction,
            kind: 'mixed-audio',
          },
        });

        logger.info('starting mixed audio resource', {
          direction,
          mixer: MIXER_LIMITS,
        });
        player.play(resource);
      }

      logger.info('forwarding speaker audio', {
        direction,
        userId,
      });

      const audioStream = sourceConnection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterInactivity,
          duration: MIXER_LIMITS.sourceInactivityMs,
        },
      });

      mixSession.addSource(userId, audioStream);
      logger.info('speaker connected to mixer', {
        direction,
        sourceCount: mixSession.sourceCount(),
        userId,
      });
    }

    sourceConnection.receiver.speaking.on('start', onSpeakingStart);

    logger.info('directional audio forwarding started', {
      direction,
      limitation: 'multiple speakers are mixed per direction',
    });

    return {
      destroy() {
        logger.info('directional audio forwarding stopping', {
          direction,
          activeSourceCount: mixSession?.sourceCount() ?? 0,
        });
        sourceConnection.receiver.speaking.off('start', onSpeakingStart);
        mixSession?.destroy();
        mixSession = undefined;
        player.stop(true);
        subscription.unsubscribe();
        logger.info('directional audio forwarding stopped', {
          direction,
        });
      },
    };
  }

  function startEndpointFanoutForwarding(targetEndpoint, targetConnection, sourceEntries) {
    const targetName = endpointName(targetEndpoint);
    const direction = `group->${targetName}`;
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });
    let mixSession;
    const subscription = targetConnection.subscribe(player);

    if (!subscription) {
      throw new Error(`Unable to subscribe endpoint ${targetName} voice connection to audio player`);
    }

    player.on('stateChange', (oldState, newState) => {
      logger.debug('group audio player state changed', {
        direction,
        oldStatus: oldState.status,
        newStatus: newState.status,
        resource: newState.resource?.metadata,
      });

      if (newState.status === 'idle') {
        mixSession = undefined;
      }
    });

    player.on('error', (error) => {
      logger.error('group audio player error', {
        direction,
        error: error.message,
        resource: error.resource?.metadata,
      });
    });

    const listeners = sourceEntries.map(({ endpoint: sourceEndpoint, session: sourceConnection }) => {
      const sourceName = endpointName(sourceEndpoint);
      const sourceEndpointId = sourceEndpoint.id;

      function onSpeakingStart(userId) {
        if (userId === client.user?.id) {
          logger.debug('ignoring bot audio source', {
            direction,
            sourceEndpointId,
            targetEndpointId: targetEndpoint.id,
            userId,
          });
          return;
        }

        const sourceKey = `${sourceEndpointId}:${userId}`;
        if (mixSession?.hasSource(sourceKey)) {
          return;
        }

        if (!mixSession) {
          mixSession = createMixSession({
            direction,
            logger,
          });

          const resource = createAudioResource(mixSession.opusStream, {
            inputType: StreamType.Opus,
            metadata: {
              direction,
              kind: 'group-mixed-audio',
              targetEndpointId: targetEndpoint.id,
            },
          });

          logger.info('starting group mixed audio resource', {
            direction,
            mixer: MIXER_LIMITS,
            targetEndpointId: targetEndpoint.id,
          });
          player.play(resource);
        }

        logger.info('forwarding group speaker audio', {
          direction,
          sourceEndpointId,
          sourceName,
          targetEndpointId: targetEndpoint.id,
          userId,
        });

        const audioStream = sourceConnection.receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterInactivity,
            duration: MIXER_LIMITS.sourceInactivityMs,
          },
        });

        mixSession.addSource(sourceKey, audioStream);
        logger.info('group speaker connected to mixer', {
          direction,
          sourceCount: mixSession.sourceCount(),
          sourceEndpointId,
          targetEndpointId: targetEndpoint.id,
          userId,
        });
      }

      sourceConnection.receiver.speaking.on('start', onSpeakingStart);
      return { onSpeakingStart, sourceConnection, sourceEndpoint };
    });

    logger.info('endpoint fanout audio forwarding started', {
      direction,
      sourceEndpointCount: sourceEntries.length,
      targetEndpointId: targetEndpoint.id,
    });

    return {
      destroy() {
        logger.info('endpoint fanout audio forwarding stopping', {
          direction,
          activeSourceCount: mixSession?.sourceCount() ?? 0,
          targetEndpointId: targetEndpoint.id,
        });

        for (const { onSpeakingStart, sourceConnection } of listeners) {
          sourceConnection.receiver.speaking.off('start', onSpeakingStart);
        }

        mixSession?.destroy();
        mixSession = undefined;
        player.stop(true);
        subscription.unsubscribe();
        logger.info('endpoint fanout audio forwarding stopped', {
          direction,
          targetEndpointId: targetEndpoint.id,
        });
      },
    };
  }

  function startGroupForwarding({ bridgeId, endpoints, sessions }) {
    const endpointEntries = endpoints.map((endpoint, index) => ({
      endpoint,
      session: sessions[index],
    }));
    const forwarders = endpointEntries.map(({ endpoint: targetEndpoint, session: targetSession }) => {
      const sourceEntries = endpointEntries.filter(({ endpoint }) => endpoint.id !== targetEndpoint.id);
      return startEndpointFanoutForwarding(targetEndpoint, targetSession, sourceEntries);
    });
    const directions = endpointEntries.flatMap(({ endpoint: sourceEndpoint }) => endpointEntries
      .filter(({ endpoint: targetEndpoint }) => targetEndpoint.id !== sourceEndpoint.id)
      .map(({ endpoint: targetEndpoint }) => `${endpointName(sourceEndpoint)}->${endpointName(targetEndpoint)}`));

    logger.info('group audio forwarding started', {
      bridgeId,
      directions,
      endpointCount: endpoints.length,
      echoProtection: 'target endpoint audio is excluded from its own outbound mix and bot user id is ignored',
      mixer: MIXER_LIMITS,
    });

    return {
      destroy() {
        logger.info('group audio forwarding stopping', {
          bridgeId,
          directions,
          endpointCount: endpoints.length,
        });
        for (const forwarder of forwarders) {
          forwarder.destroy();
        }
        logger.info('group audio forwarding stopped', {
          bridgeId,
          directions,
          endpointCount: endpoints.length,
        });
      },
    };
  }

  function startTwoWayForwarding(endpointA, connectionA, endpointB, connectionB) {
    return startGroupForwarding({
      bridgeId: `two-way:${endpointA.id}:${endpointB.id}`,
      endpoints: [endpointA, endpointB],
      sessions: [connectionA, connectionB],
    });
  }

  function startConnectionRecovery(endpoint, connection) {
    const side = endpointName(endpoint);
    let recovering = false;

    async function recover(trigger, context = {}, options = {}) {
      if (recovering) {
        logger.debug('recovery already in progress', {
          side,
          trigger,
          ...context,
        });
        return;
      }

      if (connection.state.status === VoiceConnectionStatus.Destroyed) {
        logger.warn('cannot recover destroyed voice connection', {
          side,
          trigger,
          ...context,
        });
        return;
      }

      recovering = true;
      logger.warn('voice connection recovery started', {
        side,
        trigger,
        ...context,
      });

      try {
        if (!options.force && connection.state.status === VoiceConnectionStatus.Ready) {
          logger.info('voice connection already ready during recovery', {
            side,
            trigger,
          });
          return;
        }

        const rejoinStarted = connection.rejoin({
          channelId: endpoint.voiceChannelId,
          selfDeaf,
          selfMute,
        });

        if (!rejoinStarted) {
          throw new Error('connection.rejoin() returned false');
        }

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        logger.info('voice connection recovered', {
          side,
          trigger,
        });
      } catch (error) {
        logger.error('voice connection recovery failed', {
          side,
          trigger,
          error: error.message,
        });
      } finally {
        recovering = false;
      }
    }

    async function onDisconnected(_oldState, newState) {
      logger.warn('voice connection disconnected', {
        side,
        disconnect: describeDisconnectState(newState),
      });

      if (!RECOVERABLE_DISCONNECT_REASONS.has(newState.reason)) {
        logger.warn('voice connection disconnect reason is not auto-recoverable', {
          side,
          disconnect: describeDisconnectState(newState),
        });
        return;
      }

      await wait(1_000);
      await recover('voice-connection-disconnected', {
        disconnect: describeDisconnectState(newState),
      });
    }

    function onDestroyed() {
      logger.warn('voice connection destroyed', {
        side,
      });
    }

    connection.on(VoiceConnectionStatus.Disconnected, onDisconnected);
    connection.on(VoiceConnectionStatus.Destroyed, onDestroyed);

    return {
      recover,
      destroy() {
        connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
        connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
      },
    };
  }

  function channelHasHumanMembers(channel) {
    return channel?.members?.some((member) => !member.user.bot) ?? false;
  }

  async function getVoiceChannel(endpoint) {
    const guild = await client.guilds.fetch(endpoint.guildId);
    const channel = await guild.channels.fetch(endpoint.voiceChannelId);
    return channel?.type === ChannelType.GuildVoice ? channel : undefined;
  }

  function startVoiceStateMonitor({
    bridgeId = undefined,
    endpointRecoveries,
    onEndpointEmpty = undefined,
  }) {
    const recoveriesByGuildId = new Map(
      endpointRecoveries.map(({ endpoint, recovery }) => [endpoint.guildId, { endpoint, recovery }]),
    );
    let emptyStopRequested = false;

    async function stopIfAnyEndpointEmpty(reason) {
      if (!onEndpointEmpty || emptyStopRequested) {
        return;
      }

      for (const { endpoint } of endpointRecoveries) {
        const channel = await getVoiceChannel(endpoint);
        if (!channel) {
          continue;
        }

        if (!channelHasHumanMembers(channel)) {
          emptyStopRequested = true;
          logger.info('bridge endpoint has no human voice members; stopping bridge', {
            bridgeId,
            guildId: endpoint.guildId,
            reason,
            voiceChannelId: endpoint.voiceChannelId,
          });
          await onEndpointEmpty(endpoint, reason);
          return;
        }
      }
    }

    async function onVoiceStateUpdate(oldState, newState) {
      const relatedEntry = recoveriesByGuildId.get(oldState.guild.id)
        ?? recoveriesByGuildId.get(newState.guild.id);
      if (relatedEntry) {
        await stopIfAnyEndpointEmpty('voice-state-empty-channel');
      }

      if (newState.id !== client.user?.id) {
        return;
      }

      const entry = recoveriesByGuildId.get(newState.guild.id);
      if (!entry) {
        return;
      }

      const { endpoint, recovery } = entry;
      const side = endpointName(endpoint);

      logger.info('bot voice state changed', {
        side,
        guildId: endpoint.guildId,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
      });

      if (!newState.channelId) {
        logger.warn('bot was disconnected from configured voice channel', {
          side,
          guildId: endpoint.guildId,
          oldChannelId: oldState.channelId,
        });
        await recovery?.recover('bot-voice-state-disconnected', {
          oldChannelId: oldState.channelId,
        }, {
          force: true,
        });
        return;
      }

      if (newState.channelId !== endpoint.voiceChannelId) {
        logger.warn('bot was moved away from configured voice channel', {
          side,
          guildId: endpoint.guildId,
          expectedChannelId: endpoint.voiceChannelId,
          oldChannelId: oldState.channelId,
          newChannelId: newState.channelId,
        });
        await recovery?.recover('bot-voice-state-moved', {
          oldChannelId: oldState.channelId,
          newChannelId: newState.channelId,
        }, {
          force: true,
        });
      }
    }

    client.on('voiceStateUpdate', onVoiceStateUpdate);

    return {
      destroy() {
        client.off('voiceStateUpdate', onVoiceStateUpdate);
      },
    };
  }

  function disconnectEndpoint(endpoint, connection) {
    const side = endpointName(endpoint);

    logger.info('leaving voice channel', {
      side,
      guildId: endpoint.guildId,
      voiceChannelId: endpoint.voiceChannelId,
    });
    connection.destroy();
    logger.info('left voice channel', {
      side,
      guildId: endpoint.guildId,
      voiceChannelId: endpoint.voiceChannelId,
    });
  }

  function destroy() {
    client.destroy();
  }

  return {
    destroy,
    disconnectEndpoint,
    getBotInfo,
    joinEndpoint,
    login,
    commandContextFromInteraction,
    onBridgeCommand,
    registerBridgeCommands,
    resolveCallerVoiceEndpoint,
    startConnectionRecovery,
    startGroupForwarding,
    startTwoWayForwarding,
    startVoiceStateMonitor,
  };
}

export const DISCORD_ADAPTER_PACKAGE = '@discord-voice-relay-bot/discord-adapter';
