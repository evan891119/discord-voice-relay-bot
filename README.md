# Discord Voice Relay Bot

Discord Voice Relay Bot is a proof-of-concept Discord bot/service that bridges
voice communication between Discord voice channels in different Discord
servers.

Users stay inside their own Discord server and voice channel. The same bot is
invited to both servers, joins the paired voice channels, and forwards audio
both directions.

This repository is an open-source, self-hosted Discord voice relay. The main
goal is to provide a useful bot that communities can run themselves. The code is
organized into small packages so contributors can improve configuration,
storage, deployment, and Discord integration without mixing those concerns into
the bridge core.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the package boundaries and extension
points.

See [docs/discord-command-ux.md](docs/discord-command-ux.md) for the planned
Discord slash-command user experience.
See [docs/cross-server-pairing-flow.md](docs/cross-server-pairing-flow.md) for
the planned cross-server pairing lifecycle and state model.
See [docs/license-and-trademark.md](docs/license-and-trademark.md) for the
project license and brand policy.
See [docs/public-release-checklist.md](docs/public-release-checklist.md) for
the checklist to use before creating a clean public repository.
See [docs/public-release-procedure.md](docs/public-release-procedure.md) for
the recommended clean public repository release flow.

## Repository Layout

This repository uses npm workspaces so the bot can grow through shared packages
without turning the app shell into one large file.

Current layout:

- `apps/self-hosted-bot` — runnable self-hosted Discord bot app shell.
- `packages/bridge-core` — package for shared bridge lifecycle and audio
  routing logic.
- `packages/discord-adapter` — package for Discord client, command, and
  voice integration.
- `packages/config-provider-local` — package for local self-hosted
  configuration loading.
- `packages/state-store-local` — package for local self-hosted runtime
  state.

The self-hosted app wires the current POC together. Shared contracts and bridge
lifecycle orchestration live in `packages/bridge-core`, while Discord login,
voice connection, recovery, receive/transmit, and mixer integration live in
`packages/discord-adapter`. The current `.env` configuration flow is loaded by
`packages/config-provider-local`, and runtime bridge state is persisted by
`packages/state-store-local`.

The self-hosted app shell itself lives in `apps/self-hosted-bot/src/app.js`.
It composes local config, local state, Discord voice integration, permission
policy, logging, and `BridgeEngine`. The CLI entrypoint
`apps/self-hosted-bot/src/index.js` only handles startup, shutdown signals, and
top-level startup errors.

## Current Status

Implemented:

- Bot login with `discord.js`.
- Slash commands for dynamic pairing.
- Global command registration by default, with optional guild-scoped command
  registration for faster development.
- Dynamic `/bridge create` and `/bridge join <code>` pairing.
- `/bridge status` scoped to the caller's current bridged voice channel.
- `/bridge leave` scoped to the caller's current bridge.
- Automatic leave when either bridged voice channel has no non-bot users left.
- Two simultaneous Discord voice connections per bridge with `@discordjs/voice`.
- Bidirectional audio forwarding:
  - `A -> B`
  - `B -> A`
- Basic bot-originated audio filtering.
- Multi-speaker audio mixing per direction.
- Basic reconnect/rejoin handling when the bot is moved, disconnected, or the
  voice connection drops.
- Multiple unrelated bridge pairs can run at the same time.
- Guardrails prevent the same voice channel from being reused across multiple
  pending or running bridges.
- Docker Compose deployment example.
- JSON lifecycle, recovery, and audio pipeline logs.

## Non-Goals

This repository is currently a focused self-hosted MVP, not a public hosted
service.

Do not expect these features yet:

- Dashboard.
- Payments.
- Public server discovery.
- Complex multi-room matching.
- Three-or-more endpoint group bridges.
- Same-server voice-channel-to-voice-channel bridging with one bot account.

## License

Discord Voice Relay Bot is licensed under the GNU Affero General Public License
version 3 or later (`AGPL-3.0-or-later`). See [LICENSE](LICENSE) for the full
license text.

The code license does not grant rights to the project name, logo, domains,
service names, visual identity, or trademarks. See
[docs/license-and-trademark.md](docs/license-and-trademark.md) for the current
project policy.

## Contributing And Security

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Known Limitations

- Each bridge currently supports exactly two endpoints.
- The two endpoints must be in different Discord servers.
- Both channels must be normal Discord voice channels.
- Multiple speakers can be mixed per direction, but this is still a POC mixer.
- The current mixer uses `opusscript`, which is a JavaScript Opus fallback and
  may use more CPU than a native Opus binding.
- Physical acoustic echo can still happen if a user's speakers feed back into
  their microphone.
- Recovery is basic and reuses the existing voice connections and forwarding
  pipeline. Fully destroyed connections may still require a process restart.

## Runtime Requirements

- Node.js `>=22.12.0`
- npm
- A Discord application and bot token
- The same bot invited into the Discord servers that should be bridged
- Bot access to the voice channels users want to pair

## Discord Bot Setup

Create a Discord application and bot in the Discord Developer Portal.

Recommended OAuth2 scope for the POC:

- `bot`
- `applications.commands`

Minimum bot permissions:

- `View Channels`
- `Connect`
- `Speak`

Minimum permission integer:

```text
3146752
```

Optional additional voice permission:

- `Use Voice Activity`

Permission integer with `Use Voice Activity`:

```text
36701184
```

Recommended Gateway intents:

- `Guilds`
- `GuildVoiceStates`

Do not enable these for the POC unless a future change needs them:

- `Message Content Intent`
- `Server Members Intent`
- `Presence Intent`

## Configuration

Copy `.env.example` to `.env`:

```sh
cp .env.example .env
```

Minimal local configuration:

```text
DISCORD_TOKEN=replace-with-local-token
LOG_LEVEL=info
COMMAND_GUILD_IDS=
```

Required variables:

- `DISCORD_TOKEN`

Optional variables:

- `LOG_LEVEL=info`
- `COMMAND_GUILD_IDS=` comma-separated Discord guild IDs for faster development
  command registration. Leave empty to register global commands for every
  server that invited the bot.

Advanced optional variables:

- `SELF_DEAF=false`
- `SELF_MUTE=false`
- `LOCAL_ADMIN_USER_IDS=` comma-separated Discord user IDs allowed to manage
  command-driven bridges
- `LOCAL_ADMIN_ROLE_IDS=` comma-separated Discord role IDs allowed to manage
  command-driven bridges
- `LOCAL_ALLOWED_GUILD_IDS=` optional comma-separated guild allowlist. Leave
  empty to disable the guild allowlist and allow dynamic pairing in any invited
  server.
- `LOCAL_ALLOWED_VOICE_CHANNEL_IDS=` optional comma-separated voice-channel
  allowlist. Leave empty to disable the voice-channel allowlist and allow
  dynamic pairing from any normal voice channel where the bot has access.

Optional legacy static bridge variables:

- `BRIDGE_NAME=default`
- `BRIDGE_AUTO_START=false` set to `true` only when the bot should join the
  configured static channels immediately on process startup
- `GUILD_A_ID`
- `VOICE_CHANNEL_A_ID`
- `GUILD_B_ID`
- `VOICE_CHANNEL_B_ID`

`DISCORD_TOKEN` is secret. Never commit `.env`.

By default, the bot logs in and registers slash commands, but it does not join
voice channels until users create and join a dynamic pairing. `BRIDGE_AUTO_START=true`
preserves the earlier static POC behavior for deployments that should start
bridging as soon as the process starts.

The local permission policy allows dynamic pairing in any invited server and
voice channel by default. Set `LOCAL_ALLOWED_GUILD_IDS` or
`LOCAL_ALLOWED_VOICE_CHANNEL_IDS` only when you want to enable a local allowlist.
The optional admin allowlists restrict who can use command-driven bridge
controls.

## Local Runtime State

The self-hosted bot stores runtime bridge state in:

```text
.local/state.json
```

This file is created automatically and is ignored by git. It currently records
bridge lifecycle state and pairing-code records for future command-driven
flows. It is not required for the static POC configuration, but it keeps the
self-hosted app using the same `StateStore` boundary that future storage
integrations can replace with SQLite, Postgres, Redis, or another store.

## Install And Run

Install dependencies:

```sh
npm install
```

Check syntax:

```sh
npm run check
```

Run the bot:

```sh
npm start
```

Stop the bot with `Ctrl+C`.

The root scripts delegate to the self-hosted workspace app. Keep `.env` at the
repository root.

## Docker Compose Deployment

The self-hosted bot can run as a long-lived Docker Compose service. This is the
recommended shape for a small self-hosted deployment.

1. Copy the example environment file:

```sh
cp .env.example .env
```

2. Set `DISCORD_TOKEN` in `.env`. Leave `COMMAND_GUILD_IDS` empty for global
   slash commands, or set comma-separated test server IDs for faster command
   updates during development.

3. Build and start the service:

```sh
docker compose up -d --build
```

4. View logs:

```sh
docker compose logs -f
```

5. Stop the service:

```sh
docker compose down
```

`docker-compose.yml` mounts `./.local` to `/app/.local` so runtime state such as
bridge states and pending pairing codes can survive container restarts. Keep
`.env` and `.local/` out of git.

The Compose service uses `restart: unless-stopped` so the bot restarts after a
process crash or host reboot. Dashboard, centralized monitoring, and managed
operations are not implemented in this repository yet.

Startup flow:

1. `apps/self-hosted-bot/src/index.js` creates the self-hosted bot.
2. `apps/self-hosted-bot/src/app.js` loads local config and creates the logger.
3. The app shell creates `DiscordAdapter`, `StateStore`, and `BridgeEngine`.
4. The Discord adapter logs in.
5. The Discord adapter registers `/bridge` slash commands.
6. If `BRIDGE_AUTO_START=true`, `BridgeEngine` starts the configured bridge.
   Otherwise, the bot waits for `/bridge create` and `/bridge join`.
7. On `SIGINT` or `SIGTERM`, the app shell stops the bridge, disconnects voice
   sessions, destroys the Discord client, and exits.

## Slash Commands

The self-hosted bot registers `/bridge` slash commands in the configured guilds
on startup. Dynamic pairing uses the caller's current voice channel and a
short-lived pairing code.

Implemented commands:

- `/bridge status` shows the configured bridge status.
- `/bridge leave` makes the bot leave the bridge connected to the caller's
  current voice channel or server.
- `/bridge help` shows a concise command summary.
- `/bridge create` creates a 10-minute pairing code from the caller's current
  voice channel.
- `/bridge join <code>` consumes a pairing code from another server, joins both
  voice channels, and starts two-way audio forwarding.

## Test Procedure

Use two Discord servers:

- Server A with voice channel A.
- Server B with voice channel B.

Before running:

1. Invite the same bot to both servers with `bot` and `applications.commands`
   scopes.
2. Confirm the bot can view, connect, and speak in both voice channels.
3. Start the bot with `npm start`.
4. Confirm the bot stays out of voice channels when `BRIDGE_AUTO_START=false`.
5. Run `/bridge help` in each server after commands appear.

Dynamic pairing test:

1. In Server A, join a normal voice channel and run `/bridge create`.
2. Copy the pairing code from the private response.
3. In Server B, join a normal voice channel and run `/bridge join <code>`.
4. Confirm the bot joins both current voice channels.
5. Speak from Server A and confirm Server B can hear it.
6. Speak from Server B and confirm Server A can hear it.
7. Run `/bridge leave` from either bridged server and confirm the bot leaves
   both voice channels.
8. Start a new dynamic pairing, then have all non-bot users leave either voice
   channel and confirm the bot leaves both sides automatically.

Pairing codes expire after 10 minutes and are consumed after one join attempt.
The first dynamic implementation requires the second endpoint to be in a
different Discord server. Multiple unrelated bridge pairs can run at the same
time, but one voice channel can only be part of one pending or running bridge.

## Logging

Logs are emitted as one JSON object per line.

Each entry includes:

- `time`
- `level`
- `message`
- `context`

The current POC logs:

- bot startup
- Discord login
- voice channel join attempts
- voice channel joined
- bridge ready
- forwarding start/stop
- speaker forwarding
- dropped speakers
- audio player errors
- receive stream errors
- bot voice-state changes
- recovery attempts
- recovery success/failure
- shutdown and voice channel leave events

Use `LOG_LEVEL=debug` for lower-level state-change logs.

## Troubleshooting

### Missing environment variables

The bot fails fast at startup if `DISCORD_TOKEN` is missing or malformed.
Legacy static bridge variables are optional, but if one static bridge endpoint
variable is set, all four static endpoint variables must be set.

### Bot cannot join a voice channel

Check:

- bot is invited to the server
- target channels are normal voice channels, not stage channels
- bot role has `View Channels`, `Connect`, and `Speak`
- local allowlists are empty or include the guild/channel being used

### Slash commands do not appear

Check:

- invite URL includes the `applications.commands` scope
- the bot process has restarted after command changes
- global commands can take time to appear in Discord
- for faster development, set `COMMAND_GUILD_IDS` to one or more test server IDs

### Audio only works one way

Check:

- both users are speaking in the configured channels
- the bot is not self-deafened or self-muted
- `SELF_DEAF=false`
- `SELF_MUTE=false`
- logs for dropped speakers or audio player errors

### Multiple users speak at once

The current POC mixes multiple speakers per direction. If quality or latency is
poor, check CPU usage and consider replacing `opusscript` with a native Opus
binding such as `@discordjs/opus`.

### Bot is moved or disconnected

The bot attempts to rejoin the configured voice channel. Check recovery logs for
the trigger, old channel ID, new channel ID, and recovery result.
