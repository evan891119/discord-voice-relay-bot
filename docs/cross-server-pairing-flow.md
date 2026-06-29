# Cross-Server Pairing Flow

## Purpose

This document defines how two Discord servers connect their current voice
channels through Discord Voice Relay Bot.

The first command-driven version should still support exactly two endpoints.
Multi-bridge and multi-endpoint routing remain future work.

## Pairing Goals

- Let Server A create a pending bridge from the caller's current voice channel.
- Let Server B join that pending bridge from another current voice channel.
- Avoid surprise or accidental cross-server audio connections.
- Keep pairing usable in the self-hosted open-source bot without a dashboard.
- Store pairing lifecycle state through `StateStore`, not through `bridge-core`
  internals.
- Enforce authorization through `PermissionPolicy`, not through command-specific
  hard-coding.

## Primary Flow

### 1. Create Pending Bridge

1. User in Server A joins a normal Discord voice channel.
2. User runs `/bridge create`.
3. Discord adapter resolves the caller's current voice channel.
4. Command handler calls `PermissionPolicy.can('create_bridge', context)`.
5. Bot joins Server A's voice channel.
6. Command handler creates a pending bridge record.
7. Command handler creates a short-lived pairing code.
8. Command handler saves the pairing record through `StateStore`.
9. Bot replies ephemerally with the pairing code and expiry time.

### 2. Join Pending Bridge

1. User in Server B joins a normal Discord voice channel.
2. User runs `/bridge join <code>`.
3. Command handler consumes the pairing code through `StateStore`.
4. Command handler rejects the request if the code is invalid, expired,
   revoked, already used, or points to an incompatible pending bridge.
5. Discord adapter resolves the caller's current voice channel.
6. Command handler calls `PermissionPolicy.can('join_bridge', context, bridge)`.
7. Bot joins Server B's voice channel.
8. Command handler finalizes the bridge with exactly two endpoints.
9. Command handler calls `BridgeEngine.startBridge(bridgeId, context)`.
10. Bot starts bidirectional audio forwarding.
11. Bot replies with safe success messages.

### 3. Leave Bridge

1. User runs `/bridge leave`.
2. Command handler identifies the bridge from the caller's current voice channel
   or current server context.
3. Command handler calls `PermissionPolicy.can('stop_bridge', context, bridge)`.
4. Command handler calls `BridgeEngine.stopBridge(bridgeId, context)`.
5. Runtime state is updated through `StateStore`.

## Pairing Code Rules

Recommended MVP defaults:

- Code length: 6 to 8 uppercase alphanumeric characters.
- Expiry: 10 minutes.
- One-time use: yes.
- Case-insensitive input: yes, normalize to uppercase.
- Character set: avoid ambiguous characters if manually typed, such as `0`,
  `O`, `1`, and `I`.
- Storage: `StateStore`.
- Response visibility: ephemeral.

Reasons:

- Short codes are easy to read across servers or voice chat.
- Short expiry reduces accidental joins.
- One-time use prevents replay.
- Ephemeral responses reduce leakage in public text channels.

## State Model

The state model should stay provider-neutral. The default self-hosted app can
persist this in `.local/state.json`; alternate deployments can persist it in
SQLite, Postgres, Redis, or another store.

### Bridge Record

Fields:

- `id`: stable bridge id.
- `name`: human-readable bridge name.
- `status`: `pending`, `starting`, `running`, `stopping`, `stopped`, `failed`,
  or `expired`.
- `createdByUserId`: Discord user id that created the pending bridge.
- `createdInGuildId`: Discord guild id where `/bridge create` was run.
- `createdAt`: ISO timestamp.
- `updatedAt`: ISO timestamp.
- `expiresAt`: ISO timestamp for pending bridge expiry.
- `endpoints`: array of endpoint records.
- `lastError`: optional short error summary.

The command-driven MVP should keep `endpoints.length <= 2`.

### Endpoint Record

Fields:

- `id`: endpoint id, such as `A` or `B` for the MVP.
- `kind`: `discord`.
- `guildId`: Discord guild id.
- `voiceChannelId`: Discord voice channel id.
- `createdByUserId`: Discord user id that added this endpoint.
- `createdAt`: ISO timestamp.
- `label`: optional safe display label.

### Pairing Code Record

Fields:

- `code`: normalized pairing code.
- `bridgeId`: pending bridge id.
- `sourceEndpoint`: first endpoint record.
- `createdByUserId`: Discord user id that created the code.
- `createdInGuildId`: Discord guild id where the code was created.
- `createdAt`: ISO timestamp.
- `expiresAt`: ISO timestamp.
- `consumedAt`: optional ISO timestamp.
- `consumedByUserId`: optional Discord user id.
- `consumedInGuildId`: optional Discord guild id.
- `revokedAt`: optional ISO timestamp.
- `status`: `active`, `consumed`, `expired`, or `revoked`.

The existing `StateStore.savePairingCode()` and `consumePairingCode()` methods
cover the minimum MVP behavior. Additional fields can be added without changing
the core boundary.

## Permission Checks

### `/bridge create`

Required checks:

- User can create a bridge in the current guild.
- User can use the current voice channel.
- Bot is allowed to join the current voice channel.
- Local policy allows creating a pending bridge.

Policy action:

- `create_bridge`

### `/bridge join <code>`

Required checks:

- Pairing code exists and is active.
- Pairing code has not expired.
- Pairing code has not already been consumed.
- User can join a bridge in the current guild.
- User can use the current voice channel.
- Target endpoint is not the same guild/channel as the source endpoint.
- Local policy allows the resulting two-endpoint bridge.

Policy action:

- `join_bridge`

### `/bridge leave`

Required checks:

- Bridge exists and is visible to the caller.
- User can manage the bridge from the current guild or endpoint.
- Local policy allows making the bot leave the bridge.

Policy action:

- `stop_bridge`

## Error Handling

User-facing errors should be short and mostly ephemeral.

Recommended messages:

- Invalid code: `This bridge code is invalid.`
- Expired code: `This bridge code expired. Create a new bridge code.`
- Used code: `This bridge code was already used.`
- No voice channel: `Join a voice channel first, then run this command again.`
- Same endpoint: `Create and join must happen from different voice channels.`
- Permission denied: `You are not allowed to manage this bridge.`
- Startup failure: `The bridge could not start. Check the bot logs.`

Detailed errors should go to structured logs.

## Cleanup Rules

Pending bridge cleanup:

- Expired pairing codes should not be usable.
- Expired pending bridges should be marked `expired` or removed by a cleanup
  task.
- If Server B fails to join after consuming a code, the command handler should
  either restore the code when safe or mark the attempt failed and ask the user
  to create a new code.

Runtime cleanup:

- If bridge startup fails after one endpoint joined, the bot should leave any
  joined voice channels.
- If the bridge stops, both endpoints should be disconnected.
- If the bot is moved or kicked, existing reconnect handling applies.

## Self-Hosted Implementation

Self-hosted MVP should use:

- `config-provider-local` for allowed guild/channel boundaries and admin
  allowlists.
- `state-store-local` for pending bridge records and pairing codes.
- `discord-adapter` to resolve caller voice channels and join endpoints.
- `bridge-core` to start and stop the finalized two-endpoint bridge.

The self-hosted version should not require a dashboard.

## Future Provider Extensions

Future deployments can keep the same pairing UX while replacing providers:

- Database-backed config providers can store server, channel, and bridge config.
- Alternate state stores can persist pairing, lifecycle, and recovery state.
- Richer `PermissionPolicy` implementations can check ownership, moderation
  blocks, and abuse rules.
- Monitoring observes failed pairing attempts, bridge health, reconnect loops,
  and operational health.

Provider integrations should not fork the core pairing concept or duplicate
audio bridge logic.

## Open Questions

- Exact pairing code length and expiry duration.
- Whether code creation should immediately join the creator's voice channel or
  wait until Server B joins.
- Whether both sides must explicitly confirm before audio starts.
- Whether pending bridges should survive process restart in self-hosted mode.
- Whether one guild can have multiple pending codes in the MVP.
- How much remote server or channel information should be shown in status.
