import assert from "node:assert/strict";
import test from "node:test";
import { authenticator, ownerFixture, SETUP_CODE } from "./owner-helpers.mjs";

async function setUp(f, key = authenticator()) {
  const options = await f.owner("/owner/setup/options", { code: SETUP_CODE });
  assert.equal(options.status, 200);
  const done = await f.owner("/owner/setup/verify", {
    code: SETUP_CODE,
    response: key.create(options.body),
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { key, cookie: done.cookie };
}

test("setup registers the first passkey once, starts a session and burns the code", async () => {
  const f = await ownerFixture();
  try {
    assert.equal((await f.owner("/owner")).location, "/owner/sign-in");
    assert.equal((await f.owner("/owner/setup/options", { code: "x".repeat(40) })).status, 403);
    const { key, cookie } = await setUp(f);
    assert.match(cookie, /^__Host-ttm_owner=/);
    const home = await f.owner("/owner", undefined, { cookie });
    assert.equal(home.status, 200);
    assert.ok(home.body.includes(key.id.slice(0, 12)));
    const again = await f.owner("/owner/setup/options", { code: SETUP_CODE });
    assert.deepEqual([again.status, again.body.error], [409, "setup_code_used"]);
  } finally {
    await f.close();
  }
});

test("setup code guesses are rate-limited, even before a correct guess", async () => {
  const f = await ownerFixture();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await f.owner("/owner/setup/options", { code: `wrong-${i}`.repeat(8) })).status,
        403,
      );
    const locked = await f.owner("/owner/setup/options", { code: SETUP_CODE });
    assert.deepEqual([locked.status, locked.body.error], [429, "too_many_attempts"]);
  } finally {
    await f.close();
  }
});

test("registration is refused for a wrong origin, wrong RP ID, missing user verification or a reused challenge", async () => {
  const f = await ownerFixture();
  try {
    const key = authenticator();
    for (const over of [
      { origin: "https://evil.company.dev" },
      { rpId: "evil.company.dev" },
      { uv: false },
    ]) {
      const options = await f.owner("/owner/setup/options", { code: SETUP_CODE });
      const res = await f.owner("/owner/setup/verify", {
        code: SETUP_CODE,
        response: key.create(options.body, over),
      });
      assert.deepEqual(
        [res.status, res.body.error],
        [400, "passkey_not_verified"],
        JSON.stringify(over),
      );
      // The failed attempt consumed its challenge: a valid response to it is refused too.
      const replay = await f.owner("/owner/setup/verify", {
        code: SETUP_CODE,
        response: key.create(options.body),
      });
      assert.equal(replay.status, 400);
    }
    // Failed ceremonies leave the setup code usable.
    await setUp(f);
  } finally {
    await f.close();
  }
});

test("sign-in needs a fresh challenge, user verification, the right origin and an advancing counter", async () => {
  const f = await ownerFixture();
  try {
    const { key } = await setUp(f);
    const options = (await f.owner("/owner/sign-in/options", {})).body;
    const assertion = key.get(options);
    const signedIn = await f.owner("/owner/sign-in/verify", { response: assertion });
    assert.equal(signedIn.status, 200);
    assert.match(signedIn.cookie, /^__Host-ttm_owner=/);
    assert.equal((await f.owner("/owner/sign-in/verify", { response: assertion })).status, 401);
    for (const over of [{ uv: false }, { origin: "https://evil.company.dev" }, { counter: 1 }]) {
      const fresh = (await f.owner("/owner/sign-in/options", {})).body;
      const res = await f.owner("/owner/sign-in/verify", { response: key.get(fresh, over) });
      assert.deepEqual(
        [res.status, res.body.error],
        [401, "passkey_not_verified"],
        JSON.stringify(over),
      );
    }
    const fresh = (await f.owner("/owner/sign-in/options", {})).body;
    assert.equal(
      (await f.owner("/owner/sign-in/verify", { response: key.get(fresh) })).status,
      200,
    );
    assert.equal(
      (await f.owner("/owner/sign-in/verify", { response: authenticator().get(fresh) })).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("state changes need the relay's Origin header, and sign-out ends the session", async () => {
  const f = await ownerFixture();
  try {
    const { cookie } = await setUp(f);
    for (const origin of ["https://evil.company.dev", null]) {
      const res = await f.owner("/owner/sign-in/options", {}, { origin });
      assert.deepEqual([res.status, res.body.error], [403, "origin_mismatch"]);
    }
    assert.equal((await f.owner("/owner/passkeys/step-up", {})).status, 401);
    const out = await f.owner("/owner/sign-out", {}, { cookie });
    assert.equal(out.status, 200);
    assert.equal((await f.owner("/owner", undefined, { cookie })).location, "/owner/sign-in");
    assert.equal((await f.owner("/owner/passkeys/step-up", {}, { cookie })).status, 401);
  } finally {
    await f.close();
  }
});

test("adding a passkey needs a session plus a fresh assertion made for that purpose", async () => {
  const f = await ownerFixture();
  try {
    const { key, cookie } = await setUp(f);
    // A sign-in assertion cannot stand in for the add-passkey step-up.
    const signIn = key.get((await f.owner("/owner/sign-in/options", {})).body);
    assert.equal(
      (await f.owner("/owner/passkeys/options", { assertion: signIn }, { cookie })).status,
      401,
    );
    const second = authenticator();
    const stepUp = (await f.owner("/owner/passkeys/step-up", {}, { cookie })).body;
    const options = await f.owner(
      "/owner/passkeys/options",
      { assertion: key.get(stepUp) },
      { cookie },
    );
    assert.equal(options.status, 200);
    assert.deepEqual(
      options.body.excludeCredentials.map((c) => c.id),
      [key.id],
    );
    assert.equal(
      (
        await f.owner(
          "/owner/passkeys/verify",
          { response: second.create(options.body) },
          { cookie },
        )
      ).status,
      200,
    );
    const fresh = (await f.owner("/owner/sign-in/options", {})).body;
    assert.equal(
      (await f.owner("/owner/sign-in/verify", { response: second.get(fresh) })).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("owner pages fail closed without a valid setup code or relay origin", async () => {
  for (const bindings of [
    { OWNER_SETUP_CODE: "short" },
    { RELAY_PUBLIC_URL: "http://relay.company.dev" },
  ]) {
    const f = await ownerFixture({ bindings });
    try {
      assert.equal((await f.owner("/owner/setup/options", { code: SETUP_CODE })).status, 503);
    } finally {
      await f.close();
    }
  }
});

test("a flood of unauthenticated sign-in challenges cannot lock the owner out", async () => {
  const f = await ownerFixture();
  try {
    const { key } = await setUp(f);
    for (let i = 0; i < 1001; i++)
      assert.equal((await f.owner("/owner/sign-in/options", {})).status, 200);
    const fresh = (await f.owner("/owner/sign-in/options", {})).body;
    assert.equal(
      (await f.owner("/owner/sign-in/verify", { response: key.get(fresh) })).status,
      200,
    );
  } finally {
    await f.close();
  }
});
