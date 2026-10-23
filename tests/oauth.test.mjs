import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { OWNER_ORIGIN, ownerFixture, setUp } from "./owner-helpers.mjs";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const RESOURCE = `${OWNER_ORIGIN}/mcp`;
const oauthFixture = () =>
  ownerFixture({ bindings: { OAUTH_REDIRECT_URIS: JSON.stringify([REDIRECT]) } });

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

async function register(f, redirect = REDIRECT) {
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
  return { verifier, handle, cookie };
}
const approve = (f, consent, extra) =>
  call(
    f,
    "/authorize",
    json({ handle: consent.handle, decision: "approve", ...extra }, { Cookie: consent.cookie }),
  );
const approvalOptions = async (f, consent) =>
  (await call(f, "/owner/approvals/options", json({ handle: consent.handle }))).body;

async function connect(f, key, clientId, identity = "demo/alpha") {
  const consent = await beginConsent(f, clientId);
  const assertion = key.get(await approvalOptions(f, consent));
  const approved = await approve(f, consent, { assertion, identity, days: 30 });
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
const whoami = (f, token) => call(f, "/mcp", { headers: { Authorization: `Bearer ${token}` } });

test("a host connects with one passkey approval and acts as the chosen peer", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const unauthenticated = await call(f, "/mcp");
    assert.equal(unauthenticated.status, 401);
    const clientId = (await register(f)).body.client_id;
    const tokens = await connect(f, key, clientId, "demo/beta");
    assert.ok(tokens.refresh_token);
    const me = await whoami(f, tokens.access_token);
    assert.equal(me.status, 200);
    assert.deepEqual([me.body.connection.group, me.body.connection.peer], ["demo", "beta"]);
    const home = await f.owner("/owner", undefined, { cookie });
    assert.ok(home.body.includes("Synthetic host"));
  } finally {
    await f.close();
  }
});

test("client registration refuses redirect URIs outside the allowlist", async () => {
  const f = await oauthFixture();
  try {
    const res = await register(f, "https://evil.company.dev/callback");
    assert.deepEqual([res.status, res.body.error], [400, "invalid_redirect_uri"]);
  } finally {
    await f.close();
  }
});

test("approval needs a passkey assertion made for that same consent", async () => {
  const f = await oauthFixture();
  try {
    const { key } = await setUp(f);
    const clientId = (await register(f)).body.client_id;
    const first = await beginConsent(f, clientId);
    const second = await beginConsent(f, clientId);
    const forFirst = key.get(await approvalOptions(f, first));
    const base = { identity: "demo/alpha", days: 30 };
    assert.equal((await approve(f, second, { ...base, assertion: forFirst })).status, 401);
    assert.equal((await approve(f, second, { ...base })).status, 401);
    const own = { ...base, assertion: key.get(await approvalOptions(f, second)) };
    assert.equal((await approve(f, second, { ...own, identity: "demo/nobody" })).status, 400);
    const crossSite = await call(
      f,
      "/authorize",
      json(
        { handle: second.handle, decision: "approve", ...own },
        {
          Cookie: second.cookie,
          Origin: "https://evil.company.dev",
        },
      ),
    );
    assert.equal(crossSite.status, 403);
    // Failed attempts leave the consent usable with a fresh assertion.
    const fresh = { ...base, assertion: key.get(await approvalOptions(f, second)) };
    assert.equal((await approve(f, second, fresh)).status, 200);
  } finally {
    await f.close();
  }
});

test("revoking a connection stops its access token on the next call and blocks refresh", async () => {
  const f = await oauthFixture();
  try {
    const { key, cookie } = await setUp(f);
    const clientId = (await register(f)).body.client_id;
    const tokens = await connect(f, key, clientId);
    const id = (await whoami(f, tokens.access_token)).body.connection.connectionId;
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
    const clientId = (await register(f)).body.client_id;
    const first = await connect(f, key, clientId);
    const second = await connect(f, key, clientId);
    assert.equal((await whoami(f, first.access_token)).status, 401);
    assert.equal((await whoami(f, second.access_token)).status, 200);
    // The Connections page lists only the live connection, not the replaced one.
    const home = await f.owner("/owner", undefined, { cookie });
    assert.equal(home.body.match(/data-revoke=/g)?.length, 1);
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
    assert.deepEqual([me.status, me.body.connection.peer], [200, "gamma"]);
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
    const clientId = (await register(f)).body.client_id;
    const consent = await beginConsent(f, clientId);
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
    const home = await f.owner("/owner", undefined, { cookie });
    assert.equal(home.body.match(/data-revoke=/g), null);
  } finally {
    await f.close();
  }
});
