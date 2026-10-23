import { CONNECTION_DAYS, identityKey, LABEL_MAX } from "./config";
import type { ConnectionSummary, CredentialRow, Identity } from "./types";

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Shared by every page: JSON POST helper and the two WebAuthn ceremonies.
const CLIENT = `
const show = (m) => { document.getElementById('status').textContent = m; };
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || String(r.status));
  return data;
}
const create = async (options) => (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })).toJSON();
const get = async (options) => (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) })).toJSON();
const run = (id, task) => { document.getElementById(id).onclick = () => task().catch((e) => show('Failed: ' + e.message)); };
`;

function page(title: string, body: string, script: string): Response {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.5em 1em}code{background:#eee;padding:0 .2em}</style>
<h1>${escapeHtml(title)}</h1>${body}<p id="status" role="status"></p>
<script nonce="${nonce}">${CLIENT}${script}</script>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export function setupPage(): Response {
  return page(
    "Register your passkey",
    `<p>Enter the setup code from the relay's <code>OWNER_SETUP_CODE</code> secret. Each code works once.</p>
<p><label>Setup code <input id="code" autocomplete="off" size="40"></label></p>
<p><button id="go">Register passkey</button></p>`,
    `run('go', async () => {
  const code = document.getElementById('code').value.trim();
  const response = await create(await post('/owner/setup/options', { code }));
  await post('/owner/setup/verify', { code, response });
  location.href = '/owner';
});`,
  );
}

export function signInPage(): Response {
  return page(
    "Sign in",
    `<p><button id="go">Sign in with passkey</button></p>`,
    `run('go', async () => {
  const response = await get(await post('/owner/sign-in/options', {}));
  await post('/owner/sign-in/verify', { response });
  location.href = '/owner';
});`,
  );
}

const date = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());

function identityChoices(identities: Identity[]): string {
  const options = identities
    .map(({ group, peer, routes }) => {
      const sends = routes.map((r) => `${r.to} (${r.topics.join(", ")})`).join("; ") || "nothing";
      return `<option value="${escapeHtml(identityKey({ group, peer }))}">${escapeHtml(`${peer} in ${group}`)}, can send to: ${escapeHtml(sends)}</option>`;
    })
    .join("");
  const days = CONNECTION_DAYS.map((d) => `<option value="${d}">${d} days</option>`).join("");
  return `<p><label>Act as <select id="identity">${options}</select></label></p>
<p><label>Expires after <select id="days">${days}</select></label></p>`;
}
const CHOICES_SCRIPT = `const choices = () => ({ identity: document.getElementById('identity').value, days: Number(document.getElementById('days').value) });`;

export function homePage(
  credentials: Pick<CredentialRow, "id" | "created_at" | "last_used_at">[],
  connections: ConnectionSummary[],
  identities: Identity[],
): Response {
  const passkeys = credentials
    .map(
      (c) =>
        `<li><code>${escapeHtml(c.id.slice(0, 12))}…</code> added ${escapeHtml(date(c.created_at))}, last used ${escapeHtml(date(c.last_used_at))}</li>`,
    )
    .join("");
  const live = connections
    .map(
      (c) =>
        `<li>${escapeHtml(c.kind === "oauth" ? "App" : "Token")} <strong>${escapeHtml(c.label)}</strong> as ${escapeHtml(`${c.peer} in ${c.group_name}`)}, expires ${escapeHtml(date(c.expires_at))} <button data-revoke="${escapeHtml(c.id)}">Revoke</button></li>`,
    )
    .join("");
  return page(
    "Relay owner",
    `<h2>Connections</h2><ul>${live || "<li>None</li>"}</ul>
<h3>New connection token</h3>
<p>For hosts that take a header instead of signing in. Shown once.</p>
${identityChoices(identities)}
<p><label>Label <input id="label" maxlength="${LABEL_MAX}"></label></p>
<p><button id="mint">Create token with passkey</button></p><p><code id="token"></code></p>
<h2>Passkeys</h2><ul>${passkeys}</ul>
<p>Keep at least two passkeys on different devices so losing one doesn't lock you out.</p>
<p><button id="add">Add passkey</button> <button id="out">Sign out</button></p>`,
    `${CHOICES_SCRIPT}
document.addEventListener('click', (e) => {
  const id = e.target.dataset && e.target.dataset.revoke;
  if (id) post('/owner/connections/revoke', { id }).then(() => location.reload(), (err) => show('Failed: ' + err.message));
});
run('mint', async () => {
  const assertion = await get(await post('/owner/connections/step-up', {}));
  const label = document.getElementById('label').value.trim();
  const { token } = await post('/owner/connections/token', { assertion, label, ...choices() });
  document.getElementById('token').textContent = token;
  show('Copy this token now; it will not be shown again.');
});
run('add', async () => {
  const assertion = await get(await post('/owner/passkeys/step-up', {}));
  const response = await create(await post('/owner/passkeys/options', { assertion }));
  await post('/owner/passkeys/verify', { response });
  location.reload();
});
run('out', async () => { await post('/owner/sign-out', {}); location.href = '/owner/sign-in'; });`,
  );
}

export function approvalPage(
  consent: { clientName: string; clientDomain?: string; redirectHost: string },
  handle: string,
  identities: Identity[],
): Response {
  return page(
    `Connect ${consent.clientName}?`,
    `<p>${consent.clientDomain ? `Published by <strong>${escapeHtml(consent.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}</p>
<p>Access will be sent to <strong>${escapeHtml(consent.redirectHost)}</strong>.</p>
${identityChoices(identities)}
<p><button id="approve">Approve with passkey</button> <button id="deny">Deny</button></p>
<input type="hidden" id="handle" value="${escapeHtml(handle)}">`,
    `${CHOICES_SCRIPT}
const handle = document.getElementById('handle').value;
const finish = async (body) => { location.href = (await post('/authorize', body)).redirectTo; };
run('approve', async () => {
  const assertion = await get(await post('/owner/approvals/options', { handle }));
  await finish({ handle, decision: 'approve', assertion, ...choices() });
});
run('deny', () => finish({ handle, decision: 'deny' }));`,
  );
}
