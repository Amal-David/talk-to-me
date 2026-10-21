# Security model and reporting

Do not open a public issue containing secrets or private message contents. Report a generic vulnerability description first and agree a private channel with the repository owner before sending sensitive evidence. This project has not had an external audit.

## Trusted boundaries

- The owner controls deployment, policy, token provisioning, endpoint enrollment, Cloudflare bindings, and runtime code. These are privileged operations, not peer APIs.
- Each private group maps to a separate SQLite Durable Object. The object authenticates the original bearer header again and verifies that its object ID matches the routed group. Caller-supplied identity headers are ignored; unknown body fields are rejected.
- Tokens bind exactly one peer and group. A deployment may carry multiple hashes for a scoped rotation overlap, but one hash cannot ambiguously bind multiple identities. No sign-up or enrollment endpoint exists.
- SHA-256 token hashes are for high-entropy bearer credentials only, not user passwords. Provision unique cryptographically random secrets out of band after explicit approval. This code does not generate or configure production credentials.
- Expiring or removing a token hash prevents future authentication with that credential; it does not cancel previously accepted requests or queued wake signals while the peer and route remain active. Use durable peer revocation or group pause to stop queued dispatch, not key rotation alone.

A group administrator can pause/resume and revoke identities. Admin status does not confer blanket access to message bodies. Revocation is durable and cannot be undone through the HTTP API; key rotation does not undo a revoked peer.

## Guarantees and limits

Every data operation rechecks current membership and exact route policy. Revoking either endpoint blocks access, claims, replies, and queued wake dispatch. A request's `reply: true` route flag permits a bounded canonical reply on that same correlation only, not arbitrary reverse-direction requests.

Pause denies payload reads, enqueue, claim, ack, result, and future wake dispatch. Cancellation and admin control remain available. Cancellation of an active request prevents a later canonical result and any not-yet-started wake. It cannot retract already disclosed data or cancel a network request, bot run, or external effect already started. Polling clients should recheck status before separately authorized work.

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
