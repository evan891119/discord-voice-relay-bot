# Public Release Checklist

This checklist is for preparing a clean public repository release of Discord
Voice Bridge from the private development repository.

## Release Strategy

- Keep this repository as the private development workspace until the public
  release is ready.
- Create a new clean public repository for the first public release.
- Follow `docs/public-release-procedure.md` for the clean public repository
  flow.
- Prefer a clean initial commit or carefully reviewed squashed history instead
  of exposing private development history.
- Release the public repo as an open-source self-hosted Discord voice relay,
  not as a hosted service or commercial SaaS product.

## Security And Secrets

- Confirm `.env` has never been committed to the public release history.
- Confirm Discord bot tokens and test server IDs are not present in committed
  files.
- Run a secret scan before publishing.
- Keep `.env`, `.env.*`, `.local/`, and `node_modules/` ignored.
- Verify Docker build context excludes local secrets and runtime state.

## Licensing

- Confirm the open-source license is still `AGPL-3.0-or-later`.
- Keep the `LICENSE` file in the public release.
- Keep the README license section aligned with
  `docs/license-and-trademark.md`.
- Keep brand, logo, domain, and project name rights separate from the code
  license if a brand policy is needed.
- Keep `CONTRIBUTING.md` contribution terms in the public release.
- Keep `SECURITY.md` vulnerability reporting guidance in the public release.

## Documentation

- Make README useful for first-time external users.
- Keep `.env.example` minimal and token-safe.
- Document bot invite scopes and permissions.
- Document Docker Compose deployment.
- Document command usage:
  - `/bridge create`
  - `/bridge join <code>`
  - `/bridge invite` when experimental group bridges are enabled
  - `/bridge status`
  - `/bridge leave`
- Document limitations:
  - two endpoints per bridge
  - endpoints must be in different Discord servers
  - no same-server two-channel bridge with one bot account
  - no dashboard
  - no public discovery
  - group bridges are experimental, opt-in, and bounded by `MAX_GROUP_ENDPOINTS`

## Verification

- Run `npm run check`.
- Run `docker compose config --quiet`.
- Verify Docker Compose can start with a test Discord bot token.
- Verify `/bridge create` and `/bridge join <code>` in two test servers.
- Verify `/bridge leave`.
- Verify auto-leave when one bridged channel becomes empty.
- If group bridges are enabled for the release, verify
  `docs/group-bridge-verification.md` with three Discord servers.
- Verify duplicate command registrations are cleaned up before release.

## Public Repository Setup

- Create the public repository.
- Push the cleaned release branch.
- Add repository description and topics.
- Add a `v0.1.0` tag after the first public release is verified.
- Add a short release note describing the self-hosted MVP scope.
