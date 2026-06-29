# License And Trademark Policy

This document records the initial open-source licensing decision for Voice
Relay for Discord. It is project planning, not legal advice.

## Code License

Discord Voice Relay Bot is licensed under the GNU Affero General Public License
version 3 or later (`AGPL-3.0-or-later`).

The AGPL was chosen because this project is network service software. The
license allows users to run, study, modify, and redistribute the code, while
requiring source availability for modified versions that are offered to users
over a network.

The full license text is in [../LICENSE](../LICENSE).

## Why Not MIT Or Apache-2.0

MIT and Apache-2.0 are simpler permissive licenses and are often easier for
commercial reuse. They are not the first choice here because they allow someone
to run a modified hosted version without sharing those modifications.

Apache-2.0 has an explicit patent grant, which is useful for some projects, but
this project currently prioritizes keeping network-service improvements open.

## Why Not GPLv3 Only

GPLv3 protects redistributed software, but it does not add the AGPL network-use
source availability requirement. Because this project is meant to run as a bot
service, AGPLv3 better matches the expected deployment model.

## Brand And Trademark

The code license does not grant rights to project branding.

The following are reserved unless a separate written policy or permission says
otherwise:

- Project name
- Logo
- Domain names
- Service names
- Visual identity
- Trademarks

Forks and modified versions should avoid implying that they are the official
Discord Voice Relay Bot project unless they are maintained by the project owner.

## Contributions

Before accepting external contributions, the project should add a
`CONTRIBUTING.md` file that explains:

- How contributors certify that they have the right to submit their work.
- That contributions are submitted under the project license.
- How maintainers review and merge changes.

No separate contributor license agreement is required at this stage.

## Public Release Notes

Before the first public release:

- Keep the `LICENSE` file in the public repository.
- Keep `package.json` license fields set to `AGPL-3.0-or-later`.
- Keep README license wording aligned with this document.
- Re-check whether a separate trademark policy is needed if the project has a
  logo, domain, hosted service, or public brand presence.
