# Group Bridge Verification

## Purpose

This checklist verifies the first self-hosted group bridge release path. Group
bridges are experimental, opt-in, and Discord-native. They do not require a
dashboard, hosted service, public discovery, or same-server channel-to-channel
bridging.

## Setup

Use three Discord servers that invited the same bot:

- Server A with one normal voice channel.
- Server B with one normal voice channel.
- Server C with one normal voice channel.

The bot needs:

- `View Channels`
- `Connect`
- `Speak`

Recommended local configuration:

```text
DISCORD_TOKEN=replace-with-local-token
LOG_LEVEL=info
ENABLE_GROUP_BRIDGES=true
MAX_GROUP_ENDPOINTS=3
COMMAND_GUILD_IDS=server-a-id,server-b-id,server-c-id
```

Leave `LOCAL_ALLOWED_GUILD_IDS` and `LOCAL_ALLOWED_VOICE_CHANNEL_IDS` empty for
the broadest self-hosted test. If allowlists are populated, include all three
test guild ids and voice channel ids.

## Preflight

Run:

```sh
npm run check
docker compose config --quiet
```

Expected result:

- Both commands exit successfully.
- Slash commands are registered with `/bridge create`, `/bridge join`,
  `/bridge invite`, `/bridge status`, `/bridge leave`, and `/bridge help`.
- `/bridge create` includes optional `max_endpoints` when
  `ENABLE_GROUP_BRIDGES=true`.

## Three-Server Flow

### 1. Create Group Bridge

1. In Server A, join a normal voice channel.
2. Run `/bridge create max_endpoints:3`.
3. Confirm the bot returns an ephemeral pairing code.

Expected result:

- The code is short-lived.
- The same code can be reused until the bridge reaches `3/3` or the code
  expires.
- The response does not expose remote server details.
- Logs include `bridgeMode: group` and `maxEndpoints: 3`.

### 2. Join Second Endpoint

1. In Server B, join a normal voice channel.
2. Run `/bridge join <code>` with the code from Server A.

Expected result:

- The group bridge starts with two endpoints.
- Audio from Server A is heard in Server B.
- Audio from Server B is heard in Server A.
- `/bridge status` in either voice channel shows `running` and endpoint count
  `2/3`.

### 3. Join Third Endpoint

1. In Server C, join a normal voice channel.
2. Run `/bridge join <code>` with the same code from Server A.

Expected result:

- The bot adds Server C as the third endpoint.
- The implementation may briefly restart the group bridge while applying the new
  endpoint definition.
- Audio from each server is heard in the other two servers.
- Audio is not transmitted back into the source server.
- `/bridge status` reports endpoint count `3/3`.

### 4. Optional Additional Invite

1. In Server A, Server B, or Server C, stay in the grouped voice channel.
2. Run `/bridge invite`.

Expected result:

- The bot rejects the invite because the bridge is already full.
- If this step is run before the group is full, the bot returns another
  short-lived code for one additional endpoint.

## Failure Checks

### Invalid Or Expired Code

Run `/bridge join <bad-code>`.

Expected result:

- The bot replies ephemerally that the code is invalid or expired.
- No voice channel is joined.

### Duplicate Server

Try to use a group code from a server that already has an endpoint in the group.

Expected result:

- The bot rejects the join.
- The rejection is ephemeral.
- The existing group bridge keeps running.

### Full Group

After the bridge reaches `3/3`, run `/bridge join <code>` from a fourth server
with the original group code.

Expected result:

- The bot rejects the join because the bridge is full.

### Endpoint Leave

1. With three endpoints active, run `/bridge leave` from Server C.
2. Run `/bridge status` from Server A or B.

Expected result:

- Server C is removed from the group.
- The group restarts with the remaining two endpoints.
- Status reports endpoint count `2/3`.

### Empty Channel Cleanup

1. Recreate a three-endpoint group.
2. Make all non-bot users leave Server C's voice channel.

Expected result:

- Server C is removed from the group.
- If at least two endpoints remain, the group continues.
- If fewer than two endpoints remain, the group stops.

### Bot Disconnect Or Move

Move or disconnect the bot in one grouped voice channel.

Expected result:

- Recovery attempts are logged for that endpoint.
- If recovery fails or the endpoint becomes unusable, logs contain enough
  `bridgeId`, endpoint, guild, and voice channel context to diagnose the case.

## Observations To Record

Record these before treating a build as release-ready:

- Number of active endpoints.
- Number of simultaneous speakers.
- Host CPU and memory while three endpoints are active.
- Whether audio latency remains acceptable for conversation.
- Whether mixer buffer-drop logs appear.
- Whether any Discord rate limit, reconnect loop, or permission error appears.

The initial supported group size should stay at 3 unless testing shows 4
endpoints is stable on the target self-hosted machine.
