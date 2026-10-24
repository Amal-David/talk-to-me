# Plan: passkey-approved connections

Status: draft, awaiting owner approval. Nothing below is built.

## Goal

Connecting an agent (OpenAI Dots, Grok Bot, the CLI) to the relay takes one approval from the owner, made with the owner's passkey on the relay's own page. No secret is generated, hashed, pasted into config, or redeployed by hand. After approval, messages flow without further prompts. The passkey is needed again only to grant access: approve a connection, mint a token, add a passkey.

## Acceptance criteria

1. **Dots connects with one approval.** Adding `https://<relay>/mcp` as a ChatGPT developer-mode connector opens the relay's approval page. After one passkey touch and choosing the agent identity, a dot can call `check_inbox` and `send_message`. No secret was copied by hand.
2. **Nobody else can create a connection.** An approval without a valid passkey assertion is rejected. An authorization request whose redirect URI is outside the owner's allowlist is rejected before the page renders. A passkey assertion made for one approval cannot be used for another.
3. **Revocation is immediate and reversible.** Revoking a connection on the Connections page makes its next call fail, with no propagation delay. Approving the same host again works; the agent's identity is not burned.
4. **Header-only hosts work.** A host that only accepts a static header (Grok Bot's plugin form, the CLI) works with a connection token minted from the Connections page. The token is shown once, expires on the chosen date, and is revocable like any other connection.
5. **Relay behavior is unchanged.** Every existing lifecycle, lease, retry, expiry and wake test passes with the new authentication.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Owner authentication | WebAuthn passkeys stored by the relay; at least two registered | Phishing-resistant and bound to the relay's domain. A TOTP code can be relayed by a fake page. |
| Fallback sign-in | None (no password, email code or SMS) | Any fallback becomes the weakest way in. |
| First passkey | One-time `OWNER_SETUP_CODE` Cloudflare secret, consumed on first registration | Bootstraps without a public sign-up endpoint. Anyone who can set Cloudflare secrets already controls the relay. |
| Approval granularity | Once per connection, not per message | The connection is scoped to one agent identity, its policy routes and an expiry. Per-message approval belongs to the receiving agent's own rules. |
| Granting vs reducing access | Granting (approve, mint token, add passkey) needs a fresh passkey assertion bound to that action. Reducing (revoke, pause, disable peer) needs a signed-in owner session. | A stolen session can only lock things down, never open them. |
| OAuth server | `@cloudflare/workers-oauth-provider` in single-Worker `OAuthProvider` mode | OAuth 2.1, S256 PKCE, RFC 9728 resource metadata, CIMD and DCR, refresh rotation with retry grace, RFC 9207 `iss`. No runtime dependencies. |
| Client registration | DCR on: ChatGPT and Grok chat both used it in Phase 0. CIMD off until a deployed Worker can fetch `https://chatgpt.com/oauth/client.json` (local fetch got 403). | Both real hosts registered through DCR. MCP 2026-07-28 deprecates DCR, so turn CIMD on once it works from production. |
| Redirect URIs | Owner allowlist in config, checked in `/authorize` for every client and in `clientRegistrationCallback` for DCR. Exactly `https://chatgpt.com/connector_platform_oauth_redirect` and `https://grok.com/connectors-oauth-exchange-code/` (observed in Phase 0). | Stops consent phishing: a link that would send the token to someone else's client is refused before an approval page renders. A client name or ID alone proves nothing. |
| Connection records | One `connections` table in the `Owner` Durable Object for both kinds (OAuth, token). Every call checks it. | The OAuth library validates tokens through KV with a ~60 s edge cache, so its revocation lags. The Durable Object is strongly consistent, which makes revocation immediate. |
| Where identity is checked | Only in the Worker. The group Durable Object receives the authenticated principal through an RPC method, not a `fetch` header. | RPC methods cannot be called from the internet, so there is no header to spoof. Removes today's double authentication. |
| `AUTH_TOKENS_JSON` and admin bearer tokens | Removed | v0.1 never shipped. Connection tokens replace the registry; admin actions move to passkey-protected owner pages. |
| Peer revocation | Becomes reversible "disable peer" on the owner pages | Irreversibility existed so a leaked admin token couldn't undo a revocation. Admin actions now need the owner's passkey. |
| Routes and topics | Stay in `POLICY_JSON`, changed by redeploy | Editing policy in the UI is separate work. The approval page reads policy to show what a connection will be able to do. |
| MCP server | `@modelcontextprotocol/server` `createMcpHandler`, stateless | Serves both the 2026-07-28 protocol and older `initialize` clients without a Durable Object. 3 packages, no install scripts. `agents` pulls ~200 packages with install scripts; SDK v1 is maintenance-only and won't get 2026-07-28. |
| Passkey verification | `@simplewebauthn/server` on the Worker; plain `navigator.credentials` with `PublicKeyCredential.parseCreationOptionsFromJSON` in the page | No browser library. Needs Chrome 129+, Firefox 119+, Safari 18.4+. |
| CLI | Kept; `TALK_TO_ME_TOKEN` holds a connection token | Useful for scripts and tests; no new client code. |

## Library facts (checked 2026-10-22)

The 7-day cooldown cutoff is 2026-10-15. Pin exact versions.

| Package | Version | Published | Resolved packages | Install scripts |
|---|---|---|---|---|
| `@cloudflare/workers-oauth-provider` | 1.2.3 | 2026-10-07 | 1 | none |
| `@modelcontextprotocol/server` | 2.3.1 | 2026-10-05 | 3 (`core` 2.3.1, `zod` 4.6.7 from 2026-10-12) | none |
| `@simplewebauthn/server` | 14.0.3 | 2026-09-25 | 25 | none |

- `@simplewebauthn/server` resolves `asn1js@3.1.0` (2026-10-16, inside the cooldown). Add `"overrides": { "asn1js": "3.0.10" }` or install with `--before=2026-10-15`. `@peculiar/x509@2.2.0` is exactly 7 days old.
- The relay goes from 0 runtime dependencies to about 29 resolved packages, nearly all from `@simplewebauthn/server`.
- The OAuth library needs a KV namespace bound as `OAUTH_KV` (hard-coded; no Durable Object option) and the compatibility flag `global_fetch_strictly_public` for CIMD.
- KV stores only hashes of tokens, codes and client secrets; `props` are encrypted with keys wrapped by the token. Grant `userId` and `metadata` are plaintext.
- Per-grant expiry is set through `tokenExchangeCallback` returning `refreshTokenTTL` at code exchange; `completeAuthorization` has no TTL field.
- `completeAuthorization` revokes earlier grants for the same `userId`, client and resource by default (for CIMD, same redirect URI too). `userId` must not contain `:`. Use `userId = "<group>/<peer>"` so reconnecting the same host as the same agent replaces the old grant, and different agents never collide.
- `@simplewebauthn/server` claims Workers support and its ESM build imports no Node built-ins, but nobody has run it in workerd. Phase 1 proves it before anything else depends on it.
- `@modelcontextprotocol/server` types reference `Buffer`; type checking may need `"types": ["node"]`.

## Design

### Components

- **Worker entry**, wrapped by `OAuthProvider`:
  - `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/authorize`, `/token`, `/register`: OAuth (library).
  - `/mcp`: MCP endpoint (`apiHandler`). Accepts OAuth access tokens, and connection tokens through `resolveExternalToken`.
  - `/v1/groups/:group/*`: existing relay API for the CLI. Accepts connection tokens.
  - `/owner/*`: setup, sign-in, approval and Connections pages (server-rendered HTML, no framework).
- **`Owner` Durable Object** (single instance, SQLite): passkey credentials and counters, single-use challenges, owner sessions, `connections` (id, kind, group, peer, label, token hash, expires, revoked), setup-code consumption.
- **`GroupMailbox` Durable Object**: unchanged storage and lifecycle. Gains RPC `call(principal, method, path, body)`; loses its own bearer authentication and the `/control` route.

### Connecting an OAuth host (Dots; Grok if it supports OAuth)

1. Host calls `/mcp` and gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
2. Host reads the metadata, identifies itself (CIMD document or DCR), and opens `/authorize` with S256 PKCE and `resource`.
3. `/authorize` runs `parseAuthRequest`, refuses a redirect URI outside the allowlist, then `beginConsent`.
4. The approval page shows: client name (marked self-reported), redirect host (prominent), a selector for the agent identity, that identity's routes under current policy, and an expiry (7, 30 or 90 days).
5. **Approve with passkey** requests a challenge bound to `{consent handle, peer, expiry}` and runs `navigator.credentials.get`.
6. The Worker verifies the assertion (user verification required, origin and RP ID exact, counter advances), consumes the challenge, writes a `connections` row, then `approveConsent` → `completeAuthorization` with props `{ connectionId, group, peer }` and `userId = "<group>/<peer>"`.
7. `tokenExchangeCallback` sets the refresh-token lifetime to the chosen expiry.

### Connecting a header-only host (Grok Bot plugin form, CLI)

On the Connections page: choose identity, label and expiry, approve with passkey, get `ttm_<32 random bytes, base64url>` shown once. Only its SHA-256 hash is stored in `connections`.

### Every API or MCP call

1. The Worker resolves the bearer: OAuth token through the library (props carry `connectionId`), or a `ttm_` token by hash lookup in the `Owner` object.
2. The `Owner` object confirms the connection is unrevoked and unexpired. This is the authoritative revocation check.
3. The Worker calls `GroupMailbox.call({ group, peer, connectionId }, …)`. The mailbox keeps its per-request membership, route, pause and rate checks.

Revoking a connection marks the row revoked (effective on the next call) and also calls `revokeGrant` to clean up KV.

### Owner session

Cookie `__Host-ttm_owner`, `HttpOnly; Secure; SameSite=Strict; Path=/`, 15-minute lifetime, random ID stored hashed. State-changing owner requests also require a matching `Origin` header. Approval pages are reached by a cross-site redirect from the host, where a `SameSite=Strict` cookie is not sent; that's fine, because approval requires a fresh passkey assertion anyway.

### MCP tools

`send_message`, `check_inbox`, `claim_next`, `reply`, `get_status`, `cancel`, `list_sent`. Each maps to one existing relay operation. Idempotency and claim keys are optional; when omitted the server generates one and returns it so a retry can reuse it. Tool output marks message text as untrusted, as the API does today.

## Phases

Each phase ends with `npm run check` and `npm run dry-run` passing and a commit. Nothing is deployed without separate approval.

### Phase 0: confirm host behavior (throwaway spike)

- [x] Minimal Worker: `OAuthProvider` + passkey approval + one `ping` tool, served from `wrangler dev` through a temporary `cloudflared` tunnel (local KV, no Cloudflare deploy). Code: `spike/phase0/`.
- [x] ChatGPT developer mode: add the connector, approve, call `ping` from a chat. Done 2026-10-23.
- [x] A dot calls `ping`. Done 2026-10-23: the dot replied `pong (via oauth, 2026-10-23T06:27:30.360Z)`, matching the server log.
- [x] Grok chat (grok.com, free tier): custom connector, approve, call `ping`. Done 2026-10-23.
- [ ] Grok Bot: needs Grok Premium, which the owner's account doesn't have. Untested; its plugin form reportedly takes headers, so it is the only remaining case for the connection-token path.
- [x] Record per host (ChatGPT below).
- Needs the owner to click through ChatGPT and Grok. Exit: findings written into this file; redirect allowlist and DCR decision settled.

#### Phase 0 outcome

- Exit criteria met for ChatGPT, dots and Grok chat. Grok Bot is untested (needs Premium).
- DCR stays on; CIMD waits for a production check. The redirect allowlist is the two observed URIs.
- Both hosts refresh tokens far more often than the access-token lifetime requires, so refresh must be cheap and tolerate rapid repeats.
- The server must serve both MCP protocol eras: ChatGPT uses 2026-07-28, Grok chat uses 2025-11-25.
- The connection-token (header) path is now needed only for Grok Bot and the CLI.

#### Findings: ChatGPT (2026-10-23)

- **End to end works.** Passkey approval → code exchange → `server/discover` → `tools/list` → `tools/call ping` returned `pong (via oauth, …)` in a chat.
- **Registration: DCR.** One registration per connector: `client_name: "ChatGPT"`, redirect `https://chatgpt.com/connector_platform_oauth_redirect`, public client (`token_endpoint_auth_method: none`), grants `authorization_code` + `refresh_token`.
- **CIMD blocked locally.** Fetching `https://chatgpt.com/oauth/client.json` from `wrangler dev` returns 403; curl and Node with identical headers get 200. Likely bot protection on the runtime's connection. Recheck from a deployed Worker before relying on CIMD; until then DCR stays on.
- **Authorize request.** `response_type=code`, PKCE S256, `state`, `resource` = the `/mcp` URL, `scope` = the connector's default scopes (`relay`), plus `ui_locales`. No `offline_access` requested.
- **Token requests.** Public client, no client authentication; `resource` sent on both code exchange and refresh; `scope` omitted.
- **Refresh.** Works without `offline_access` (the library issues refresh tokens anyway). ChatGPT refreshed twice within 6 s of the code exchange, then again after the 120 s access token expired, right before the tool call. Refresh rotation must tolerate rapid repeats; the library's previous-token grace covers that.
- **MCP protocol.** ChatGPT speaks 2026-07-28: `server/discover`, then `tools/list` and `tools/call` with `Mcp-Method`/`Mcp-Name` headers. Tool calls carried user agent `openai-mcp/1.0.0 (Codex)`. Unauthenticated discovery probes come from `Python aiohttp`. It also probes `/.well-known/openid-configuration` (404 is fine).
- **UI trap.** In Plugins, the list pop-up's **Continue** fails with "This app does not provide a browser setup URL right now" and never contacts the server, even with MFA on. The **Connect** button on the connector's own page works. Put this in the setup guide.
- **Redirect allowlist** starts as exactly `https://chatgpt.com/connector_platform_oauth_redirect`.
- **Dots use the same connector.** No separate setup: the connector installed under Plugins worked from the dot's first message. Dot calls carry user agent `openai-mcp/1.0.0` (chat calls add `(Codex)`), and each call was preceded by a token refresh once the 120 s access token had expired.
- **A dot appears to call tools on its own.** At 06:15:30, 12 minutes before it was asked, a call with the dot's user agent ran `ping`, and the dot then posted a summary of the connection to its feed. Unconfirmed whether the owner triggered it. Once the relay exposes `send_message` and `reply`, a dot may use them proactively. Tool annotations should mark sending as a write, and the setup guide should tell the owner to set the connector's ChatGPT permission to ask before write actions.

#### Findings: Grok chat (2026-10-23)

- **End to end works.** Passkey approval → code exchange → `initialize` → `tools/list` → `tools/call ping` (200).
- **Connector form has no auth fields.** Plugins → New Connector → Custom takes only a name and server URL, so Grok chat relies entirely on OAuth discovery.
- **Validation probes first.** Before OAuth, Grok sends unauthenticated `initialize` requests from three clients (`grok-connectors-manager/0.1.0` with protocol 2025-11-25, `grok-validator` with 2025-03-26, `Go-http-client/2.0`) and a `GET /mcp`. All got the `401` challenge and Grok proceeded to discovery.
- **Registration: DCR.** `client_name: "Grok"`, redirect `https://grok.com/connectors-oauth-exchange-code/` (trailing slash), public client, grants `authorization_code` + `refresh_token`. CIMD was not advertised, so whether Grok would use it is unknown.
- **Authorize request.** PKCE S256, `state`, `resource` = the `/mcp` URL, and `scope=relay offline_access`. Unlike ChatGPT, Grok asks for every scope in the authorization server's `scopes_supported`, including `offline_access`.
- **Token requests.** Public client, no client authentication; `resource` sent; `scope` omitted.
- **Refresh is constant.** Grok refreshed five times in under two minutes, mostly while the access token was still valid, roughly once per MCP session. Refresh rotation with the library's previous-token grace is required, and per-refresh work in `tokenExchangeCallback` must stay cheap.
- **MCP protocol.** Grok speaks the 2025-era protocol (2025-11-25): a fresh `initialize` + `notifications/initialized` before each `tools/list` or `tools/call`. The SDK's stateless legacy mode serves it without changes.
- **Redirect allowlist** adds exactly `https://grok.com/connectors-oauth-exchange-code/`.

#### Findings: passkeys and tooling

- `@simplewebauthn/server@14.0.3` registered and verified a synced passkey (`multiDevice`, backed up, user verified) inside workerd. Phase 1's main library risk is retired.
- `wrangler dev` rewrites response headers that mention the request host to the proxy's scheme, which turned `WWW-Authenticate` into `http://`. `--local-protocol https` fixes it. The dev server also exposes an admin API on the same port (refuses non-local Host; disable with `X_LOCAL_EXPLORER=false`).
- The main repo pins `wrangler@4.151.3`, published 2026-10-20, inside the 7-day cooldown. Re-pin when Phase 1 starts.

### Phase 1: owner identity

- [x] Add `@simplewebauthn/server@14.0.3`; proved it verifies a registration inside Miniflare before building on it. No override needed: installing with `--before=2026-10-16` resolved `asn1js@3.0.10`.
- [x] `Owner` Durable Object (`src/owner.ts`) and migration `v2`. Pages in `src/owner-pages.ts`.
- [x] Setup page: `OWNER_SETUP_CODE` (32+ URL-safe characters), compared by SHA-256 hash in constant time, 5 failed guesses per 15 minutes; each code value works once, so a new value is the recovery path.
- [x] Sign-in, 15-minute `__Host-` session (`HttpOnly; Secure; SameSite=Strict`), sign-out; add another passkey after a fresh step-up assertion.
- [x] Software authenticator in `tests/helpers.mjs`; `tests/owner.test.mjs` covers wrong origin, wrong RP ID, missing user verification, replayed and cross-purpose challenges, non-advancing counter, reused and guessed setup codes, Origin checks, sign-out, fail-closed config, and a challenge flood that must not lock the owner out.
- Also: re-pinned `wrangler` and `@cloudflare/workers-types` under the cooldown, and the test build now resolves packages the way Workers does (`--main-fields=module,main --conditions=workerd,worker,browser`).
- The relay origin comes from the existing `RELAY_PUBLIC_URL`; the passkey RP ID is its hostname.

### Phase 2: OAuth approval and Connections page

- [x] Add `@cloudflare/workers-oauth-provider@1.2.3` and the `OAUTH_KV` binding. Skipped the `global_fetch_strictly_public` flag: it is only needed for CIMD, which stays off after Phase 0.
- [x] Redirect allowlist `OAUTH_REDIRECT_URIS` (exact URLs, JSON array) validated in `config.ts`; enforced at client registration and again at `/authorize` before the approval page renders. Without a valid relay origin and allowlist the Worker exposes no OAuth endpoints.
- [x] `/authorize` approval page: the owner picks the peer and an expiry (7, 30 or 90 days) and approves with a passkey whose challenge is bound to the consent handle. The assertion is checked before the consent is consumed, so a failed touch can be retried. `tokenExchangeCallback` sets the refresh lifetime to the connection's expiry and refuses refresh (`invalid_grant`, which also deletes the grant) once the connection is revoked.
- [x] Connections page (on `/owner`): list live connections, revoke, and mint a `ttm_` connection token behind a fresh step-up. Revocation lives in the Owner object and is checked on every `/mcp` call.
- [x] `/mcp` answers with the connection's identity as a placeholder until Phase 4 adds the MCP tools.
- [x] Tests (`tests/oauth.test.mjs`): full DCR + PKCE + passkey + code exchange flow; disallowed redirect refused at registration; approval without an assertion, with another consent's assertion, for an unknown peer or cross-site all refused; revoked connection refused on the next call and on refresh; reconnecting replaces the earlier connection; connection tokens need the mint step-up and stop when revoked. Each guarded rule was mutation-checked.
- Not done: deleting a revoked grant's KV records immediately. The Owner check makes them useless at once, and the next refresh deletes them.

### Phase 3: move authentication into the Worker

- [x] `GroupMailbox` has no fetch handler: the Worker calls `handle(request, principal)` over RPC with the resolved group and peer. Its bearer check, admin role and `/control` route are gone; cancel is sender-only.
- [x] `/v1` accepts only `ttm_` connection tokens, resolved through the Owner object. Unknown, revoked or expired tokens get 401; a token for another group gets 404. The CLI is unchanged apart from its help text.
- [x] Owner page group controls: pause/resume a group, disable/enable a peer, through `GroupMailbox.control()` RPC. Pause and disable need a session; resume and enable also need a fresh passkey assertion. Disabling a peer is now reversible.
- [x] Removed `AUTH_TOKENS_JSON`, the `Token` type, `authenticate()` and their config validation.
- [x] Test fixture seeds deterministic synthetic `ttm_` tokens through the Owner object's RPC (no passkey ceremony) and calls `control()` directly for mailbox tests; the owner pages' control authorization has its own test. The former token-registry tests became tests of what replaced them: cross-group and unknown/expired tokens on `/v1`, and the OAuth redirect allowlist parser. Cross-group, restore step-up and expiry rules were mutation-checked.

### Phase 4: MCP endpoint

- [x] `@modelcontextprotocol/server@2.3.1` and `zod@4.6.7` (both past the cooldown, no install scripts). `createMcpHandler` serves `/mcp` statelessly for the 2026-07-28 protocol (ChatGPT) and 2025-era clients (Grok), with a 64 KB body cap.
- [x] Eight tools in `src/mcp.ts`: the planned seven plus `who_am_i`, which tells an agent its group, peer and allowed recipients and topics. Each tool is one relay API call through `GroupMailbox.handle` as the connection's peer, so no mailbox rule is reimplemented. Keys are generated and returned when omitted. Request IDs are checked against the identifier rule before entering a URL path.
- [x] Annotations: read tools are `readOnlyHint: true`; sending, claiming, replying and cancelling are writes, so hosts can ask before acting. Writes are not marked idempotent, because repeating one without its key acts again; only cancel (destructive) is. Tool descriptions say message text is untrusted data.
- [x] Tests (`tests/mcp.test.mjs`): tool listing and annotations on both protocol eras; a two-agent send → inbox → claim → reply → status round trip, including a retry that does not resend; refusals as tool errors; identity cannot be borrowed through extra arguments; crafted request IDs rejected. Annotations, caller identity and retry safety were mutation-checked. The OAuth tests now check identity through `who_am_i`.
- Bundle grew to about 1.6 MB (322 KB gzipped), mostly zod and the MCP library.

### Phase 5: deploy and real-host verification

Nothing in this phase runs against Cloudflare, ChatGPT or Grok without the owner's go-ahead for that step.

#### Decisions the owner makes first

1. **Hostname.** A name on a zone already in the Cloudflare account, for example `relay.<your-domain>`. Passkeys are bound to it: moving later means registering new passkeys and reconnecting every host. Fallback: the account's `workers.dev` subdomain, with the same lock-in.
2. **Workers plan.** The OAuth library writes to KV on every token refresh, and Phase 0 saw Grok refresh about five times in two minutes. Workers Free allows 1,000 KV writes a day, which active use can exhaust; Workers Paid ($5/month) allows 1,000,000. SQLite Durable Objects work on both.
3. **Policy (`POLICY_JSON`).** Which agents exist and who may message whom on which topics. Proposed starting point: one group `personal` with peers `dots`, `grok` and `cli`, routes in both directions between every pair on topic `general`, replies allowed.
4. **Deploy source.** Merge this branch to `main` through a reviewed PR and deploy from `main`, or deploy from the branch commit and merge after verification.

#### Decided (2026-10-24)

- **Hostname:** the account's `workers.dev` subdomain. Its exact address is printed by the first deploy, so the first deploy is followed by a second with `RELAY_PUBLIC_URL` set, before any passkey is registered. No zone permission is needed.
- **Plan:** Workers Free. Two limits to watch: 1,000 KV writes a day (OAuth refreshes write to KV) and 10 ms of CPU per request (passkey verification, OAuth crypto and the 1.6 MB bundle may exceed it; it shows up as error 1102). Check both right after deploying; moving to Workers Paid is the fix for either.
- **Policy:** group `personal`, peers `dots`, `grok`, `cli`; routes in both directions between every pair on topic `general`, replies allowed.
- **Source:** push the branch, open a reviewed PR, merge to `main`, deploy from `main`.

#### What the owner does (needs their accounts or devices)

- Generate and store `OWNER_SETUP_CODE` without it passing through chat (commands below), then register two passkeys at `https://<host>/owner/setup` on different devices.
- In ChatGPT: delete the spike connectors, add `https://<host>/mcp`, use the connector page's **Connect** button, approve as `dots`. In Grok: delete the spike connector, add the same URL, approve as `grok`.
- Delete the spike passkey (for the old trycloudflare address) from the password manager.
- Not available on `workers.dev`: a Cloudflare rate-limiting rule on `/owner/*` needs a zone. The relay's own limits still apply (5 setup-code guesses per 15 minutes, newest 1,000 challenges kept); moving to a custom domain later would allow the rule.
- Optional: Grok Premium, to test Grok Bot with a `ttm_` token in its header field.

#### What Claude does (each outward step confirmed first)

1. [x] Before touching Cloudflare: pinned `actions/checkout` and `actions/setup-node` to the v4.4.0 commit SHAs; CI runs `npm ci --ignore-scripts` (a clean install that way passes all tests and the dry-run); added `.claude/` to `.gitignore`; updated README, REVIEW and the skill. Also fixed CI's audit gate: high-severity undici advisories published 2026-10-23 hit the repo's pinned `undici@7.29.1` (on `main` too); a repo-wide override now pins `undici@7.30.1` (published 2026-10-15, past the cooldown).
2. Create the KV namespace `talk-to-me-oauth` and put its ID in `wrangler.jsonc`; turn on `workers_dev`; set the agreed `POLICY_JSON`; deploy once to learn the address, then set `RELAY_PUBLIC_URL` to it and redeploy; commit.
3. `wrangler deploy`, then check from outside: `/health`, both metadata documents, `401` with the right `resource_metadata` on `/mcp`, and whether the deployed Worker can fetch ChatGPT's client document (decides if CIMD can be turned on).
4. After the owner's passkeys and connections: a synthetic round trip `dots` → `grok` through the tools, a CLI round trip with a minted `ttm_` token, then revoke one connection and disable one peer and confirm both are refused on the next call.
5. Record results here and update the integration status table.

#### Things that are hard to undo

- Passkeys and host connections are bound to the hostname.
- Durable Object migrations `v1` and `v2` are applied on first deploy; deleting the Worker deletes all mailbox and owner data.
- Message text is stored in plaintext in Cloudflare until seven days after a request finishes.

## Out of scope

- Instinct: no API, MCP support or webhooks.
- Editing routes and topics from the UI.
- Waking a dot from outside. Dots has no inbound trigger; it can check its inbox on a schedule.
- Per-bot isolation on Grok or ChatGPT: connectors are account-wide on both, so one connection means one account.

## Open items for the owner

- The custom domain for the relay. Passkeys are tied to it; moving domains later means registering new passkeys.
- The Cloudflare account to deploy to (needed at Phase 5 only).

## Risks

- Grok Bot may ignore OAuth. The connection-token path covers it.
- ChatGPT's redirect URI may change (it already has two forms). The allowlist is config; a refused approval names the refused origin.
- OpenAI's docs reportedly want `offline_access` advertised for refresh to work, which conflicts with MCP's guidance. Phase 0 settles it with a real expiry.
- `@simplewebauthn/server` on workerd is unproven; Phase 1 tests it first. If it fails, the fallback is verifying ES256 assertions directly with WebCrypto (registration with `none` attestation only), which is small but security-critical code.
- Every call adds one hop to the single `Owner` object. Fine at personal scale; revisit if traffic grows.
