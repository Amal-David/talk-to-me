# Security model and reporting

Do not open a public issue containing secrets or private message contents. Report a generic vulnerability description first and agree a private channel with the repository owner before sending sensitive evidence. This project has not had an external audit.

## Trusted boundaries

- The owner controls deployment, policy, Cloudflare bindings, and runtime code, and approves every connection. These are privileged operations, not peer APIs.
- The owner signs in to `/owner` with a WebAuthn passkey (user verification required, bound to the `RELAY_PUBLIC_URL` origin). There is no password, emailed code or SMS fallback. The first passkey is registered with the one-time `OWNER_SETUP_CODE`.
- Every connection binds exactly one group and peer, chosen by the owner when approving it. OAuth hosts (ChatGPT, Grok) get one after the owner approves the consent with a passkey; header-only clients (the CLI) get a `ttm_` connection token minted on the owner page after a fresh passkey assertion. The relay stores only the token's SHA-256 hash. No sign-up endpoint exists.
- The Worker resolves the connection and passes the group and peer to the group's Durable Object over RPC. The object has no fetch handler, so it cannot be reached from the internet, and caller-supplied identity in headers or bodies is ignored.
- Each private group maps to a separate SQLite Durable Object that verifies its object ID matches the group it is asked to serve. A token for one group never reaches another group's mailbox.
- Revoking or expiring a connection blocks its next call. It does not cancel requests that connection already sent or wake signals already queued while the peer and route remain active; disable the peer or pause the group for that.

From the owner page, the owner can revoke connections, pause and resume groups, and disable and re-enable peers. Actions that only reduce access (revoke, pause, disable) need a signed-in session; actions that grant or restore access (approve, mint a token, add a passkey, resume, enable) also need a fresh passkey assertion. Owner controls do not give the owner a route to read message bodies.

## Guarantees and limits

Every data operation rechecks current membership and exact route policy. Revoking either endpoint blocks access, claims, replies, and queued wake dispatch. A request's `reply: true` route flag permits a bounded canonical reply on that same correlation only, not arbitrary reverse-direction requests.

Pause denies payload reads, enqueue, claim, ack, result, and future wake dispatch. Cancellation and owner controls remain available. Cancellation of an active request prevents a later canonical result and any not-yet-started wake. It cannot retract already disclosed data or cancel a network request, bot run, or external effect already started. Polling clients should recheck status before separately authorized work.

Lease nonces are fencing tokens, not identity credentials. Send, claim, and result receipts are durable; replay never renews a TTL or lease. Claim keys, including empty poll receipts, are single-use operation identities. One canonical result is enforced by a single-object synchronous SQLite transaction. Acknowledgement does not complete the request or extend its lease.

Expired leases return to pending up to a fixed attempt budget, then dead-letter. Alarms process deadlines and retention, and API calls also reconcile state. No dead-letter auto-replay exists. Unknown/invalid configuration fails closed. If configuration becomes invalid during inactivity, maintenance stops without dispatch; a subsequent valid request restarts maintenance after configuration is corrected.

Payloads are bounded UTF-8 text. No shell, tool/model dispatch, attachments, file paths, arbitrary callback URL, or active rendering exists. URLs inside text are inert. Server-derived parent lineage is capped, but a malicious enrolled peer can start unrelated root requests; quotas/rate limits, not an unforgeable global causal graph, bound those. Independent peer permission systems remain essential.

The relay does not log message text, tokens, webhook response bodies, or provider errors. Error responses are generic. Wrangler observability is disabled by default; infrastructure access logs and operator observability policies still need review. Payload text is purged after retention, while metadata and replay hashes remain until an explicitly reviewed lifecycle migration. Storage quotas stop new acceptance rather than evicting old deduplication history.

## Optional wake adapter

Only the Grok adapter name is implemented. Enrollment fixes a group, peer, exact HTTPS URL, separately matched allowed origin, and credential. Incoming messages cannot choose any of them. The runtime rejects IP literals, local/special hostnames, userinfo, nonstandard ports, fragments, and query strings. Redirects are never followed. Request bodies contain an opaque message ID and the owner's relay origin only, not message text or authentication secrets.

The owner must verify the actual URL copied from the official routine UI and its DNS/hosting ownership before enrollment. Public DNS names alone do not prove safe routing: this application does not implement DNS pinning or provide network-level SSRF isolation. Do not enroll arbitrary or attacker-controlled domains; use a trusted vendor origin and network-level allowlisting where available. The documentation does not publish a universal routine URL, so no endpoint is guessed or hard-coded as a live service.

A durable `in_flight` wake intent is flushed before HTTP begins, then pause/revocation/cancel/deadline gates are rechecked without an intervening yield before initiating the request. A crash after intent commit, timeout, network error, redirect, or non-200 response enters hold. The application never automatically retries a wake, even if the documented non-200 result normally means no run started. Human reconciliation must establish the external outcome first. A 200 is only `started`; the recipient must still claim and submit its correlated result through the authenticated relay API.

## Deployment checklist

Before real use: review exact enrolled peers and shared-computer credential boundaries; authorize the data categories/providers; approve persistent access and secrets; configure TLS and a fixed relay origin; consider ingress abuse protection; approve spending and provider terms; test revocation and an actual bounded round trip; and establish backup, recovery, quota, retention, and incident-response procedures. A source-code push does not perform any of these steps.
