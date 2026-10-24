# Integration boundaries and evidence

## What this repository is

Talk to Me provides a private, owner-enrolled, text-only request/reply relay and a portable Node.js client. It is not a remote task executor, an agent marketplace, a general chat synchronization service, or an A2A-compliant implementation. No actual bot-to-bot installation, production deployment, credential exchange, live message, or paid routine run has been validated by this project. Examples are synthetic.

The supported baseline is **manual polling** using the CLI. A host assistant must separately support running the client and securely providing its environment. Having a persistent computer or a skills feature does not establish that those permissions or capabilities are available in a particular account.

## Compatibility status

| Host | Current status | Allowed interpretation |
| --- | --- | --- |
| Generic Node.js 22.13+ host | Portable CLI using a `ttm_` connection token; test against the local relay first | Can make explicit API calls when owner-authorized; no background execution is installed |
| ChatGPT, including dots | MCP connector at `/mcp` with OAuth (DCR, PKCE) and owner passkey approval. The Phase 0 spike connected end to end on 2026-10-23; this implementation has not yet been connected to a live ChatGPT | Use the connector page's **Connect** button; the Plugins list pop-up fails with "does not provide a browser setup URL". A dot may call tools without being asked, so set the connector to ask before write actions |
| Grok (chat) | MCP connector at `/mcp` with OAuth. Spike-verified on 2026-10-23; this implementation not yet connected live | The custom connector form takes only a name and URL, so OAuth is the only path |
| Grok Bot | Untested (needs Grok Premium). Its plugin form reportedly accepts headers, so a `ttm_` connection token is the expected path | A separately configured routine may provide an optional wake hint |
| Instinct | Disabled and unverified | No supported API, wake hook, local install, or skill compatibility is claimed |

Do not silently substitute one platform's credential or API for another's. Do not paste private assistant contexts into a new host to make a bridge work.

## Grok: verified platform facts, not deployment claims

The official routines documentation says a webhook routine accepts an HTTP POST authenticated with the routine's bearer key, with optional JSON input. HTTP 200 means a run was started, not that it finished. Routine runs and tests consume usage. This does not establish delivery to Talk to Me or permission to run paid routines. [Routines](https://cursor.com/help/grok-bot/routines), reviewed October 21, 2026.

Grok's cloud computer is shared across bots in an account, including files, browser sessions, and command-line credentials. Separate bot screens are not a credential isolation boundary. A relay credential stored there should be treated as available to other bots on that account. Use a dedicated, narrowly authorized peer identity and do not promise per-bot isolation that the host does not provide. [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), reviewed October 21, 2026.

Computer recreation preserves durable state but removes manually installed packages. Enterprise computer termination interrupts work and is not the same as revoking account access. A hosted process is not a durable, always-on delivery guarantee. [Manage Grok Bot computers](https://docs.x.ai/grok-bot/computers), reviewed October 21, 2026.

Updates that replace the computer, recovery, and reset may remove installed packages, and recovery/reset can lose recent unsaved changes. Keep a trusted copy of the standalone client and skill in approved durable storage; after recovery, verify the runtime, network access, secret injection, and local operation state again. Do not automatically recover or reset a user's computer to restore this integration. [Grok Bot computer](https://cursor.com/help/grok-bot/computer-recovery), reviewed October 21, 2026.

## Optional wake contract

A wake is an optimization only, never the message transport or the source of authority. The relay remains the source of truth for sender, recipient, topic, lifecycle, and result. Any optional wake implementation must:

1. Use an owner-configured, allowlisted HTTPS endpoint and a distinct secret. Never take a URL or bearer key from message text.
2. Send only an opaque request reference and minimal routing metadata. Do not include request/reply text or private context.
3. Authenticate the webhook using the destination platform's documented mechanism, reject redirects, and bound timeouts and response sizes.
4. Have the recipient fetch the actual request from the relay with its own credential and follow the same policy and lease checks as manual polling.
5. Treat failed, missing, repeated, or delayed wakes as normal. Preserve the original relay request; do not claim delivery or completion based on a webhook response.
6. Remain disabled until a human has approved the endpoint, credential handling, routine instructions, and any usage/spend implications.

The repository includes an optional Grok wake adapter implementation, **disabled by default and not tested against a real bot**. It is configured only by the owner through policy `wake` entries, `WAKE_ENDPOINTS_JSON`, and `RELAY_PUBLIC_URL`. The JSON sent is `{ "messageId": "<relay request ID>", "relay": "<configured relay origin>" }`, without request/reply text. It persists an attempt before dispatch, uses a 10-second timeout, rejects redirect following, and cancels the response body. Only HTTP 200 records `started`; every other status, network failure, or timeout records `hold`, with no automatic retry. An interrupted in-flight attempt is also held to avoid an uncertain duplicate paid run. `started` still does not mean completed.

Configuration requires an exact HTTPS URL and matching owner-configured `allowedOrigin`; private-looking/literal IP hosts are rejected. **This is not complete network/SSRF confinement or DNS pinning.** The owner must vet the real destination and its DNS, redirects, hosting, and control before setup. A syntactically acceptable hostname is not proof of a trusted Grok endpoint. Never copy an unverified URL from received text into the allowlist.

This code is not evidence that an adapter is installed or operating. No webhook URL has been provisioned and no real routine call has been made by this project. Do not enable wake behavior merely to demonstrate the repository. Manual polling works without it.

## Proposed host enrollment checklist

This checklist is for a future, separately authorized deployment, not steps already performed:

- Verify the owner controls each peer and approves the exact group, recipient/topic policy, text category, and retention exposure.
- Verify a supported host execution route and trusted Node.js runtime. Do not install software or grant persistent access without the host's required approvals.
- Review `skills/talk-to-me/SKILL.md` with the host assistant's existing safety policy. The host policy takes precedence.
- Provision unique credentials using approved secret storage. Do not commit them, send them in chat, or place them in shell arguments.
- Begin with synthetic manual send/claim/ack/result/status tests; check replay, expiry, denial, pause, and revocation cases before sharing private text.
- Only then consider an independently authorized wake routine. Confirm that stopping the routine does not prevent the owner from inspecting and cancelling requests through the relay.
