# Adversarial verification plan

This plan tests the relay's authorization and durable-state boundaries with synthetic data. It is not a production security certification or evidence of a working integration with a hosted agent.

## Test environment

Run the actual built Worker and Durable Object under Miniflare/workerd, using separate synthetic groups, actors, credentials and fixed mock callback endpoints. Do not deploy, use real credentials, invoke real agents, or contact arbitrary callback URLs. Use an isolated persistence directory for restart checks. Test invalid configuration separately from invalid requests.

Record the exact commands, observed pass/fail counts, limitations and remaining issues in `REVIEW.md`. A skipped or unavailable test is not a pass.

## Acceptance properties and attacks

### 1. Authentication, authority and isolation

- Missing, malformed, incorrect, expired and revoked credentials fail closed before content is revealed or state is changed.
- Bind sender and group to server-verified credentials, never a body field, query parameter or claimed identity.
- Exercise wrong group, recipient, topic and kind on send, list, get, claim, acknowledge, reply and cancel. Guessing an existing message ID must not bypass those checks.
- Require an independent authorized reply route. A sender's permission to request data does not grant a peer permission to disclose anything in return.
- Policy/key changes must invalidate future operations, including queued and leased work. Identify any snapshot or propagation delay explicitly.
- Reject incomplete or malformed configuration instead of falling back to permissive defaults. Require distinct actor credentials; reject an ambiguous token bound to different identities.

### 2. Replay, leases and correlation

- Exact enqueue retries return the original durable record and deadline. A changed payload, recipient, topic or lifetime under the same sender/message key is a conflict.
- Reusing the same ID across isolated groups or actors cannot read or mutate another actor's record.
- Competing claimers cannot obtain the same live lease. An expired lease cannot acknowledge or reply after a new claimant obtains a fresh lease.
- Lease tokens are absent from unrelated reads, list responses, wake payloads and logs.
- Reply identity, recipient, topic and correlation derive from the original request. Reject unsolicited, wrong-peer, wrong-lease, cross-request, expired and cancelled replies.
- Concurrent replies produce at most one accepted final response. Exact reply retry is idempotent without granting new authority; conflicting replies fail.
- Define whether delivery acknowledgment closes the reply opportunity, and test the actual documented contract.

### 3. Atomicity and durable recovery

- A request and its pending-wake record commit before any callback is attempted. A callback sees committed request state.
- Reply insertion and request completion commit atomically. Inject a failed write, where supported, and show that the request is not prematurely completed.
- Durable restart retains messages, replay history, lease state, terminal outcomes and outstanding alarms. Rehydration must not accidentally resend an ambiguous webhook attempt.
- Concurrent cancel/reply, expiry/reply, revoke/claim and retry/complete races have a documented winning transition. Once terminal, no later operation reactivates authority.
- Expired leases and requests are eventually reconciled by alarms, including after restart, rather than relying solely on unrelated incoming requests.

### 4. Webhook delivery and SSRF

- Only an owner-configured fixed HTTPS callback is reachable. Incoming payloads, reply fields, headers and query strings cannot choose or alter a destination.
- Reject dangerous callback configuration, including userinfo, fragments, loopback/link-local/private-network literals and unsupported schemes. Explicitly document that static URL validation cannot by itself prevent DNS rebinding.
- Disable redirects so a trusted origin cannot redirect a credential-bearing request to another origin.
- Redact authorization and callback secrets from all public responses, CLI output, exceptions and ordinary logs.
- Differentiate definite rejection, accepted wake and ambiguous timeout/network interruption. A wake acknowledgment is not completion.
- Persist the attempted/uncertain delivery state before dispatch. Do not automatically retry ambiguous effects. Repeated alarm execution or object restart must not create duplicate webhook attempts after an uncertain outcome.
- Keep callback credentials scoped to their intended destination. Do not include the initiating actor's relay token in wake payloads.

### 5. Bounds, inert content and resource use

- Reject oversized bytes, excessive nesting, invalid JSON, unexpected fields, non-finite/unsafe numeric values, extreme durations and impossible timestamps.
- Bound queued records, retries, execution/chain budgets and retained replay state, or explicitly document remaining resource-exhaustion limitations.
- Strings containing commands, URLs, paths, HTML and prompt injections remain inert data. The relay never fetches payload URLs, opens paths, renders active content or evaluates code.
- HTTP errors should be controlled, minimal and free of internal stack traces or secret configuration.
- Check HTTP methods, content types and parameter encodings, including duplicate and percent-encoded identifiers.

### 6. CLI, skill and operational claims

- Use environment variables, secure prompts or protected files for credentials, not command-line token flags or real tokens in examples. Never print secrets in help, validation errors or debug output.
- Do not silently transmit tokens to arbitrary, insecure, redirected or host-confused relay URLs. Document HTTP only for an explicit local-development route if supported.
- Skill instructions must treat authenticated peer content as untrusted data, retain the receiving runtime's own user permissions and forbid treating relay membership as approval for unrelated actions or disclosures.
- Hosted bots sharing a VM/filesystem cannot be isolated by bot labels or a shared key. Describe credentials as authenticating the protected workspace/account boundary unless per-bot protection has been established.
- Describe at-least-once claiming, bounded replay retention and ambiguous webhook delivery honestly. Do not claim exactly-once external execution, universal hosted-agent compatibility, vendor-excluding confidentiality or enforced runtime confinement.

## Release blockers

Any content disclosure across an unauthorized boundary; sender impersonation; mutation through stale authority; reactivation of expired/cancelled/revoked work; automatic duplicate effects after ambiguous delivery; arbitrary callback routing; credential leakage; or missing production auth/configuration fail-closed behavior blocks a public release that claims those controls.

Deployment and live integration remain separate acceptance gates. Local runtime tests do not establish account-specific APIs, production durability, network isolation, provider data handling or genuine agent completion.
