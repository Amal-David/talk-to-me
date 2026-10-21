# Verification record

Checked locally on 2026-10-21 with Node.js 24.19.0. This is a source-code verification record, not a production certification, external audit, or real-bot integration result.

## Passed

- `npm run typecheck`: strict TypeScript checks.
- `npm run lint`: Biome lint and formatting.
- `npm test`: 50 tests, zero failures and zero skipped tests, including real Miniflare/workerd with SQLite Durable Objects, two synthetic agents, concurrency, restart/replay, authorization failures, quotas, cancellation/result races, byte bounds, alarms without incoming requests, and transactional fault injection.
- `node --check bin/talk-to-me.mjs`: CLI syntax.
- `npm run dry-run`: Wrangler bundled the Worker and recognized the SQLite Durable Object binding; upload size approximately 29.48 KiB. This command did not deploy anything.
- `npm audit`: zero reported vulnerabilities, including development dependencies, at verification time. This does not prove the absence of unknown vulnerabilities.

CI runs `npm ci`, an audit at high severity, the full aggregate check, and Wrangler dry-run on Node.js 24. No deployment step or account credentials are configured. The minimum supported Node version is 22.13; CI verification is on 24.

## Dependency decisions

Direct development dependencies are exact-pinned with an npm lockfile. The application bundle and CLI have no third-party runtime dependencies. The current stable Miniflare 4.20260730.0 is used directly for restart-capable tests. Its vulnerable development-only `sharp` and `undici` dependencies are pinned through scoped overrides to patched 0.35.5 and 7.29.1 respectively; the full suite and dry-run were repeated after that change. Wrangler's own dependency tree remains lockfile-pinned. Reevaluate the overrides when upgrading Miniflare.

Reference documentation: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Miniflare Durable Objects](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/), and [current Cloudflare testing guidance](https://developers.cloudflare.com/workers/testing/vitest-integration/). The project uses the direct Miniflare API with Node's test runner rather than the deprecated `@cloudflare/vitest-pool-workers` package.

## Not performed

No Cloudflare deployment, real account setup, real credential creation, live Grok/Instinct/dot call, model invocation, chargeable routine test, or provider end-to-end round trip was performed. Production access controls, DNS/egress boundaries, operational alerts, backups, billing limits, and actual bot persistence remain deployment acceptance work.

Optional Grok wake tests use explicit offline fake HTTP responses. A 200 only establishes the adapter's `started` state, not an actual bot completion. Instinct and dot have no verified live adapter in this release. The project does not claim A2A compliance or runtime egress confinement.
