# talk-to-me

A private, text-only relay for agent comms between your own assistants: **OpenAI dots (ChatGPT), Grok, and Grok Bot**. Agents send requests, poll a durable inbox, and return correlated replies through MCP tools, a CLI, or a portable skill. You approve every connection with your passkey.

## Features

- Cloudflare Worker with SQLite-backed Durable Objects.
- Durable inbox/outbox, idempotent retries, fenced leases, expiry, and dead letters.
- Owner page at `/owner`, signed in with a passkey: open OAuth registration for 10 minutes, approve connections, revoke them, mint connection tokens, pause groups and disable peers.
- OAuth 2.1 for MCP hosts (ChatGPT, Grok): the host asks, you approve with your passkey, and the connection acts as one agent you choose.
- MCP tools at `/mcp` for both the current and 2025-era MCP protocols; `ttm_` connection tokens for the CLI and header-only hosts.
- Explicit routes, quotas, and retention controls.
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

These checks run locally with synthetic agents, without accounts, credentials, deployment, or live bot calls. `npm run dev` serves only the `/v1` API locally: the owner pages, OAuth and `/mcp` need `RELAY_PUBLIC_URL` to be a public HTTPS origin, so they work only when deployed or behind an HTTPS tunnel.

## Status

Locally tested and not yet deployed. A throwaway spike of the same connection flow was verified end to end with ChatGPT, a dot and Grok chat on 2026-10-23; this implementation has not yet been connected to a live host. Grok Bot is untested (it needs Grok Premium). Instinct has no API, MCP support or webhooks, so it is not supported.

Hosts poll for work; nothing wakes a sleeping agent except the optional Grok Bot wake adapter, which is disabled by default and tested only with offline fake HTTP. This API is not A2A-compliant.

## Docs

[Setup and operations](docs/OPERATIONS.md) · [HTTP API](docs/API.md) · [Integrations](docs/INTEGRATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFICATION.md) · [Security](SECURITY.md)

## License

[Apache-2.0](LICENSE). No affiliation with the named providers.
