# Verification record

Checked locally on 2026-10-26 with Node.js 22.22.3, on the `audit-fixes` branch after the 2026-10-26 audit. CI runs the same steps on Node.js 24. This is a source-code verification record, not a production certification, external audit, or live-host integration result.

## Passed

- `npm run typecheck`: strict TypeScript checks.
- `npm run lint`: Biome lint and formatting.
- `npm test`: 76 tests, zero failures and zero skipped, against real Miniflare/workerd with SQLite Durable Objects. They cover:
  - the relay lifecycle (send, claim, lease, reply, cancel, expiry, dead letters, purge), concurrency, restart and replay, quotas, byte and escaping bounds, alarms without incoming requests, transactional fault injection and the v0.1 schema upgrade;
  - owner passkeys, driven by a software P-256 authenticator against the real `@simplewebauthn/server`: setup, sign-in, step-up, sessions, Origin checks, challenge reuse, counters;
  - OAuth: the registration window, the redirect allowlist, the full DCR + PKCE + passkey + code exchange flow, approval binding, revocation on the next call and on refresh, reconnection, connection tokens, denial, and hostile app names;
  - MCP tools on both protocol eras, a two-agent round trip and caller identity;
  - the CLI's validation and output handling.
- Security rules added since v0.1 were mutation-checked: each was broken on purpose and its test confirmed to fail.
- `node --check bin/talk-to-me.mjs`: CLI syntax. The CLI was also run end to end against the Worker in Miniflare with a `ttm_` connection token during the audit.
- `npm run dry-run`: Wrangler bundled the Worker with the `GROUPS` and `OWNER` Durable Objects and the `OAUTH_KV` namespace; upload about 1.6 MB (about 322 KB gzipped). This command does not deploy.
- `npm audit`: zero reported vulnerabilities at verification time. This does not prove the absence of unknown vulnerabilities.

CI runs `npm ci --ignore-scripts`, an audit at high severity, the full check, and a Wrangler dry-run, with actions pinned to commit SHAs. No deployment step or account credentials are configured. The minimum supported Node version is 22.13.

## Dependency decisions

All dependencies are exact-pinned with an npm lockfile, and every version was at least seven days old when locked. Runtime dependencies are `@cloudflare/workers-oauth-provider` 1.2.3, `@simplewebauthn/server` 14.0.3, `@modelcontextprotocol/server` 2.3.1 and `zod` 4.6.7, all bundled into the Worker; none has an install script. The CLI has no third-party dependencies.

Miniflare 4.20260730.0 is used directly for restart-capable tests. `package.json` overrides `undici` to 7.30.1 across the tree (high-severity advisories published 2026-10-23 affect 7.29.1) and `sharp` to 0.35.5 under that Miniflare. Reevaluate the overrides when upgrading Wrangler or Miniflare.

Reference documentation: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Miniflare Durable Objects](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/), and [current Cloudflare testing guidance](https://developers.cloudflare.com/workers/testing/vitest-integration/). The project uses the direct Miniflare API with Node's test runner.

## Not performed

No Cloudflare deployment, real passkey on a deployed origin, live ChatGPT, dot or Grok connection to this code, model invocation, or chargeable routine test. A throwaway spike of the same connection flow was connected end to end to ChatGPT, a dot and Grok chat on 2026-10-23 (see `tasks/todo.md`); this implementation has not been. Workers Free CPU time per request, KV write volume and Durable Object row writes can only be measured after deploying. Grok Bot is untested; Instinct has no supported integration.

Optional Grok wake tests use explicit offline fake HTTP responses. A 200 only establishes the adapter's `started` state, not an actual bot completion. The project does not claim A2A compliance or runtime egress confinement.
