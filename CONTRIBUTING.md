# Contributing

Thanks for considering a contribution to Discord Voice Relay Bot.

This project is an open-source, self-hosted Discord voice relay. Contributions
should keep that scope clear and should not add hosted-service, billing,
dashboard, or public discovery assumptions unless the project explicitly adopts
that work later.

## Development Setup

Requirements:

- Node.js `>=22.12.0`
- npm

Install dependencies:

```sh
npm install
```

Run checks:

```sh
npm run check
```

## Contribution Guidelines

- Keep changes focused and easy to review.
- Preserve the package boundaries described in `ARCHITECTURE.md`.
- Do not commit `.env`, Discord bot tokens, server IDs from private test
  servers, runtime state, logs, or local screenshots.
- Update README or docs when behavior, commands, configuration, or deployment
  steps change.
- Add or update verification notes in the pull request description.

## License Of Contributions

By submitting a contribution, you certify that you have the right to submit it
and that your contribution may be distributed under this project's license:
`MIT`.

## Brand Usage

The project code is licensed under the MIT License. The project name, logo,
domains, service names, visual identity, and trademarks remain subject to the
separate policy in `docs/license-and-trademark.md`.
