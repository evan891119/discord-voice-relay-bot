import {
  ChannelType,
  Client,
  GatewayIntentBits,
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
const BRIDGE_COMMANDS = [
  new SlashCommandBuilder()
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
      .setDescription('Show bridge command help.'))
    .addSubcommand((subcommand) => subcommand
      .setName('create')
      .setDescription('Create a pending bridge from your current voice channel.'))
    .addSubcommand((subcommand) => subcommand
      .setName('join')
      .setDescription('Join a pending bridge with a pairing code.')
      .addStringOption((option) => option
        .setName('code')
        .setDescription('Pairing code from the other server.')
        .setRequired(true))),
].map((command) => command.toJSON());

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

  async function registerBridgeCommands({ guildIds = [] } = {}) {
    if (guildIds.length === 0) {
      await client.application.commands.set(BRIDGE_COMMANDS);
      logger.info('registered global bridge slash commands', {
        commandCount: BRIDGE_COMMANDS.length,
      });
      return;
    }

    for (const guildId of guildIds) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(BRIDGE_COMMANDS);
      logger.info('registered guild bridge slash commands', {
        guildId,
        guildName: guild.name,
        commandCount: BRIDGE_COMMANDS.length,
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
      ephemeral: true,
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
    async function onInteractionCreate(interaction) {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'bridge') {
        return;
      }

      try {
        await handler(interaction);
      } catch (error) {
        logger.error('bridge command failed', {
          command: interaction.commandName,
          error: error.message,
          guildId: interaction.guildId,
          subcommand: interaction.options.getSubcommand(false),
          userId: interaction.user.id,
        });

        const response = {
          content: 'Bridge command failed. Check the bot logs.',
          ephemeral: true,
        };

        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(response);
          return;
        }

        await interaction.reply(response);
      }
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

  function startTwoWayForwarding(endpointA, connectionA, endpointB, connectionB) {
    const nameA = endpointName(endpointA);
    const nameB = endpointName(endpointB);
    const forwarders = [
      startDirectionalForwarding(endpointA, connectionA, endpointB, connectionB),
      startDirectionalForwarding(endpointB, connectionB, endpointA, connectionA),
    ];

    logger.info('two-way audio forwarding started', {
      directions: [`${nameA}->${nameB}`, `${nameB}->${nameA}`],
      echoProtection: 'bot user id is ignored as a source in both directions',
      mixer: MIXER_LIMITS,
    });

    return {
      destroy() {
        logger.info('two-way audio forwarding stopping', {
          directions: [`${nameA}->${nameB}`, `${nameB}->${nameA}`],
        });
        for (const forwarder of forwarders) {
          forwarder.destroy();
        }
        logger.info('two-way audio forwarding stopped', {
          directions: [`${nameA}->${nameB}`, `${nameB}->${nameA}`],
        });
      },
    };
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
    startTwoWayForwarding,
    startVoiceStateMonitor,
  };
}

export const DISCORD_ADAPTER_PACKAGE = '@discord-voice-relay-bot/discord-adapter';
