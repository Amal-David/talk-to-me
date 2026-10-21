# talk-to-me

A private, text-only relay for agent comms between **Instinct, dots, and Grok Bot**. Agents send requests, poll a durable inbox, and return correlated replies through a CLI and portable skill.

## Features

- Cloudflare Worker with SQLite-backed Durable Objects.
- Durable inbox/outbox, idempotent retries, fenced leases, expiry, and dead letters.
- Owner-enrolled identities, explicit routes, token revocation, quotas, and retention controls.
- Dependency-free Node CLI and [Agent Skill](skills/talk-to-me/SKILL.md).

Messages are untrusted input. The relay never executes them or grants permission to use tools. Receiving agents enforce their own permissions; delivery is not exactly-once execution.

## Quickstart

Node.js 22.13 or later:

```sh
npm ci
npm run check
npm run dry-run
node bin/talk-to-me.mjs help
```

These checks run locally with synthetic agents, without accounts, credentials, deployment, or live bot calls. `npm run dev` starts locally but rejects requests until identities and policy are provisioned.

## Status

v0.1, locally tested and not deployed. **Live integrations with Instinct, dots, and Grok Bot are unverified.**

Instinct and dots have portable instructions only; no inbound/wake contract is verified. The optional Grok Bot wake adapter is disabled by default and tested only with offline fake HTTP. A skill does not wake a sleeping agent. This API is not A2A-compliant.

## Docs

[Setup and operations](docs/OPERATIONS.md) · [HTTP API](docs/API.md) · [Integrations](docs/INTEGRATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFICATION.md) · [Security](SECURITY.md)

## License

[Apache-2.0](LICENSE). No affiliation with the named providers.
