import type { CredentialRow } from "./types";

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

export function homePage(
  credentials: Pick<CredentialRow, "id" | "created_at" | "last_used_at">[],
): Response {
  const date = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());
  const rows = credentials
    .map(
      (c) =>
        `<li><code>${escapeHtml(c.id.slice(0, 12))}…</code> added ${escapeHtml(date(c.created_at))}, last used ${escapeHtml(date(c.last_used_at))}</li>`,
    )
    .join("");
  return page(
    "Relay owner",
    `<h2>Passkeys</h2><ul>${rows}</ul>
<p>Keep at least two passkeys on different devices so losing one doesn't lock you out.</p>
<p><button id="add">Add passkey</button> <button id="out">Sign out</button></p>`,
    `run('add', async () => {
  const assertion = await get(await post('/owner/passkeys/step-up', {}));
  const response = await create(await post('/owner/passkeys/options', { assertion }));
  await post('/owner/passkeys/verify', { response });
  location.reload();
});
run('out', async () => { await post('/owner/sign-out', {}); location.href = '/owner/sign-in'; });`,
  );
}
