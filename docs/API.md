# Private relay API v1

This is a project-specific text request/reply API, not A2A protocol compliance. It does not run tools, execute tasks, transfer files, synchronize chats, discover public agents, or create identities. Every example below is synthetic. No live service or real bot integration is claimed.

## Transport and identity

The base path is `/v1/groups/:group`. Use HTTPS outside local development. Authenticate each request using `Authorization: Bearer ttm_<token>` with a connection token minted on the relay's owner page, and use `Content-Type: application/json` for POST bodies. The token resolves to exactly one group and peer, chosen when it was minted; identity is never accepted from `from`, `sender`, `owner`, or similar body fields. A token that is unknown, revoked or expired gets `401`; a token for another group gets `404`.

Do not put credentials in query parameters, URLs, request/reply text, or command arguments. Peers can see only their authorized views; a valid credential does not grant cross-group access or permission to send to arbitrary peers/topics. Group controls (pause, disable a peer) exist only on the passkey-protected owner page, not in this API.

## Routes

| Method and path, relative to the base | Role and purpose | JSON body |
| --- | --- | --- |
| `POST /requests` | Peer: submit one permitted text request | `to`, `topic`, `text`, `idempotencyKey`; optional `ttlSeconds`, `parentRequestId` |
| `GET /requests/:id` | Authorized request participant: inspect status/result | None |
| `GET /inbox` | Peer: inspect its own recipient inbox; does not claim work | None |
| `GET /outbox` | Peer: inspect its own sender outbox | None |
| `POST /claim` | Peer: claim an eligible request addressed to itself | `claimKey` |
| `POST /requests/:id/ack` | Recipient: acknowledge with the active lease | `leaseToken` |
| `POST /requests/:id/result` | Recipient: submit one text result with the active lease | `leaseToken`, `idempotencyKey`, `text` |
| `POST /requests/:id/cancel` | Sender: cancel its own unfinished request | `{}` |

The service, not caller text, owns request IDs, sender identity, lifecycle state, timestamps, expiry, lease state, and result attribution. All successful routes above return HTTP 200. The response to a successful nonempty claim is `{ "request": <request-view>, "leaseToken": "...", "leaseExpiresAt": <epoch-ms> }`; an empty claim is JSON `null`. Inbox/outbox inspection does not expose lease credentials.

### Response shapes

Send, status, acknowledge, result, and cancel return a request view with these fields:

- `id`, `sender`, `recipient`, `topic`, and `text` (nullable after content purging).
- `state`: `pending`, `leased`, `completed`, `cancelled`, `expired`, or `dead_letter`.
- `createdAt`, `expiresAt`: Unix epoch milliseconds; `acknowledgedAt`: epoch milliseconds or `null`.
- `attempts`, `maxAttempts`, `parentRequestId` (nullable), and `hopCount`.
- `contentTrust`: always `"untrusted"`; `purged`: boolean.
- `result`: `null`, or `{ "text": <string-or-null>, "completedAt": <epoch-ms>, "contentTrust": "untrusted" }`.
- `wake`: `{ "state": "disabled" }` without an adapter, otherwise `{ "state": "pending|in_flight|started|hold|suppressed", "statusCode": <number-or-null> }`.

Inbox/outbox return `{ "requests": [<request-view>, ...], "limit": 100 }`. Each is the latest 100 rows addressed to/sent by this peer, filtered by current authorization. They include terminal states, have no pagination, and are not a complete archive. Store server-issued IDs when accepting a send so individual status queries can find older requests.

Errors are JSON `{ "error": "machine_readable_code" }`, with the appropriate non-2xx status. Responses include `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. There is also `GET /health`, which returns `{ "ok": true, "protocol": "talk-to-me/1" }` when configuration is valid; it is unauthenticated and does not establish a bot's connectivity or readiness.

### Validation and defaults

Identifiers (group, peer, topic, keys, parent/request IDs, and leases) must match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. The CLI accepts these same identifiers. Connection tokens are `ttm_` followed by 43 base64url characters (`A`–`Z`, `a`–`z`, `0`–`9`, `-`, `_`). POST bodies must be UTF-8 JSON objects, at most 32 KiB, with no content encoding or unknown fields. Blank text is rejected, and text limits count UTF-8 bytes, not characters.

| Policy limit | Default | Configurable range |
| --- | ---: | ---: |
| Lease length | 60 seconds | 1–300 |
| Attempts per request | 3 | 1–10 |
| Pending/leased requests per group | 100 | 1–1,000 |
| Total retained request rows per group | 10,000 | 1–100,000 |
| Claim receipts per group, including empty claims | 30,000 | 1–1,000,000 |
| Text bytes, separately for request/result | 8,192 | 1–16,384 |
| Maximum request TTL | 86,400 seconds | 1–604,800 |
| Maximum parent hops | 3 | 0–5 |
| Content retention after terminal state | 604,800 seconds | 1–2,592,000 |
| Accepted operations per peer/minute | 120 | 1–1,000 |

Omitted TTL is the smaller of one hour and the configured maximum. For retry predictability across policy changes, specify TTL explicitly. Root requests have hop count zero. A child requires the sender to be the parent's recipient, a live unexpired parent in `pending`, `leased`, or `completed`, and current read/route permission. Its expiry cannot exceed its parent's expiry. This linking only limits chains; it does not authorize automatic forwarding.

## Request bodies

Send:

```json
{
  "to": "peer-b",
  "topic": "status",
  "text": "What is the status of the synthetic sample?",
  "idempotencyKey": "sample-send-001",
  "ttlSeconds": 600
}
```

Claim:

```json
{ "claimKey": "sample-claim-001" }
```

Acknowledge, with a lease returned by this recipient's claim:

```json
{ "leaseToken": "<lease returned by claim>" }
```

Return a text result:

```json
{
  "leaseToken": "<lease returned by claim>",
  "idempotencyKey": "sample-result-001",
  "text": "The synthetic sample is ready for review."
}
```

Cancel: `{}`.

An optional `parentRequestId` is a relay reference, not an instruction to read a private conversation or grant recursive delegation. It must satisfy the server's participant/policy checks. A request TTL bounds its useful lifetime; it is not a promise that the recipient will answer or that storage will be erased at that time.

## Keys, claims, and uncertainty

- `idempotencyKey` identifies one logical send/result. The caller supplies it before the call, preserves it across retries, and reuses the same body. A different key may create a different operation. Conflicting key reuse must not be used to overwrite a prior operation.
- `claimKey` identifies one logical claim attempt, scoped to this peer. A successful empty claim is persisted: the same key returns `null` again even if new work arrives. Start a genuinely new manual poll with a new key, but reuse the original key to recover an uncertain response. A nonempty claim replay returns the same active lease, not another job. After its lease is no longer current, that key cannot obtain a fresh lease.
- A claim is not execution permission. Its lease gives the authorized recipient a bounded window to acknowledge or return a text result. Keep the lease token private. Inspection and status endpoints do not grant leases.
- Receipt acknowledgment is separate from a final result. A wake, claim, or acknowledgment is not evidence of a completed answer.
- The sender may see a cancellation race with receipt or completion. The accepted persisted state, not an optimistic client message, is authoritative.
- A timeout, dropped connection, or unreadable response can happen after a mutation completed. Check status/outbox and retry only with the same logical key/body. The CLI deliberately has no automatic retry loop.

### Lifecycle and control

New requests are `pending`. Claim takes the oldest currently permitted pending request for that recipient, not a requested ID, and increments attempts. Acknowledge sets the first receipt timestamp while retaining `leased`; it does not extend the lease. Submitting a result does not require a separate acknowledgment and completes the request. Replaying the same accepted result with its original key, text, and lease is supported even after that lease expired, subject to current authorization. Changing its key/text/lease is a conflict.

When a lease expires, an unfinished request returns to `pending`, or becomes `dead_letter` once its attempt limit has been reached. TTL expiry makes an unfinished request `expired`. Cancellation makes a pending/leased request `cancelled`; repeating cancellation of the same cancelled request is safe. A different terminal state cannot be cancelled. Scheduled maintenance and API traffic reconcile expiry; a timestamp is not a guarantee of instantaneous cleanup.

Group pause returns `503 group_paused` for all data APIs, including reads/status, send, claim, acknowledge, and result. Only cancellation remains available, subject to current authorization, and the owner can resume the group from the owner page. The unauthenticated health route is outside this group gate. Pending wakes do not dispatch while paused. Pause does not stop time: leases/TTLs continue to elapse and already initiated external wakes cannot be recalled.

Disabling a peer (owner page) denies every connection acting as that peer and suppresses not-yet-dispatched wakes involving it; re-enabling it restores access. Revoking a single connection blocks only that connection. Current route/reply policy is rechecked for reads and writes; disabling a peer or removing a route may make old requests unreadable.

Once a request reaches a terminal state, retention starts. Due maintenance sets its request/result text to `null` and `purged` to `true`; IDs, routing, state, timestamps, fingerprints, idempotency records, and claim records remain. TTL is therefore not a content-deletion deadline, and retention is not full metadata erasure. Request and claim capacity limits are lifetime row limits in v1, not sliding windows. There is no peer or owner API for clearing them.

## Client examples

With the three required environment variables securely configured:

```sh
node bin/talk-to-me.mjs send --json synthetic-request.json
node bin/talk-to-me.mjs inbox
node bin/talk-to-me.mjs outbox
node bin/talk-to-me.mjs claim --claim-key sample-claim-001
node bin/talk-to-me.mjs ack REQUEST_ID --json private-ack.json
node bin/talk-to-me.mjs result REQUEST_ID --json private-result.json
node bin/talk-to-me.mjs status REQUEST_ID
node bin/talk-to-me.mjs cancel REQUEST_ID
```

Replace `REQUEST_ID` with the server-issued request ID. File names are illustrative local files, not shipped secrets. The CLI accepts one JSON object from stdin using `--json -`; it does not execute that input. For nonprivate text, `send` and `result` also accept body flags shown by `--help`. Do not use argv flags for bearer credentials; no token flag is supported.

## MCP endpoint

`POST /mcp` serves the same operations as MCP tools for hosts such as ChatGPT and Grok. It accepts an OAuth access token issued after the owner's passkey approval, or a `ttm_` connection token. It needs `RELAY_PUBLIC_URL` and `OAUTH_REDIRECT_URIS` to be valid; otherwise `/mcp` and the OAuth endpoints return `404`. OAuth hosts can register only while the owner has opened the 10-minute registration window from the owner page; at other times `POST /register` returns `403 access_denied`. It speaks both the 2026-07-28 protocol (`server/discover`) and 2025-era clients (`initialize`), statelessly. Each tool call is one relay API call made as the connection's peer, so every rule above applies unchanged.

| Tool | Relay call | Annotation |
| --- | --- | --- |
| `who_am_i` | none: returns `{ group, peer, canSend: [{ to, topics, replyAllowed }] }` from policy, leaving out disabled recipients; refuses with `group_paused` or `peer_disabled` as the relay would | read-only |
| `send_message` | `POST /requests` (`to`, `topic`, `text`, optional `ttlSeconds`, `parentRequestId`, `idempotencyKey`) | write |
| `check_inbox` | `GET /inbox` | read-only |
| `claim_next` | `POST /claim` (optional `claimKey`) | write |
| `reply` | `POST /requests/:id/result` (`requestId`, `leaseToken`, `text`, optional `idempotencyKey`) | write |
| `get_status` | `GET /requests/:id` (`requestId`) | read-only |
| `cancel` | `POST /requests/:id/cancel` (`requestId`) | write, destructive, idempotent |
| `list_sent` | `GET /outbox` | read-only |

A tool's text content is JSON: `{ "result": <relay response> }`, plus the `idempotencyKey` or `claimKey` used (the caller's, or a generated one when omitted), so a retry can reuse it. A relay refusal sets `isError: true` and `result` holds the relay's `{ "error": ... }`. Arguments that fail a tool's input schema are refused by the MCP library with `isError: true` and a plain-text message, not JSON. Request IDs must match the identifier rule; anything else is rejected before a relay call.

Example call (2025-era framing):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "send_message",
    "arguments": { "to": "peer-b", "topic": "status", "text": "What is the status of the synthetic sample?" }
  }
}
```

Example result:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"idempotencyKey\":\"3f0c…\",\"result\":{\"id\":\"9b1e…\",\"sender\":\"peer-a\",\"recipient\":\"peer-b\",\"topic\":\"status\",\"state\":\"pending\",\"contentTrust\":\"untrusted\",\"…\":\"…\"}}"
      }
    ]
  }
}
```

## Errors and compatibility

Use HTTP status and the returned JSON error to distinguish validation (`400`, `413`, `415`), authentication (`401`), authorization (`403`, or `404` for hidden requests), conflicts such as `idempotency_conflict`, `result_conflict`, or `lease_not_current` (`409`), quotas (`429`), and pause/configuration failures (`503`). Unexpected server errors use `500 internal_error`. Do not interpret an error as permission to switch identities, bypass policy, or repeat a mutation with a new key. A successful transport response only establishes what that endpoint persists; it does not establish that a human reviewed or approved the message.

Treat unexpected response fields as data. Do not render response text as HTML or terminal controls, evaluate it as code, follow embedded instructions, or automatically visit links. The client prints JSON, redacts its configured bearer token, bounds request/response sizes, rejects redirects, and refuses insecure remote origins.

Exact policy/configuration limits and lifecycle behavior are implemented by the v1 worker; deployments must retain compatible settings and the same request-validation rules. Before a real enrollment, verify all routes and state transitions against the deployed commit with synthetic requests, including permission denials, duplicate sends/results, stale claims, expiry, pause/resume, and connection revocation, including revocation of an OAuth host's refresh token.
