import {
  CONNECTION_DAYS,
  groupChange,
  identityKey,
  identityLabel,
  LABEL_MAX,
  restoresAccess,
} from "./config";
import type { ConnectionSummary, CredentialRow, GroupStatus, Identity } from "./types";

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
    .map(
      (i) =>
        `<option value="${escapeHtml(identityKey(i))}">${escapeHtml(identityLabel(i))}</option>`,
    )
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
  groups: GroupStatus[],
  registrationOpenUntil: number,
): Response {
  // The server's own rule decides which buttons ask for a passkey first.
  const button = (action: string, group: string, peer?: string) =>
    `<button data-action="${action}" data-group="${escapeHtml(group)}"${peer === undefined ? "" : ` data-peer="${escapeHtml(peer)}"`}${restoresAccess(groupChange(action, peer)) ? " data-restore" : ""}>${action[0]?.toUpperCase()}${action.slice(1)}</button>`;
  const groupRows = groups
    .map(
      (g) =>
        `<h3>${escapeHtml(g.name)}: ${g.paused ? "paused" : "running"} ${button(g.paused ? "resume" : "pause", g.name)}</h3><ul>${g.peers
          .map((peer) => {
            const off = g.disabled.includes(peer);
            return `<li>${escapeHtml(peer)}: ${off ? "disabled" : "active"} ${button(off ? "enable" : "disable", g.name, peer)}</li>`;
          })
          .join("")}</ul>`,
    )
    .join("");
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
    `<h2>Connect a new app</h2>
<p>${registrationOpenUntil > Date.now() ? `Registration is open until ${escapeHtml(date(registrationOpenUntil))}.` : "Registration is closed."} Open it, then add the relay in ChatGPT or Grok within 10 minutes. You still approve the connection with your passkey.</p>
<p><button id="register">Open registration for 10 minutes</button></p>
<h2>Groups</h2>${groupRows}
<p>Pausing a group or disabling a peer takes effect on the next call. Resuming or enabling asks for your passkey.</p>
<h2>Connections</h2><ul>${live || "<li>None</li>"}</ul>
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
  const d = e.target.dataset || {};
  if (d.action) (async () => {
    const assertion = 'restore' in d ? await get(await post('/owner/groups/step-up', {})) : undefined;
    await post('/owner/groups/control', { group: d.group, action: d.action, peer: d.peer, assertion });
    location.reload();
  })().catch((err) => show('Failed: ' + err.message));
  const id = d.revoke;
  if (id) post('/owner/connections/revoke', { id }).then(() => location.reload(), (err) => show('Failed: ' + err.message));
});
run('register', async () => { await post('/owner/registration/open', {}); location.reload(); });
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

// An OAuth client names itself, so its name is untrusted: drop control and direction-override
// characters, collapse whitespace and keep it short.
export function cleanName(name: string): string {
  const chars = Array.from(
    name
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!chars.length) return "Unnamed app";
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : chars.join("");
}

export function approvalPage(
  consent: { clientName: string; clientDomain?: string; redirectHost: string },
  handle: string,
): Response {
  return page(
    "Connect an app?",
    `<p>The app calls itself <strong>"${escapeHtml(cleanName(consent.clientName))}"</strong>.</p>
<p>${consent.clientDomain ? `Published by <strong>${escapeHtml(consent.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}</p>
<p>Access will be sent to <strong>${escapeHtml(consent.redirectHost)}</strong>.</p>
<p>Approve only a connection you just started yourself.</p>
<p><button id="verify">Approve with passkey</button> <button id="deny">Deny</button></p>
<div id="choose" hidden>
<p><label>Act as <select id="identity"></select></label></p>
<p><label>Expires after <select id="days"></select></label></p>
<p><button id="approve">Connect</button></p>
</div>
<input type="hidden" id="handle" value="${escapeHtml(handle)}">`,
    `${CHOICES_SCRIPT}
const handle = document.getElementById('handle').value;
const finish = async (body) => { location.href = (await post('/authorize', body)).redirectTo; };
const fill = (id, items) => {
  const select = document.getElementById(id);
  for (const [value, text] of items) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
};
run('verify', async () => {
  const assertion = await get(await post('/owner/approvals/options', { handle }));
  const { identities, days } = await post('/authorize', { handle, decision: 'verify', assertion });
  fill('identity', identities.map((i) => [i.id, i.label]));
  fill('days', days.map((d) => [String(d), d + ' days']));
  document.getElementById('verify').hidden = true;
  document.getElementById('choose').hidden = false;
});
run('approve', () => finish({ handle, decision: 'approve', ...choices() }));
run('deny', () => finish({ handle, decision: 'deny' }));`,
  );
}
