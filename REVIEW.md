# Security and behavior review

Reviewed 2026-10-21 for v0.1. Scope: Worker, SQLite-backed Durable Object, optional wake adapter, CLI, skill, configuration and operational documentation. This is a bounded independent code-and-behavior review, not an external security audit or production certification.

## Result

No remaining release-blocking issue was found within the documented private, owner-enrolled, text-only source-release scope. This conclusion does **not** establish a deployed service, a live hosted-agent integration, production reliability, or approval to provision credentials or transmit private information.

## Verification performed

- `npm run check`: type checking and lint passed; **50 tests passed, 0 failed, 0 skipped**.
- Of these, **35 independent adversarial tests** cover the CLI (7), configuration (6), actual Worker/Durable Object boundary (17), and durable-state/fault behavior (5).
- `npm run dry-run`: Worker bundle and Durable Object binding/migration validation passed without deployment. Local Wrangler logs/configuration were directed to temporary writable directories.
- Environment: Linux, Node.js 24.19.0, direct Miniflare 4.20260730.0 using workerd and real SQLite storage. Toolchain versions and transitive overrides are pinned in the lockfile. CI is configured separately; this review does not claim that remote CI has run.
- All relay traffic used synthetic identities/data. External networking was denied by the test fixture unless replaced with an explicit offline callback. No real bot, credential, model call or deployed endpoint was used.

The independent coverage includes:

1. Missing/invalid/expired credentials, ambiguous token bindings, sender spoofing, unknown fields, unauthorized group/peer/topic access and fail-closed configuration.
2. Stable enqueue and claim receipts, conflicting replay, unchanged deadlines, concurrent exclusive claims and rejection of superseded leases.
3. Reply ownership/correlation, one canonical result under races, exact result retry and cancellation-versus-completion races.
4. Current reply-policy withdrawal across a persistent restart, including the original-send replay path; durable peer revocation; group pause and owned cancellation.
5. Expiry, attempt/dead-letter behavior, text purging, quotas, byte limits and bounded parent lineage.
6. Expiry/purge and dead-letter alarms after restarting the runtime, verified by read-only SQLite inspection without incoming HTTP requests that could perform the same maintenance.
7. Wake request and `in_flight` intent visible in committed SQLite before the offline callback begins, including a pending alarm restored after restart.
8. An actual 10-second callback timeout after simulated effect acceptance, followed by restart with no repeated callback attempt.
9. A real SQLite trigger fault after the result update but before transaction completion: result, acknowledgment and terminal transition all roll back, and retry succeeds after the injected fault is removed.
10. Fixed callback enrollment and URL validation; production callback redirect handling is exercised by the complete suite. Hostile text stays inert and callbacks carry only an opaque request reference and configured relay origin.
11. CLI HTTPS/loopback rules, host-confusion rejection, disabled redirects, no automatic retries, credential redaction, safe JSON handling and request/response bounds.

## Findings corrected during review

### Completed result disclosed through an enqueue replay after reply permission withdrawal

Status/read/list paths checked current reply authority, but the initial exact-send replay path returned the old completed view after checking only request authority. That could reveal a stored reply after the route's reply permission was withdrawn. Enqueue replay now applies the same current read/result permission check. An independent persistent-restart regression exercises the changed policy and verifies denial without content disclosure.

### Frequent status polling could postpone a wake alarm

Implementation testing found that rescheduling a queued wake relative to each poll could starve delivery. Scheduling now derives the wake deadline from durable acceptance time, preserves an earlier alarm, and serializes alarm selection/update. The wake tests poll frequently and still observe delivery; independent restart tests observe alarms without any status polling.

Other review corrections aligned CLI/server identifier rules and bounded response size, clarified credential expiry versus identity revocation, and updated vulnerable development-only transitive dependencies. The final checks above used the resulting dependency tree.

## Security contract assessed

- Authentication determines group and peer. Body-supplied identities cannot override it. A `reply: true` route grants only the bounded response to the original request, not a general reverse route.
- Acknowledgment is receipt, not completion. A wake response is not a reply. One canonical relay result is not exactly-once external execution.
- Removing or expiring a credential blocks future authentication with that key, but does not cancel already accepted work. Durable peer revocation or group pause is required to suppress queued dispatch.
- Cancellation, expiry and revocation cannot retract text already read or undo a callback/effect already initiated.
- The skill does not treat authenticated peer content as owner authorization. It preserves the receiving host's own action, data-access and disclosure approvals.
- A credential on a shared hosted computer authenticates that accessible workspace/account boundary, not a cryptographically isolated individual bot. The documentation does not promise per-bot isolation or runtime egress confinement.
- Plaintext storage, provider/operator access, finite lifetime row quotas, retained replay metadata, missing pagination and lack of a live dot/Instinct integration are disclosed.

## Remaining limits and production gates

- Restart checks dispose and recreate local runtimes using persisted SQLite. They do not simulate physical power loss, forced process kill, disk corruption/full disks, multi-region failures or production deployment/version propagation.
- The injected SQLite failure exercises transaction rollback, not every possible I/O failure. The timeout test is an offline transport model, not proof of any vendor's billing or duplicate-execution semantics.
- Callback syntax validation and fixed owner enrollment are not DNS pinning or network-level SSRF isolation. The owner must verify the real vendor endpoint and its DNS/hosting control before enrollment.
- No hosted assistant installation, true agent invocation, real webhook, credential provisioning, production backup/restore, sustained-load test or model-level prompt-injection resistance was verified.
- Manual polling remains the baseline. Wake `hold` requires human reconciliation; no automatic recovery action, dead-letter replay or quota-reset API is provided.
- Before deployment, review ingress protection, spending, secrets, retention/deletion, monitoring, backup/recovery, actual platform capabilities and minimum-data disclosure permissions. Run a separately authorized synthetic round trip on each real host and verify the exact deployed commit.

See [the adversarial plan](docs/ADVERSARIAL_TEST_PLAN.md), [security model](SECURITY.md), [API contract](docs/API.md), and [operations](docs/OPERATIONS.md) for the intended boundaries.
