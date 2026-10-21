# talk-to-me

A private, text-only request/reply relay for a small, owner-enrolled group of agents.

**Status: v0.1 implementation, locally tested. Not deployed. No real bot integration has been verified.** The repository contains no production credentials, account setup, or live bot calls. It is a mailbox and optional wake signal, not an autonomous agent runner.

## Product flow

1. An owner approves identities and exact sender → recipient → topic routes.
2. Agent A sends a bounded text request with a stable idempotency key.
3. The relay durably records it in A's outbox and B's inbox before replying.
4. B polls and claims a fenced lease. An acknowledgement means delivery, not completion.
5. B independently applies its own permissions and produces a text result. The relay atomically records one canonical result.
6. A reads the correlated result. Neither a peer message nor a skill grants permission to execute a command, call a model, use a tool, or disclose other information.

Incoming text and results are always marked `contentTrust: "untrusted"`. This service never executes them, fetches URLs from them, or interprets them as configuration.

## Included

- TypeScript Cloudflare Worker and one SQLite-backed Durable Object per private group.
- Durable inbox/outbox ledger, stable send and claim retries, atomic claim/ack/result, lease fencing, expiry, bounded delivery attempts, dead letters, and alarms.
- Owner-provisioned per-identity bearer-token hashes, exact route scopes, token expiry, durable peer revocation, group pause, and cancellation.
- Bounded request size, per-peer rate limits, pending/storage/claim quotas, server-derived lineage depth, and text-retention purge with replay tombstones.
- A dependency-free Node CLI and portable [Agent Skill](skills/talk-to-me/SKILL.md).
- An optional, **disabled-by-default** Grok Bot routine wake adapter, exercised only with offline fake HTTP. A 200 marks wake `started`, not request completion. Ambiguous outcomes are held, not automatically retried.
- Miniflare/workerd integration tests, actual SQLite restart tests, concurrent replay/race tests, security tests, and CI. No D1, Queues, R2, dashboard, MCP server, or A2A facade in this version.

## Try it without accounts or credentials

Node.js 22.13 or later (CI uses 24):

```sh
npm ci
npm run check
npm run dry-run
node bin/talk-to-me.mjs help
```

Tests run two synthetic agents with publicly recognizable test tokens in isolated, local Miniflare workers. Test outbound HTTP is denied except for explicitly injected offline responses. Tests do not deploy, spend model usage, or contact any bot.

`npm run dev` starts Wrangler locally but the checked-in configuration intentionally has no enrolled identities and fails closed. A real owner must separately approve and provision policy and credentials before it can accept requests. See [operations](docs/OPERATIONS.md), [HTTP API](docs/API.md), and [integration evidence](docs/INTEGRATIONS.md).

## What persistence means

The relay database is authoritative. A bot's process, VM, context window, or skill installation is not the durable message store. The portable client can reconnect after process loss without inventing a new request ID. A lease expiring may cause redelivery, so a receiver must apply its own idempotency to any separately authorized external effects. This is not exactly-once execution.

Cloudflare Durable Objects may be evicted and reconstructed. SQLite records and alarms survive that lifecycle; workerd integration tests validate local persistence behavior, not Cloudflare account configuration or an end-to-end production SLA. [Cloudflare storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) describe the underlying guarantees.

## Integration status

| Target | Included behavior | Live verification |
| --- | --- | --- |
| Any compatible runtime | Manual CLI polling and explicit text reply | Synthetic agents only |
| Grok Bot | Optional documented Bearer POST wake contract, disabled by default | No account endpoint, credentials, or real round trip tested |
| Instinct | Portable instructions only; adapter disabled/unverified | No supported inbound/wake contract verified |
| dot | Portable instructions only; adapter disabled/unverified | No public inbound/wake contract verified |

A skill does not start a sleeping agent. Installing a client does not establish access to a provider's private APIs. This project's API is not A2A-compliant; a versioned, tested A2A facade is a future extension.

## Security boundary

Closed membership is **not** runtime egress confinement, per-bot isolation on a shared computer, or end-to-end encryption. The relay operator, hosting provider, and participating model providers can process relevant content. An approved peer can still misuse information it has already received. See [security design](SECURITY.md) before enrolling anything real. The [engineering flow](docs/ARCHITECTURE.md) and [verification record](docs/VERIFICATION.md) describe implementation boundaries and tested behavior.

The first release deliberately caps retained request and claim tombstones rather than silently deleting deduplication history. Text is purged after the configured retention interval; replay identifiers and hashes remain. Capacity exhaustion fails closed. Plan a reviewed export/migration strategy before prolonged operation.

## License

Apache-2.0. See [LICENSE](LICENSE). No affiliation with the named bot providers is implied.
