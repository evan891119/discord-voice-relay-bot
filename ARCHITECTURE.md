# Discord Voice Relay Bot Architecture

## Purpose

Discord Voice Relay Bot is an open-source, self-hosted Discord voice relay. The
project is organized around a small bridge core plus adapters and providers, so
contributors can improve storage, configuration, permissions, and Discord
integration without duplicating voice bridge logic.

The current repository is a runnable self-hosted MVP. It uses npm workspaces
with a self-hosted app shell and shared packages for core bridge orchestration,
Discord integration, local configuration, and local runtime state.

## Current POC

The current POC proves that the same Discord bot can:

- Pair two voice channels in two different Discord servers through slash
  commands.
- Receive audio from Server A and transmit it into Server B.
- Receive audio from Server B and transmit it into Server A.
- Mix multiple speakers per direction.
- Ignore bot-originated audio as a basic echo-loop protection.
- Recover from common voice connection disconnects and bot moves.
- Run multiple unrelated two-endpoint bridges at the same time.
- Run from Docker Compose with persistent local state.

The current MVP does not include a dashboard, payments, public discovery,
three-or-more endpoint group bridges, or same-server channel-to-channel
bridging with one bot account.

## Product Boundary

The repository should provide a self-hosted version that users can deploy and
operate themselves. Optional future integrations should connect through the same
provider boundaries rather than forking the bridge implementation.

The intended split is:

- Core bridge packages: lifecycle, state transitions, routing contracts, and
  Discord adapter boundaries.
- Self-hosted app: process startup, local config, local state, local permission
  policy, Docker deployment, and Discord command UX.
- Optional future integrations: alternate config providers, alternate state
  stores, richer permissions, observability, or web UI.

Self-hosted usage is the primary product direction.

## Target Public Repository Modules

The workspace layout is:

- `apps/self-hosted-bot`
- `packages/bridge-core`
- `packages/discord-adapter`
- `packages/config-provider-local`
- `packages/state-store-local`

At this stage, `apps/self-hosted-bot` is the runnable app shell. The shared
bridge lifecycle lives in `packages/bridge-core`, and Discord-specific runtime
behavior lives in `packages/discord-adapter`. Local self-hosted configuration
loading lives in `packages/config-provider-local`. Local self-hosted runtime
state persistence lives in `packages/state-store-local`.

`packages/bridge-core` now contains the first `BridgeEngine` implementation for
bridge lifecycle orchestration. It receives Discord-specific functions from the
app shell, so it can start and stop the current POC bridge without importing
Discord libraries directly.

### `bridge-core`

Owns the bridge lifecycle and audio-routing decisions. It should expose a
`BridgeEngine` that can start, stop, inspect, and recover bridges through
interfaces supplied by outer modules.

`bridge-core` may own:

- Bridge lifecycle orchestration.
- Directional audio routing.
- Mixer integration.
- Echo-loop prevention rules.
- Bridge state transitions.
- Core events and errors.

Current status:

- `packages/bridge-core/src/bridgeEngine.js` owns start/stop orchestration,
  bridge state transitions, endpoint session cleanup, and injected recovery /
  forwarding lifecycle.
- The actual Discord voice receive/transmit implementation is injected by
  `packages/discord-adapter`.

`bridge-core` must not:

- Read `.env`, YAML, JSON, SQLite, Postgres, Redis, or UI data directly.
- Import `discord.js` or Discord-specific client setup directly.
- Know about account plans, dashboard users, or deployment-specific policy.
- Contain product rules that belong in app shells, providers, or policies.

### `discord-adapter`

Owns Discord-specific integration and exposes the Discord voice system through
interfaces consumed by `bridge-core`.

It may own:

- Discord client login and readiness.
- Slash command registration and Discord interaction handling.
- Guild and voice channel lookup.
- Permission checks that require Discord API data.
- Joining and leaving Discord voice channels.
- Discord voice receive and transmit streams.
- Voice connection state events.

Discord library limitations should stay inside this module whenever possible.

Current status:

- `packages/discord-adapter/src/index.js` owns Discord client login, voice
  channel resolution, permission checks, voice join, reconnect handling,
  voice-state monitoring, and bidirectional audio forwarding.
- `packages/discord-adapter/src/audioMixer.js` owns the current POC mixer.
- `apps/self-hosted-bot` consumes this package instead of importing
  `discord.js` or `@discordjs/voice` directly.

### `config-provider-local`

Owns self-hosted configuration loading. The first implementation can preserve an
environment-variable flow or move to YAML/JSON as long as `bridge-core` only
sees the `ConfigProvider` interface.

It may provide:

- Bot token source.
- Bridge definitions.
- Allowed guilds and channels.
- Local admin role or user allowlists.
- Self-hosted defaults.

Current status:

- `packages/config-provider-local/src/index.js` loads the existing repository
  root `.env` file.
- It validates the current POC environment variables and normalizes them into a
  self-hosted runtime config plus a `ConfigProvider`.
- It creates a local `PermissionPolicy` from the same configuration. The policy
  allows internal self-hosted startup, validates configured guild/channel
  boundaries, and supports optional local admin user/role allowlists for future
  command-driven flows.
- `apps/self-hosted-bot` consumes this package instead of parsing `.env` or
  constructing bridge definitions directly.

### `state-store-local`

Owns self-hosted runtime state persistence. The implementation can be a local
file or SQLite, chosen by the simplest durable self-hosted workflow.

It may store:

- Bridge records.
- Pairing code state.
- Enabled or disabled bridge status.
- Last known connection state.
- Recovery bookkeeping.

Current status:

- `packages/state-store-local/src/index.js` implements the shared `StateStore`
  boundary with a JSON file.
- The default state file is `.local/state.json` at the repository root.
- The self-hosted app injects this store into `BridgeEngine`.
- Hosted service can replace this package with Postgres, Redis, or another
  cloud-backed store without changing `bridge-core`.

### `self-hosted-bot`

Owns application startup and dependency wiring for the open-source bot.

It composes:

- `bridge-core`
- `discord-adapter`
- `config-provider-local`
- `state-store-local`
- Local `PermissionPolicy`
- Logger and process lifecycle handling

The app shell should stay thin. It should not own bridge business logic.

Current status:

- `apps/self-hosted-bot/src/app.js` exposes `createSelfHostedBot()`.
- The app shell wires together local config, local state, local permission
  policy, Discord adapter, logger, and `BridgeEngine`.
- `apps/self-hosted-bot/src/index.js` handles process startup, `SIGINT` /
  `SIGTERM`, top-level startup errors, and process exit.
- The app shell does not import Discord libraries directly and does not own
  audio forwarding, config parsing, state persistence, or authorization rules.

## Optional Future Integrations

Future integrations should connect to the same core boundaries through
alternative implementations of the provider interfaces.

Potential modules:

- `web-dashboard`: optional server and bridge management UI.
- `cloud-config-provider`: database-backed bridge and server configuration.
- `cloud-state-store`: Postgres/Redis-backed state and recovery metadata.
- `monitoring`: health checks, logs, alerts, and error tracking.
- `deployment/infra`: cloud runtime, secrets, scaling, and release pipelines.

These modules should not duplicate audio bridge logic. They should provide
configuration, state, authorization, and operations around the shared core.

## Core Interfaces

These interfaces are the intended boundaries. Exact names and signatures can
change during implementation, but the direction should remain stable.

The initial JavaScript/JSDoc contracts live in
`packages/bridge-core/src/contracts.js`. Package-specific boundaries re-export
or reference those contracts from:

- `packages/discord-adapter/src/index.js`
- `packages/config-provider-local/src/index.js`
- `packages/state-store-local/src/index.js`

The project is still JavaScript-first. These contracts are intentionally
lightweight so the POC can be refactored incrementally before deciding whether a
TypeScript migration is worth the extra project cost.

### `BridgeEngine`

Responsible for starting, stopping, and inspecting bridges. It should accept
bridge definitions, adapters, stores, policies, and logger dependencies from the
outside.

Expected responsibilities:

- Validate bridge topology at the core level.
- Start exactly two endpoints for the current MVP.
- Connect directional audio pipelines.
- Stop and clean up bridges.
- Emit lifecycle and error events.
- Ask `PermissionPolicy` before sensitive operations.
- Persist required runtime state through `StateStore`.

### `DiscordAdapter`

Responsible for Discord-specific runtime behavior.

Expected responsibilities:

- Identify the calling user's current voice channel for command-driven flows.
- Join and leave Discord voice channels.
- Expose received audio streams to the core.
- Transmit outbound audio streams into Discord voice channels.
- Report voice connection lifecycle events.
- Register and handle Discord command interactions.

### `ConfigProvider`

Responsible for configuration source abstraction.

Self-hosted can implement this with local YAML, JSON, or environment variables.
Other deployments can implement this with a database-backed provider.

Expected responsibilities:

- Load bridge definitions.
- Load bot/runtime settings.
- Load permission configuration.
- Return configuration in a normalized shape for the app shell and core.

### `StateStore`

Responsible for runtime state abstraction.

Self-hosted can use SQLite or local files. Alternate deployments can use
Postgres, Redis, or another store.

Expected responsibilities:

- Persist bridge records.
- Persist pairing code records.
- Persist bridge lifecycle state.
- Support recovery and status queries.

### `PermissionPolicy`

Responsible for authorization decisions.

Self-hosted can implement this with local config. Alternate deployments can
implement richer ownership, moderation, or deployment-specific rules.

Expected responsibilities:

- Decide whether a user can create a bridge.
- Decide whether a user can join a bridge.
- Decide whether a user can start, stop, or delete a bridge.
- Decide whether a guild/channel is allowed.
- Return clear denial reasons for Discord responses.

## Discord Command UX Direction

Discord command UX should be treated as the primary product experience for the
self-hosted bot. Other app shells should reuse the same concepts while
replacing local providers only when they need different storage or policy.

The command UX specification is documented in
`docs/discord-command-ux.md`. The planned first command group is `/bridge`, with
commands such as `/bridge create`, `/bridge join <code>`, `/bridge status`,
`/bridge leave`, and `/bridge help`.

Important architecture rules:

- The command handler should identify the caller's current voice channel through
  the Discord adapter.
- Command handlers should call `PermissionPolicy` before protected actions.
- Pairing codes, permission failures, and detailed errors should be ephemeral by
  default.
- Public channel messages should be limited to safe lifecycle announcements.
- The first command-driven version should still support exactly two endpoints.
- Deployment-specific policy should be enforced through providers and policies,
  not hard-coded in `bridge-core`.

## Pairing Flow Boundary

Pairing codes are part of the product interaction model, not the low-level audio
pipeline. The core may validate and start a bridge from resolved endpoint data,
but pairing-code creation, expiry, ownership, and authorization should live in
providers and policies.

Self-hosted pairing can use local state. Other deployments can use alternate
state stores and permission policies.

The pairing lifecycle and state model are documented in
`docs/cross-server-pairing-flow.md`.
Future three-or-more endpoint group bridges are designed separately in
`docs/multi-endpoint-group-bridge-design.md`.

Important architecture rules:

- Pairing records should be persisted through `StateStore`.
- Pairing authorization should be checked through `PermissionPolicy`.
- Pairing should finalize exactly two endpoints for the MVP.
- Alternate pairing implementations should replace local providers, not fork
  bridge core logic.

## MVP Non-Goals

These are intentionally out of scope for the next architecture refactor:

- Dashboard implementation.
- Public server discovery.
- Complex multi-room matching.
- Multi-tenant operations.
- Managed service operations.
- Enterprise identity or SSO.
- Recording or transcript features.
- Cross-platform voice adapters beyond Discord.

## Licensing And Brand

The open-source code is licensed under AGPLv3-or-later. This matches the
network-service nature of the project: users can run, study, modify, and
redistribute the code, while modified network-service versions should keep their
corresponding source available under the license terms.

The code license should not grant rights to the project brand, logo, service
name, domain, or trademarks. Brand and trademark rights should be reserved
separately from source code licensing.

See [docs/license-and-trademark.md](docs/license-and-trademark.md) for the
current project policy.

This document is product and engineering planning, not legal advice.
