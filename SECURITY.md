# Security Policy

## Supported Versions

The project is pre-1.0. Security fixes are handled on the main development line
until a formal support policy is published.

## Reporting A Vulnerability

Do not open a public issue for vulnerabilities that expose secrets, allow
unauthorized bot control, bypass bridge permissions, or could disrupt Discord
servers.

Until a dedicated security contact is published, report vulnerabilities
privately to the project maintainer through the repository owner's preferred
private contact channel.

Please include:

- Affected version or commit.
- Clear reproduction steps.
- Expected impact.
- Whether a Discord bot token, guild, or voice channel permission is involved.
- Any suggested fix, if available.

## Sensitive Data

Never include these in public issues, pull requests, logs, or screenshots:

- Discord bot tokens.
- Real `.env` files.
- Private guild IDs or channel IDs when they identify non-public servers.
- User audio recordings.
- Runtime state or logs containing private server details.
