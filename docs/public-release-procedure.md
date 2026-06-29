# Public Release Procedure

This procedure is for publishing Discord Voice Relay Bot from the private
development repository into a clean public repository.

Do not publish directly from the private development history unless the full
history has been reviewed and approved for public release.

## Recommended Strategy

Use a new public repository for the first open-source release.

Recommended public repository name:

```text
discord-voice-relay-bot
```

Recommended first release tag:

```text
v0.1.0
```

Recommended repository description:

```text
Self-hosted Discord voice relay bot for pairing voice channels across Discord servers.
```

Recommended repository topics:

```text
discord
discord-bot
voice
voice-relay
self-hosted
nodejs
```

## Pre-Release Checks

Before creating the public repository:

1. Confirm the private worktree is clean.
2. Confirm `.env`, `.env.*`, `.local/`, and runtime state files are ignored.
3. Confirm no real Discord bot token is present in tracked files.
4. Confirm no private test server or channel IDs are present in public docs.
5. Run a secret scan on the release tree.
6. Run `npm run check`.
7. Run `docker compose config --quiet`.
8. Test Docker Compose with a test bot token.
9. Test `/bridge create`, `/bridge join <code>`, `/bridge status`, and
   `/bridge leave` in two Discord servers.
10. Test auto-leave when either bridged voice channel becomes empty.
11. Confirm duplicate Discord command registrations have been cleaned up.

## Files To Include

The public release should include:

- `README.md`
- `ARCHITECTURE.md`
- `LICENSE`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.env.example`
- `.gitignore`
- `.dockerignore`
- `Dockerfile`
- `docker-compose.yml`
- `apps/`
- `packages/`
- `docs/`
- `package.json`
- `package-lock.json`

Do not include:

- `.env`
- `.env.*`
- `.local/`
- `node_modules/`
- private notes
- runtime state
- local logs
- private screenshots

## Clean Public Repo Flow

1. Create an empty public GitHub repository.
2. Prepare a clean release directory from the private repo contents.
3. Copy only the approved public files into that directory.
4. Run the pre-release checks from the clean release directory.
5. Create the initial public commit.
6. Push to the public repository.
7. Create the `v0.1.0` tag after verification passes.
8. Publish a short release note with the current self-hosted MVP scope.

## Initial Release Note Draft

```md
# Discord Voice Relay Bot v0.1.0

Initial self-hosted MVP release.

This release provides a Discord bot that can bridge audio between two voice
channels in two different Discord servers. Users stay in their own servers and
voice channels, then use `/bridge create` and `/bridge join <code>` to pair a
bridge.

Current limitations:

- Two endpoints per bridge.
- Endpoints must be in different Discord servers.
- No dashboard.
- No public discovery.
- No three-or-more endpoint group bridge yet.
```

## Post-Release Checks

After the public repository is live:

- Confirm the README renders correctly.
- Confirm the license is detected as AGPL-3.0-or-later.
- Confirm `.env.example` is safe.
- Confirm public clone plus `npm install` works.
- Confirm Docker Compose docs are still accurate.
- Confirm issue reporting and security reporting instructions are visible.
