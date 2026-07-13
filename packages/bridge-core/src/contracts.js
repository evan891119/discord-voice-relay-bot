/**
 * @typedef {'discord'} BridgeEndpointKind
 */

/**
 * A voice endpoint resolved by an adapter. The core treats endpoint ids as
 * opaque; Discord-specific guild and channel meaning belongs to the adapter.
 *
 * @typedef {object} BridgeEndpoint
 * @property {string} id Stable endpoint id.
 * @property {BridgeEndpointKind} kind Endpoint adapter kind.
 * @property {string} guildId Discord guild id for the MVP adapter.
 * @property {string} voiceChannelId Discord voice channel id for the MVP adapter.
 * @property {string} [label] Human-readable endpoint label.
 */

/**
 * A bridge definition. Pair mode supports exactly two endpoints. Group mode is
 * an explicit future-facing topology for three-or-more endpoint bridges.
 *
 * @typedef {object} BridgeDefinition
 * @property {string} id Stable bridge id.
 * @property {string} name Human-readable bridge name.
 * @property {'pair' | 'group'} [mode] Bridge topology. Defaults to `pair`.
 * @property {BridgeEndpoint[]} endpoints Voice endpoints in the bridge.
 * @property {number} [maxEndpoints] Maximum endpoint count for group bridges.
 * @property {boolean} enabled Whether the bridge should be allowed to run.
 */

/**
 * @typedef {'stopped' | 'starting' | 'running' | 'recovering' | 'stopping' | 'failed'} BridgeStatus
 */

/**
 * @typedef {object} BridgeRuntimeState
 * @property {string} bridgeId Bridge id.
 * @property {BridgeStatus} status Current bridge status.
 * @property {string} [reason] Optional status reason.
 * @property {string} updatedAt ISO timestamp for the last state update.
 */

/**
 * @typedef {'create_bridge' | 'join_bridge' | 'start_bridge' | 'stop_bridge' | 'delete_bridge'} PermissionAction
 */

/**
 * @typedef {object} PermissionSubject
 * @property {string} userId Discord user id for the MVP adapter.
 * @property {string} guildId Discord guild id where the action was requested.
 * @property {string[]} [roleIds] Discord role ids known to the adapter.
 */

/**
 * @typedef {object} PermissionDecision
 * @property {boolean} allowed Whether the action is allowed.
 * @property {string} [reason] Machine-readable denial reason.
 * @property {string} [message] User-facing denial message.
 */

/**
 * @typedef {object} BridgeCommandContext
 * @property {PermissionSubject} subject User and guild requesting the command.
 * @property {string} [voiceChannelId] Current voice channel id, if known.
 * @property {boolean} [ephemeral] Whether response should be private.
 * @property {boolean} [system] Whether the action is an internal app lifecycle action.
 */

/**
 * @typedef {object} PairingCodeRecord
 * @property {string} code Short-lived pairing code.
 * @property {string} bridgeId Bridge id being paired.
 * @property {BridgeEndpoint} sourceEndpoint Endpoint that created the code.
 * @property {string} [createdAt] ISO timestamp when the code was created.
 * @property {string} createdByUserId User that created the code.
 * @property {string} expiresAt ISO timestamp when the code expires.
 */

/**
 * Core bridge engine boundary. Implementations should depend on adapters,
 * providers, stores, and policies supplied by the app shell.
 *
 * @typedef {object} BridgeEngine
 * @property {(bridgeId: string, context?: BridgeCommandContext) => Promise<BridgeRuntimeState>} startBridge
 * @property {(bridgeId: string, context?: BridgeCommandContext) => Promise<BridgeRuntimeState>} stopBridge
 * @property {(bridgeId: string) => Promise<BridgeRuntimeState | undefined>} getBridgeState
 */

/**
 * Configuration source boundary. Local config, dashboard config, and database
 * config should all normalize into these core shapes before reaching the core.
 *
 * @typedef {object} ConfigProvider
 * @property {() => Promise<BridgeDefinition[]>} listBridges
 * @property {(bridgeId: string) => Promise<BridgeDefinition | undefined>} getBridge
 * @property {(bridge: BridgeDefinition) => Promise<BridgeDefinition>} [saveBridge]
 */

/**
 * Runtime state boundary. Local files, SQLite, Postgres, and Redis are storage
 * choices outside bridge-core.
 *
 * @typedef {object} StateStore
 * @property {(bridgeId: string) => Promise<BridgeRuntimeState | undefined>} getBridgeState
 * @property {(state: BridgeRuntimeState) => Promise<void>} saveBridgeState
 * @property {(record: PairingCodeRecord) => Promise<void>} savePairingCode
 * @property {(code: string) => Promise<PairingCodeRecord | undefined>} [getPairingCode]
 * @property {() => Promise<PairingCodeRecord[]>} [listPairingCodes]
 * @property {(code: string) => Promise<void>} [deletePairingCode]
 * @property {(code: string) => Promise<PairingCodeRecord | undefined>} consumePairingCode
 */

/**
 * Authorization boundary. Self-hosted can read local allowlists; hosted service
 * can check dashboard ownership, subscription state, abuse controls, and usage
 * limits outside the core.
 *
 * @typedef {object} PermissionPolicy
 * @property {(action: PermissionAction, context: BridgeCommandContext, bridge?: BridgeDefinition) => Promise<PermissionDecision>} can
 */

/**
 * Discord adapter boundary. The core should not import discord.js or
 * @discordjs/voice directly; it should receive endpoint audio and lifecycle
 * behavior through an adapter shaped like this.
 *
 * @typedef {object} DiscordAdapter
 * @property {(endpoint: BridgeEndpoint) => Promise<VoiceEndpointSession>} joinVoiceEndpoint
 * @property {(bridgeId: string) => Promise<void>} leaveBridge
 * @property {(context: BridgeCommandContext) => Promise<BridgeEndpoint | undefined>} resolveCallerVoiceEndpoint
 */

/**
 * @typedef {object} VoiceEndpointSession
 * @property {BridgeEndpoint} endpoint Connected endpoint.
 * @property {(listener: (event: VoiceReceiveEvent) => void) => void} onReceiveAudio
 * @property {(packet: VoiceTransmitPacket) => Promise<void>} transmitAudio
 * @property {() => Promise<void>} disconnect
 */

/**
 * @typedef {object} VoiceReceiveEvent
 * @property {string} speakerId User id that produced the audio.
 * @property {AsyncIterable<Uint8Array>} opusStream Received Opus audio.
 */

/**
 * @typedef {object} VoiceTransmitPacket
 * @property {AsyncIterable<Uint8Array>} opusStream Opus audio to transmit.
 * @property {string} sourceEndpointId Endpoint id where the audio originated.
 */

export const CONTRACT_VERSION = '0.1.0';
