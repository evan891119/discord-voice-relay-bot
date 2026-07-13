import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const DEFAULT_ENV_FILE = new URL('../../../.env', import.meta.url);
const DEFAULT_MAX_GROUP_ENDPOINTS = 3;
const MIN_GROUP_ENDPOINTS = 3;
const MAX_GROUP_ENDPOINTS_LIMIT = 4;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const BOOLEAN_VALUES = new Map([
  ['true', true],
  ['false', false],
  ['1', true],
  ['0', false],
  ['yes', true],
  ['no', false],
]);

function listValue(env, name) {
  return optional(env, name, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(env, name, fallback) {
  const value = env[name]?.trim();
  return value || fallback;
}

function snowflake(env, name) {
  const value = required(env, name);
  if (!SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`${name} must be a Discord snowflake string`);
  }
  return value;
}

function optionalSnowflake(env, name) {
  const value = optional(env, name, '');
  if (!value) {
    return undefined;
  }

  if (!SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`${name} must be a Discord snowflake string`);
  }

  return value;
}

function logLevel(env, name, fallback) {
  const value = optional(env, name, fallback).toLowerCase();
  if (!LOG_LEVELS.has(value)) {
    throw new Error(`${name} must be one of: ${[...LOG_LEVELS].join(', ')}`);
  }
  return value;
}

function booleanValue(env, name, fallback) {
  const raw = optional(env, name, String(fallback)).toLowerCase();
  if (!BOOLEAN_VALUES.has(raw)) {
    throw new Error(`${name} must be a boolean value`);
  }
  return BOOLEAN_VALUES.get(raw);
}

function integerValue(env, name, fallback, { min, max } = {}) {
  const raw = optional(env, name, String(fallback));
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }

  const value = Number.parseInt(raw, 10);
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be at least ${min}`);
  }

  if (max !== undefined && value > max) {
    throw new Error(`${name} must be at most ${max}`);
  }

  return value;
}

function bridgeEndpointFromSide(side) {
  return {
    id: side.name,
    kind: 'discord',
    name: side.name,
    label: `Side ${side.name}`,
    guildId: side.guildId,
    voiceChannelId: side.voiceChannelId,
  };
}

export function createLocalConfigProvider(bridge = undefined) {
  const runtimeBridges = new Map();

  return {
    async getBridge(bridgeId) {
      if (bridge && bridgeId === bridge.id) {
        return bridge;
      }

      return runtimeBridges.get(bridgeId);
    },
    async listBridges() {
      return [
        ...(bridge ? [bridge] : []),
        ...runtimeBridges.values(),
      ];
    },
    async saveBridge(runtimeBridge) {
      runtimeBridges.set(runtimeBridge.id, runtimeBridge);
      return runtimeBridge;
    },
  };
}

export function createLocalPermissionPolicy({
  adminRoleIds = [],
  adminUserIds = [],
  allowSystem = true,
  allowedGuildIds,
  allowedVoiceChannelIds,
} = {}) {
  const guildIds = new Set(allowedGuildIds ?? []);
  const voiceChannelIds = new Set(allowedVoiceChannelIds ?? []);
  const roleIds = new Set(adminRoleIds);
  const userIds = new Set(adminUserIds);

  function allowedDecision() {
    return { allowed: true };
  }

  function denied(reason, message) {
    return { allowed: false, reason, message };
  }

  function bridgeEndpointsAllowed(bridge) {
    if (!bridge) {
      return allowedDecision();
    }

    for (const endpoint of bridge.endpoints) {
      if (guildIds.size > 0 && !guildIds.has(endpoint.guildId)) {
        return denied('guild_not_allowed', 'This bridge uses a guild that is not allowed by local configuration.');
      }

      if (voiceChannelIds.size > 0 && !voiceChannelIds.has(endpoint.voiceChannelId)) {
        return denied('voice_channel_not_allowed', 'This bridge uses a voice channel that is not allowed by local configuration.');
      }
    }

    return allowedDecision();
  }

  function subjectAllowed(context) {
    if (context?.system && allowSystem) {
      return { allowed: true, system: true };
    }

    const subject = context?.subject;
    if (!subject) {
      return denied('missing_subject', 'A user context is required for this bridge action.');
    }

    if (guildIds.size > 0 && !guildIds.has(subject.guildId)) {
      return denied('request_guild_not_allowed', 'This server is not allowed by local configuration.');
    }

    if (userIds.size === 0 && roleIds.size === 0) {
      return allowedDecision();
    }

    if (userIds.has(subject.userId)) {
      return allowedDecision();
    }

    if (subject.roleIds?.some((roleId) => roleIds.has(roleId))) {
      return allowedDecision();
    }

    return denied('admin_not_allowed', 'You are not allowed to manage this bridge.');
  }

  return {
    async can(_action, context, bridge) {
      const subjectDecision = subjectAllowed(context);
      if (!subjectDecision.allowed) {
        return subjectDecision;
      }

      if (subjectDecision.system) {
        return allowedDecision();
      }

      return bridgeEndpointsAllowed(bridge);
    },
  };
}

export function loadLocalConfig({
  env = process.env,
  envFile = DEFAULT_ENV_FILE,
} = {}) {
  dotenv.config({
    path: fileURLToPath(envFile),
    quiet: true,
  });

  const token = required(env, 'DISCORD_TOKEN');
  const guildAId = optionalSnowflake(env, 'GUILD_A_ID');
  const voiceChannelAId = optionalSnowflake(env, 'VOICE_CHANNEL_A_ID');
  const guildBId = optionalSnowflake(env, 'GUILD_B_ID');
  const voiceChannelBId = optionalSnowflake(env, 'VOICE_CHANNEL_B_ID');
  const staticValues = [guildAId, voiceChannelAId, guildBId, voiceChannelBId];
  const staticBridgeEnabled = staticValues.every(Boolean);

  if (!staticBridgeEnabled && staticValues.some(Boolean)) {
    throw new Error('Static bridge config requires all of: GUILD_A_ID, VOICE_CHANNEL_A_ID, GUILD_B_ID, VOICE_CHANNEL_B_ID');
  }

  if (staticBridgeEnabled && guildAId === guildBId) {
    throw new Error('GUILD_A_ID and GUILD_B_ID must be different for the POC');
  }

  if (staticBridgeEnabled && voiceChannelAId === voiceChannelBId) {
    throw new Error('VOICE_CHANNEL_A_ID and VOICE_CHANNEL_B_ID must be different');
  }

  const bridgeName = optional(env, 'BRIDGE_NAME', 'default');
  const sideA = staticBridgeEnabled ? {
    name: 'A',
    guildId: guildAId,
    voiceChannelId: voiceChannelAId,
  } : undefined;
  const sideB = staticBridgeEnabled ? {
    name: 'B',
    guildId: guildBId,
    voiceChannelId: voiceChannelBId,
  } : undefined;
  const bridge = staticBridgeEnabled ? {
    id: bridgeName,
    name: bridgeName,
    enabled: true,
    endpoints: [
      bridgeEndpointFromSide(sideA),
      bridgeEndpointFromSide(sideB),
    ],
  } : undefined;
  const commandGuildIds = listValue(env, 'COMMAND_GUILD_IDS');
  const groupBridgesEnabled = booleanValue(env, 'ENABLE_GROUP_BRIDGES', false);
  const maxGroupEndpoints = integerValue(env, 'MAX_GROUP_ENDPOINTS', DEFAULT_MAX_GROUP_ENDPOINTS, {
    min: MIN_GROUP_ENDPOINTS,
    max: MAX_GROUP_ENDPOINTS_LIMIT,
  });
  const allowedGuildIds = listValue(env, 'LOCAL_ALLOWED_GUILD_IDS');
  const allowedVoiceChannelIds = listValue(env, 'LOCAL_ALLOWED_VOICE_CHANNEL_IDS');
  const permissionPolicy = createLocalPermissionPolicy({
    adminRoleIds: listValue(env, 'LOCAL_ADMIN_ROLE_IDS'),
    adminUserIds: listValue(env, 'LOCAL_ADMIN_USER_IDS'),
    allowedGuildIds,
    allowedVoiceChannelIds,
  });

  return {
    allowedGuildIds,
    allowedVoiceChannelIds,
    bridge,
    bridgeAutoStart: booleanValue(env, 'BRIDGE_AUTO_START', false),
    bridgeName,
    commandGuildIds,
    configProvider: createLocalConfigProvider(bridge),
    groupBridgesEnabled,
    logLevel: logLevel(env, 'LOG_LEVEL', 'info'),
    maxGroupEndpoints,
    permissionPolicy,
    selfDeaf: booleanValue(env, 'SELF_DEAF', false),
    selfMute: booleanValue(env, 'SELF_MUTE', false),
    sideA,
    sideB,
    staticBridgeEnabled,
    token,
  };
}

export const CONFIG_PROVIDER_LOCAL_PACKAGE = '@discord-voice-relay-bot/config-provider-local';
