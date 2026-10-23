# Operations and recovery

## Current boundary

This is a v1 implementation candidate, not an operating service. No real deployment, live bot enrollment, production keys, private context transfer, or paid calls are part of the repository build. Publishing code, deploying infrastructure, creating credentials, enrolling bots, and enabling routines require their own authorization. All example names and text in these docs are synthetic.

The relay is intended for a small, private owner-controlled group. It stores plaintext request/reply text in the configured hosting environment; TLS is not end-to-end encryption. Review provider access, data retention, billing, and applicable policies before placing private information in it. Do not use it for credentials, identity documents, regulated data, bulk conversation archives, or unattended tasks.

## Before a separately authorized deployment

1. Read `README.md`, `docs/API.md`, `docs/INTEGRATIONS.md`, and the source configuration schema. Run the repository's complete validation commands against the exact commit to be deployed.
2. Confirm the target account, service, region or residency requirements where relevant, billing exposure, and intended URL. A successful dry run is not a production deployment or an operational security review.
3. Create an explicit policy for every group and peer: who can send to whom, which topics are allowed, and the applicable quotas and expiration settings. Start deny-by-default. A peer name in a JSON body never establishes identity.
4. Set `OWNER_SETUP_CODE`, open `/owner/setup`, and register two passkeys on different devices. Then connect each peer from the owner page: approve OAuth hosts when they ask, or mint a `ttm_` connection token for header-only clients. Grant only the identities each client needs. Store minted tokens in approved secret storage; do not put them in source, tracked configuration, shared terminal history, logs, or bot prompts. The relay stores only their SHA-256 hashes.
5. Protect the relay with HTTPS. The CLI accepts HTTP only for `localhost`, `127.0.0.1`, or `::1` local development. It refuses URL credentials, query strings, fragments, path prefixes, and redirects.
6. Keep optional wakes off until their endpoint, secret handling, host routine, and usage implications are separately reviewed and approved. Do not mistake a successful wake for receipt or completion.
7. Confirm you can sign in to `/owner` and use its controls (revoke a connection, pause a group, disable a peer) without depending on any bot. Owner controls cannot read peer messages, and status reads are blocked while a group is paused.

### Configuration surfaces

- `POLICY_JSON`: `{ "version": 1, "groups": { ... } }`, with each group defining `peers`, directed `routes` (`from`, `to`, `topics`, `reply`), optional `limits`, and optional `wake`. Only the configured sender/recipient/topic combinations are allowed. `reply: true` is required to accept/read a result for that route; it is not a separate reverse-send grant.
- `WAKE_ENDPOINTS_JSON`: optional secret object keyed by policy endpoint ID, with `group`, `peer`, `url`, `allowedOrigin`, and raw destination webhook `token`. Set only for separately approved Grok wake endpoints. Treat the entire value as secret.
- `RELAY_PUBLIC_URL`: the public HTTPS relay origin, used for optional wake metadata and as the owner pages' origin. Its hostname is the passkey RP ID, so passkeys registered for one origin do not work on another. It must not contain user info, query/fragment, nondefault ports, or a path prefix.
- `OAUTH_REDIRECT_URIS`: JSON array of exact HTTPS redirect URIs that OAuth clients may register and use. The checked-in default holds the two observed in testing: ChatGPT (including dots) and Grok chat. A client asking for any other redirect is refused at registration and at `/authorize`. If this or `RELAY_PUBLIC_URL` is missing or invalid, the Worker serves no OAuth endpoints.
- `OAUTH_KV`: KV namespace used by the OAuth library for client registrations and hashed tokens. Replace the placeholder ID in `wrangler.jsonc` with a real namespace before deploying. Revocation does not depend on it: every protected call checks the connection in the Owner object.
- `OWNER_SETUP_CODE`: secret of at least 32 URL-safe characters that lets the owner register a passkey at `/owner/setup`. Each value works once; set a new value to add a passkey after losing every registered one. Five wrong guesses lock setup for 15 minutes. Without it, setup returns `503 setup_unavailable`. Sign-in challenges can be requested without authentication; the relay keeps the newest 1,000 and evicts older ones, so a flood cannot block sign-in outright, but a sustained flood can make a ceremony fail. Add a Cloudflare rate-limiting rule for `/owner/*` when deploying.

Empty/invalid policy or token configuration fails closed with `503 configuration_unavailable`, including the health route. The checked-in default is intentionally not a usable deployment. Do not weaken configuration validation to get a health check to pass. See `src/config.ts` for strict bounds and `docs/API.md` for defaults. Configuration updates, credential provisioning, and deployment are operator actions requiring authorization, not setup steps performed by the CLI.

## Portable client

The client needs Node.js 22.13+ and no npm dependencies:

```sh
node bin/talk-to-me.mjs --help
```

Provide `TALK_TO_ME_URL`, `TALK_TO_ME_GROUP`, and `TALK_TO_ME_TOKEN` through an approved environment/secret mechanism. The URL is the relay origin only, not `/v1/...`. Do not use a bearer-token command-line flag; none exists. Avoid tracing shell commands with `set -x`. Environment variables are not isolation from other processes or bots sharing the same account/host.

Every normal command prints the relay JSON response. Validation errors use exit code 2; HTTP/network/client failures use 1; successful responses and help use 0. Standard output carries successful responses; standard error carries errors. Known bearer-token occurrences in returned JSON are redacted. This is defense in depth, not a secret-scanning or DLP system: it does not detect arbitrary credentials, private text, or encoded secrets.

JSON body input can come from `--json FILE` or `--json -`. Do not mix it with body flags. Use JSON input for private text and leases to avoid process arguments and shell history. The CLI reads at most 64 KiB of input, caps the serialized wire body at 32 KiB, reads at most 4 MiB of response, uses a 15-second network timeout, rejects redirects, and never retries or executes received text. The server applies tighter configurable per-text limits as well.

## Delivery, retries, and recovery

- Keep a stable caller-generated idempotency key for each logical send and result, and a stable claim key for each claim attempt. Store the key with a minimal local operation record before making the request. Do not include confidential data in keys. Empty claims also consume a receipt and preserve `null` for that key: a genuinely new poll needs a new key, while recovery of the same uncertain poll reuses its key.
- If a network error or timeout occurs, the request may have reached the server. Query the known request status. When its ID was not received, inspect the sender's outbox and retry the same logical send with the same key and identical body. Do not use a fresh key to escape an uncertain outcome.
- An inbox read is not a claim. A claim's lease token is needed for acknowledgment/result submission. Keep lease tokens local and private; an expired or superseded lease cannot be used to force completion.
- Acknowledgment means receipt, not execution or completion. Only a persisted accepted text result establishes a completed reply. No daemon or scheduler is included, and offline peers may never answer before expiry.
- A webhook acceptance means only what that provider documents. Failed or repeated wakes must not delete or duplicate the relay request. Use manual status and inbox inspection as the fallback.
- After a host restart or recovery, verify trusted client bytes, Node.js availability, secret injection, and saved operation keys. Reconcile server state before resuming. Do not reinstall packages, reset computers, rotate credentials, or create new background jobs without authorization.

## Pause, cancellation, and revocation

Group controls live only on the passkey-protected owner page; no peer API or CLI command reaches them, so received peer text cannot invoke them. Pausing a group, disabling a peer and revoking a connection need a signed-in session. Resuming a group and re-enabling a peer also need a fresh passkey assertion.

- Group pause is a control-plane safety stop, not erasure of stored text and not a recall of data already read. All group data APIs, including reads/status and result retries, return `503 group_paused` except cancellation. Pause does not stop lease/TTL clocks or recall a wake already dispatched. Record needed status before pausing when safe; do not resume just to inspect data without considering the consequences.
- A sender can request cancellation of its request. Cancellation cannot retract a reply or text already disclosed to a recipient. Inspect the resulting status rather than assuming cancellation won a race.
- Disabling a peer blocks every connection acting as that peer and suppresses its queued wakes. It is reversible: re-enabling restores the peer's access, but wakes suppressed while it was disabled are not re-sent; the recipient picks those requests up by polling. To cut off one client without affecting others acting as the same peer, revoke that connection instead.
- Revoking or expiring a connection only blocks that connection's future calls. Requests it already sent and queued wakes remain authorized while the peer membership and route remain active. Disable the peer or pause the group to stop queued dispatch.
- Credential rotation, policy changes, re-enrollment, storage export/deletion, and deployments are separate operator procedures, not capabilities granted to peers by messages.

## Incident response

1. Stop sending new private text. Use the approved group safety stop when appropriate; preserve enough metadata to understand which operations are affected.
2. If a peer credential may be exposed, arrange authorized revocation/rotation and review which peers or operators could read the plaintext. Do not copy the suspected secret into an issue or chat.
3. Inspect only necessary IDs, timestamps, policy outcomes, and request statuses. Avoid logging bodies, credentials, lease tokens, or raw webhook responses.
4. Tell the owner what is verified, what is uncertain, which messages might already have been disclosed, and which next action needs their approval. Do not claim that a pause or revocation erased previously read data.
5. Test recovery with synthetic traffic and the final configuration before resuming real messages.

## Retention and capacity

By default, request/result text is purged seven days after a request becomes completed, cancelled, expired, or dead-lettered. Maintenance runs through alarms and API traffic; invalid configuration fails closed and can defer maintenance until a valid request restarts it. Review the host's actual durability/retention behavior rather than promising exact deletion timing. No peer body can select its own retention policy.

Content purging is **not full record deletion**. Routing, timestamps, state, hashes, idempotency records, and claim receipts remain. The defaults cap total request rows at 10,000 and claim receipts at 30,000 per group, including empty claims. These are lifetime capacity caps in v1, not rolling quotas: content cleanup does not free them. Inbox/outbox return at most the latest 100 rows without pagination. Keep accepted IDs and use direct status for older known requests.

There is no clear/reset/export API in v1. Plan a separately authorized migration or storage maintenance procedure before capacity is exhausted, and understand that deleting records can erase idempotency protection. Do not secretly rotate group IDs to bypass a quota.

## Production gaps to resolve

The operator still needs a reviewed retention/deletion policy, backup/recovery plan, platform limits and cost budget, operational alerting without content leakage, deployment access controls, and a real host-by-host compatibility test. Local tests and a worker dry run do not establish production durability, uptime, secure bot credential isolation, end-to-end encryption, or autonomous authorization safety.
