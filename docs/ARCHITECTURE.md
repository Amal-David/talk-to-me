# Engineering flow

## Components

- The edge Worker validates deployment policy, hashes the bearer credential, resolves its exact group/peer, and routes only authenticated traffic.
- `GroupMailbox` is a SQLite-backed Durable Object named by private group ID. It verifies that the requested group maps to its own object ID and authenticates the original bearer header again. No internal identity header is trusted.
- The SQLite `requests` table is both the sender outbox and recipient inbox, viewed through separate authorization predicates. One row contains the canonical request and optional final result so completion is atomic, not a cross-service write.
- `claims` stores stable operation receipts and fencing nonces. Empty polls also have durable receipts. `wakes` is the optional external-effect outbox. `revoked`, `settings`, `rates`, and metadata-only `events` implement controls and bounds.
- The CLI and skill are portable clients. They do not hold authoritative shared state, run a daemon, execute received text, or create provider capabilities.

No D1, Queues, R2, service discovery, universal bot credential, private provider API, or public callback field is used.

## Accepted request

1. Bounded UTF-8 parsing and strict field validation happen before mutation.
2. Immutable request fields are hashed before entering the state transaction. Sender identity comes from the authenticated credential.
3. A synchronous SQLite transaction rechecks token deadline, peer revocation, group pause, sender/recipient/topic scope, limits, and optional parent lineage. It reconciles due lifecycle state.
4. An existing `(sender, idempotencyKey)` returns the original request only if both the fingerprint and current read permissions match. A changed body conflicts; deadlines never extend.
5. Otherwise the transaction persists the request, metadata event, and optional pending wake outbox row together.
6. Maintenance is scheduled and Cloudflare's storage/output gating prevents a successful response preceding durable storage commitment. A dropped HTTP response can be retried with the original key.

## Claim and completion

`pending → leased → completed` is the successful path. Claim atomically increments the stored attempt count and creates a random fencing nonce with a deadline capped at request expiry. Repeating a still-current claim returns its original lease. A stale claim key never leases a different request.

Acknowledgement records delivery while leaving the request leased. It neither completes work nor extends the lease. A result requires the addressed recipient, current membership/route/reply permission, and active nonce. Result text, result fingerprint, completed state, acknowledgement, retention deadline, and audit event commit in one transaction. A fault-injection test proves a failure after the result update rolls the entire transaction back.

Once completed, only a retry with the original result key, text, and lease can recover that result, still subject to current authorization. Competing replies conflict. Cancel/result races have one terminal winner. No general exactly-once claim is made: an external effect performed by a separate agent before its result was persisted can still be repeated after redelivery.

## Time and recovery

An expired lease returns to pending unless the attempt budget is exhausted, in which case it dead-letters. Request expiry takes precedence over lease retry. Completion, cancellation, expiration, and dead-letter are terminal. Their text is purged after the configured retention interval; permanent replay tombstones continue to enforce duplicate suppression. Lifetime row caps fail closed instead of silently deleting replay history.

One Durable Object alarm handles the nearest lease, TTL, content purge, or queued wake. Short scheduling input gates retain any earlier alarm; frequent status reads cannot postpone dispatch indefinitely. Alarm logic is safe under repeated invocation. API calls also reconcile persisted deadlines, so restart recovery does not rely on in-memory state.

Tests restart the actual Miniflare/workerd instance while keeping the SQLite directory. Read-only inspection of synthetic database state proves expiry, dead-letter, and purge alarms ran without a status query triggering the same sweep. Local tests do not establish a deployed Cloudflare SLA or a provider bot's persistence guarantees.

## Optional Grok wake

A pending wake is a hint to an already approved routine, not a request executor. The owner must provision an exact endpoint, allowed origin, scope, credential, and relay origin; default configuration has none.

Before HTTP, the Durable Object checks live request/policy controls, records an `in_flight` intent, and explicitly flushes storage. It then rechecks mutable pause, revocation, cancellation, and expiry gates and immediately initiates the fixed-destination request without another yield. The body contains only an opaque request ID and relay origin. The recipient must independently authenticate, claim, and submit its result.

200 becomes `started`, not completed. A crash leaving `in_flight`, timeout, network error, redirect, or non-200 result becomes `hold`; no wake is automatically retried. Already-started external effects cannot be recalled. The adapter has been tested against offline HTTP fakes only, including restart, timeout, and committed-intent inspection.

## Future extensions

An A2A facade would require a selected protocol/SDK version, an explicit supported capability subset, authorization mapping, correlation/state mapping, and conformance tests. This API is not A2A-compatible today. MCP tools, pagination, reviewed archival, richer operational controls, and verified host adapters are separate future work, not implicit capabilities of v0.1.
