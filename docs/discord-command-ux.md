# Discord Command UX

## Purpose

This document defines the first Discord-native command experience for Discord
Voice Bridge. The goal is to let users control a bridge from Discord without a
dashboard.

The detailed cross-server pairing lifecycle and state model are documented in
`docs/cross-server-pairing-flow.md`.

The implementation target is the self-hosted open-source bot. Future app shells
or deployment integrations should keep the same user-facing command model where
possible.

## UX Principles

- Users should stay in their existing Discord servers and voice channels.
- A user should be able to call the bot into the voice channel they are already
  using.
- The default command-driven version should support exactly two endpoints.
  Experimental group bridges must be explicitly enabled by self-hosted config.
- The command flow should avoid requiring a web dashboard.
- Sensitive output should be ephemeral by default.
- Public messages should be limited to safe bridge lifecycle announcements.
- Permission failures should be explicit without leaking private configuration.
- Deployment-specific policy must not be hard-coded into command handling or
  `bridge-core`.

## Command Surface

The first command group should be `/bridge`.

Current implementation status:

- `/bridge create` and `/bridge join <code>` implement the primary dynamic
  pairing flow.
- When `ENABLE_GROUP_BRIDGES=true`, `/bridge create max_endpoints:<number>` and
  `/bridge invite` expose experimental group bridge setup.
- `/bridge leave`, `/bridge status`, and `/bridge help` support bridge
  management after pairing.
- Static `.env` bridge startup is a self-hosted fallback through
  `BRIDGE_AUTO_START=true`, not a primary Discord command flow.

### `/bridge create`

Creates the first side of a pending bridge from the caller's current voice
channel.

Expected behavior:

1. User joins a Discord voice channel.
2. User runs `/bridge create` from a text channel or command-capable Discord
   surface in the same server.
3. Bot verifies that the user is in a voice channel.
4. Bot verifies that the user and channel are allowed by `PermissionPolicy`.
5. Bot joins the caller's current voice channel.
6. Bot creates a short-lived pairing code.
7. Bot replies with the pairing code and expiry.

When group bridges are enabled, `max_endpoints` can be supplied to create an
experimental group bridge. Omitting `max_endpoints` keeps the default
two-endpoint bridge behavior. The initial group code can be reused until the
group reaches its configured endpoint limit or the code expires.

Response visibility:

- Ephemeral: pairing code, expiry, private setup errors, permission failures.
- Public: optional safe announcement that a bridge endpoint is waiting.

Failure states:

- Caller is not in a voice channel.
- Bot lacks `View Channels`, `Connect`, or `Speak`.
- Channel type is unsupported.
- User is not allowed by local policy.
- Another pending bridge already exists for the same channel, if the MVP chooses
  to enforce one pending bridge per channel.
- `max_endpoints` is supplied while group bridges are disabled.
- `max_endpoints` is outside the configured self-hosted range.

### `/bridge join <code>`

Joins the caller's current voice channel to a pending bridge created by another
server.

Expected behavior:

1. User joins a Discord voice channel.
2. User runs `/bridge join <code>`.
3. Bot validates the pairing code.
4. Bot verifies that the user is in a voice channel.
5. Bot verifies that the user and channel are allowed by `PermissionPolicy`.
6. Bot joins the caller's current voice channel.
7. Bot connects the bridge endpoints.
8. Bot starts bidirectional or group audio forwarding.

Response visibility:

- Ephemeral: invalid code, expired code, permission failures, private errors.
- Public: safe bridge started announcement in each involved server, if enabled.

Failure states:

- Pairing code is invalid, expired, already used, or revoked.
- Group code points to a bridge that is already full.
- Caller is not in a voice channel.
- Caller is trying to join from the same endpoint as the creator.
- Bot lacks required voice permissions.
- User or channel is not allowed by policy.
- Bridge startup fails after one side joined; bot should clean up and report the
  failed state.
- Group invite points to a full, stopped, failed, or deleted bridge.

### `/bridge invite`

Optionally creates another short-lived join code for an active group bridge.
The initial group code from `/bridge create max_endpoints:<number>` can already
be reused until the group is full or the code expires.

Expected behavior:

1. Caller joins a voice channel that is already part of a running group bridge.
2. Caller runs `/bridge invite`.
3. Bot verifies that group bridges are enabled.
4. Bot verifies that the group is not full.
5. Bot verifies that the caller can manage or join the group through
   `PermissionPolicy`.
6. Bot creates a one-time invite code.
7. Bot replies ephemerally with the code and expiry.

Response visibility:

- Ephemeral by default.

Failure states:

- Group bridges are disabled.
- Caller is not in a grouped voice channel.
- Active bridge is not a group bridge.
- Group bridge is already full.
- Caller is not allowed by policy.

### `/bridge status`

Shows the current bridge status visible to the caller.

Expected behavior:

- If the caller is in a bridged voice channel, show that bridge.
- If the caller is not in a voice channel, show any bridge the user is allowed
  to manage in the current server.
- For the MVP, status can be limited to the single active or pending bridge.

Response visibility:

- Ephemeral by default.
- Public status can be added later if it does not expose private server details.

Status fields:

- Bridge name or id.
- Current state: pending, running, stopping, stopped, failed.
- Local endpoint voice channel.
- Remote endpoint label, if safe to show.
- Pairing expiry for pending bridges.
- Group endpoint count, if the bridge is a group bridge.
- Last error summary, if any.

### `/bridge leave`

Makes the bot leave the bridge connected to the caller's current voice channel
or current server.

Expected behavior:

1. Bot identifies the relevant bridge.
2. Bot checks `PermissionPolicy`.
3. For a two-endpoint bridge, bot stops audio forwarding and leaves both voice
   channels.
4. For a group bridge with more than two endpoints, bot removes the caller's
   endpoint and restarts the group with the remaining endpoints.
5. If fewer than two group endpoints remain, bot stops the group.
6. Bot marks the resulting bridge state in `StateStore`.

Response visibility:

- Ephemeral confirmation to the caller.
- Optional public safe announcement that the bridge stopped.

Failure states:

- No active bridge found.
- Caller is not allowed to make the bot leave the bridge.
- Bot cannot fully leave a voice channel; the state should still be logged.

Response visibility:

- Ephemeral confirmation by default.

### `/bridge help`

Shows a concise command summary.

Expected behavior:

- Explain only available commands and current limitations.
- Avoid marketing copy.
- Avoid exposing configuration internals.

Response visibility:

- Ephemeral.

## Command Invocation Context

Commands may be invoked from a text channel or other Discord slash-command
surface, but the bot should resolve the caller's current voice channel from
Discord voice state.

Rules:

- The caller must be in a normal Discord voice channel for `/bridge create` and
  `/bridge join`.
- Stage channels are out of scope for the MVP unless explicitly added later.
- If the caller is not in a voice channel, the bot should explain that the user
  must join one first.
- The command channel does not have to be the voice channel, because Discord
  voice channels are not always used for command text.

## Permission Model

The command handler should call `PermissionPolicy` before creating, joining,
starting, stopping, or leaving a bridge.

- Allowed guilds and voice channels come from local config.
- Optional `LOCAL_ADMIN_USER_IDS` and `LOCAL_ADMIN_ROLE_IDS` can restrict who
  can manage command-driven bridges.
- If no admin allowlist is configured, local policy can allow users inside the
  configured guild/channel boundary.

Future permission integrations can add richer ownership checks, moderation
rules, or deployment-specific allowlists through `PermissionPolicy`, not
through `bridge-core`.

## Response Style

Use short, action-oriented Discord responses.

Examples:

- `Bridge code created. Share this code with the other server: ABC123`
- `Join a voice channel first, then run this command again.`
- `Bridge started between this voice channel and the paired server.`
- `Bridge stopped.`
- `This pairing code expired. Create a new bridge code.`
- `You are not allowed to manage this bridge.`

Ephemeral responses should be the default for:

- Pairing codes.
- Permission failures.
- Invalid state errors.
- Debug or operational details.
- Anything that names the remote server in a way users may not expect.

Public responses can be used for:

- Bridge started.
- Bridge stopped.
- Bot joined or left, if the server owner wants visible lifecycle messages.

## Abuse And Safety Considerations

The bridge should not create surprise cross-server audio connections.

MVP safeguards:

- Require both sides to run an explicit command.
- Use short-lived pairing codes.
- Ignore bot-originated audio to reduce echo loops.
- Scope commands through `PermissionPolicy`.
- Keep pairing codes ephemeral.
- Keep detailed errors out of public channels.
- Log bridge lifecycle and failures.

Future safeguards:

- Moderation controls for blocked users, guilds, or channels.
- Audit log for bridge creation, joining, leaving, and failed attempts.
- Monitoring and automatic shutdown for unhealthy bridges.

## Provider Boundaries

The command UX should stay stable while storage, permissions, and monitoring can
evolve behind provider boundaries:

| Concern | Default self-hosted implementation | Possible future integration |
| --- | --- | --- |
| Config | Local `.env`, later YAML/JSON | Database-backed config |
| State | `.local/state.json` | SQLite, Postgres, Redis |
| Permission | Local allowlists | Richer ownership or moderation policy |
| Bot identity | User-created bot token | Alternate app shell or managed runtime |
| Monitoring | Local logs | Centralized monitoring and alerts |

## Open Questions

- Pairing code length and expiry duration.
- Whether both sides need a final explicit confirmation before audio starts.
- Whether public start/leave announcements are enabled by default.
- How command registration should work for self-hosted users.
- How much remote server information is safe to show in status responses.
