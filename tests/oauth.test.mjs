import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { policy } from "./helpers.mjs";
import { CHATGPT_REDIRECT, OWNER_ORIGIN, oauthFixture, setUp, tool } from "./owner-helpers.mjs";

const REDIRECT = CHATGPT_REDIRECT;
const RESOURCE = `${OWNER_ORIGIN}/mcp`;

const call = (f, path, init) => f.request(path, init);
const json = (body, headers = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: OWNER_ORIGIN, ...headers },
  body: JSON.stringify(body),
});
const form = (fields) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

// Opens the owner's registration window, then registers a client the way a host does.
async function register(f, cookie, redirect = REDIRECT) {
  assert.equal((await f.owner("/owner/registration/open", {}, { cookie })).status, 200);
  return registerClosed(f, redirect);
}
function registerClosed(f, redirect = REDIRECT) {
  return call(
    f,
    "/register",
    json({
      client_name: "Synthetic host",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  );
}

// Opens the approval page the way a host's browser redirect would.
async function beginConsent(f, clientId) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "relay",
    state: "synthetic-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const page = await call(f, `/authorize?${query}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const handle = /id="handle" value="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(handle);
  const cookie = page.cookies.map((c) => c.split(";")[0]).join("; ");
  return { verifier, handle, cookie, html: page.body };
}
const decide = (f, consent, decision, extra) =>
  call(
    f,
    "/authorize",
    json({ handle: consent.handle, decision, ...extra }, { Cookie: consent.cookie }),
  );
const verify = (f, consent, assertion) => decide(f, consent, "verify", { assertion });
const approve = (f, consent, extra) => decide(f, consent, "approve", extra);
const approvalOptions = async (f, consent) =>
  (await call(f, "/owner/approvals/options", json({ handle: consent.handle }))).body;

async function connect(f, key, clientId, identity = "demo/alpha") {
  const consent = await beginConsent(f, clientId);
  const verified = await verify(f, consent, key.get(await approvalOptions(f, consent)));
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const approved = await approve(f, consent, { identity, days: 30 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const redirect = new URL(approved.body.redirectTo);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
  const tokens = await call(
    f,
    "/token",
    form({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code"),
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: consent.verifier,
      resource: RESOURCE,
    }),
  );
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return tokens.body;
}
// Live connections listed on the owner page, including the fixture's seeded peer tokens.
const connectionRows = async (f, cookie) =>
  (await f.owner("/owner", undefined, { cookie })).body.match(/data-revoke=/g)?.length ?? 0;
// Which peer a credential acts as, through the who_am_i MCP tool; 401 once it stops being live.
const whoami = (f, token) => tool(f, token, "who_am_i");
// The owner page lists live connections newest first.
const newestConnectionId = async (f, cookie) =>
  /data-revoke="([^"]+)"/.exec((await f.owner("/owner", undefined, { cookie })).body)?.[1];

test("a host connects with one passkey approval and acts as the chosen peer", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const unauthenticated = await call(f, "/mcp");
    assert.equal(unauthenticated.status, 401);
    const clientId = (await register(f, cookie)).body.client_id;
    const tokens = await connect(f, key, clientId, "demo/beta");
    assert.ok(tokens.refresh_token);
    const me = await whoami(f, tokens.access_token);
    assert.equal(me.status, 200);
    assert.deepEqual([me.data.group, me.data.peer], ["demo", "beta"]);
    const home = await f.owner("/owner", undefined, { cookie });
    assert.ok(home.body.includes("Synthetic host"));
  } finally {
    await f.close();
  }
});

test("client registration needs the owner's open window and an allowlisted redirect", async () => {
  const f = await oauthFixture();
  try {
    const { cookie } = await setUp(f);
    const closed = await registerClosed(f);
    assert.deepEqual([closed.status, closed.body.error], [403, "access_denied"]);
    assert.equal((await f.owner("/owner/registration/open", {})).status, 401);
    const res = await register(f, cookie, "https://evil.company.dev/callback");
    assert.deepEqual([res.status, res.body.error], [400, "invalid_redirect_uri"]);
    assert.equal((await registerClosed(f)).status, 201);
  } finally {
    await f.close();
  }
});

test("agents are listed only after a passkey assertion made for that same consent", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const clientId = (await register(f, cookie)).body.client_id;
    const first = await beginConsent(f, clientId);
    const second = await beginConsent(f, clientId);
    // Anyone can open the approval page, so it names no group, peer or topic.
    for (const name of ["alpha", "beta", "gamma", "demo", "general"])
      assert.equal(first.html.includes(name), false, name);
    const forFirst = key.get(await approvalOptions(f, first));
    assert.equal((await verify(f, second, forFirst)).status, 401);
    const base = { identity: "demo/alpha", days: 30 };
    assert.equal((await approve(f, second, base)).status, 401);
    const verified = await verify(f, second, key.get(await approvalOptions(f, second)));
    assert.equal(verified.status, 200);
    assert.ok(verified.body.identities.some((i) => i.id === "demo/alpha"));
    assert.equal((await approve(f, second, { ...base, identity: "demo/nobody" })).status, 400);
    const crossSite = await call(
      f,
      "/authorize",
      json(
        { handle: second.handle, decision: "approve", ...base },
        { Cookie: second.cookie, Origin: "https://evil.company.dev" },
      ),
    );
    assert.equal(crossSite.status, 403);
    // Refused attempts leave the verification usable; a successful approve uses it up.
    assert.equal((await approve(f, second, base)).status, 200);
    assert.equal((await approve(f, second, base)).status, 401);
  } finally {
    await f.close();
  }
});

test("revoking a connection stops its access token on the next call and blocks refresh", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const clientId = (await register(f, cookie)).body.client_id;
    const tokens = await connect(f, key, clientId);
    assert.equal((await whoami(f, tokens.access_token)).status, 200);
    const id = await newestConnectionId(f, cookie);
    assert.equal((await f.owner("/owner/connections/revoke", { id }, { cookie })).status, 200);
    assert.equal((await whoami(f, tokens.access_token)).status, 401);
    const refresh = await call(
      f,
      "/token",
      form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        resource: RESOURCE,
      }),
    );
    assert.deepEqual([refresh.status, refresh.body.error], [400, "invalid_grant"]);
  } finally {
    await f.close();
  }
});

test("reconnecting the same host as the same peer replaces the earlier connection", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const clientId = (await register(f, cookie)).body.client_id;
    const first = await connect(f, key, clientId);
    const afterFirst = await connectionRows(f, cookie);
    const second = await connect(f, key, clientId);
    assert.equal((await whoami(f, first.access_token)).status, 401);
    assert.equal((await whoami(f, second.access_token)).status, 200);
    // The Connections page lists only the live connection, not the replaced one.
    assert.equal(await connectionRows(f, cookie), afterFirst);
  } finally {
    await f.close();
  }
});

test("connection tokens need a mint step-up, act as the chosen peer and stop when revoked", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const choice = { identity: "demo/gamma", label: "Grok Bot", days: 7 };
    const signIn = key.get((await f.owner("/owner/sign-in/options", {})).body);
    const wrong = await f.owner(
      "/owner/connections/token",
      { ...choice, assertion: signIn },
      { cookie },
    );
    assert.equal(wrong.status, 401);
    const stepUp = (await f.owner("/owner/connections/step-up", {}, { cookie })).body;
    const minted = await f.owner(
      "/owner/connections/token",
      { ...choice, assertion: key.get(stepUp) },
      { cookie },
    );
    assert.equal(minted.status, 200);
    assert.match(minted.body.token, /^ttm_/);
    const me = await whoami(f, minted.body.token);
    assert.deepEqual([me.status, me.data.peer], [200, "gamma"]);
    assert.equal((await whoami(f, `ttm_${"x".repeat(43)}`)).status, 401);
    const id = minted.body.connection.connectionId;
    assert.equal((await f.owner("/owner/connections/revoke", { id }, { cookie })).status, 200);
    assert.equal((await whoami(f, minted.body.token)).status, 401);
  } finally {
    await f.close();
  }
});

test("denying a consent returns the host an access_denied error and creates no connection", async () => {
  const f = await oauthFixture();
  try {
    const { cookie } = await setUp(f);
    const clientId = (await register(f, cookie)).body.client_id;
    const consent = await beginConsent(f, clientId);
    const before = await connectionRows(f, cookie);
    const denied = await call(
      f,
      "/authorize",
      json({ handle: consent.handle, decision: "deny" }, { Cookie: consent.cookie }),
    );
    assert.equal(denied.status, 200);
    const redirect = new URL(denied.body.redirectTo);
    assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
    assert.equal(redirect.searchParams.get("error"), "access_denied");
    assert.equal(redirect.searchParams.get("code"), null);
    assert.equal(await connectionRows(f, cookie), before);
  } finally {
    await f.close();
  }
});

test("agents whose IDs contain a colon can be approved", async () => {
  const p = policy();
  p.groups.demo.peers.push("bot:one");
  p.groups.demo.routes.push({ from: "bot:one", to: "alpha", topics: ["general"], reply: true });
  const f = await oauthFixture({ policy: p });
  try {
    const { key, cookie } = await setUp(f);
    const clientId = (await register(f, cookie)).body.client_id;
    const tokens = await connect(f, key, clientId, "demo/bot:one");
    const me = await whoami(f, tokens.access_token);
    assert.deepEqual([me.status, me.data.peer], [200, "bot:one"]);
  } finally {
    await f.close();
  }
});
