import assert from "node:assert/strict";
import test from "node:test";
import { fixture, policy, send } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function wakeOptions(outbound) {
  const p = policy();
  p.groups.demo.wake = { beta: { adapter: "grok", endpointId: "beta-wake" } };
  return {
    policy: p,
    outbound,
    bindings: {
      RELAY_PUBLIC_URL: "https://relay.company.dev/",
      WAKE_ENDPOINTS_JSON: JSON.stringify({
        "beta-wake": {
          group: "demo",
          peer: "beta",
          url: "https://hooks.vendor.dev/fixed-routine",
          allowedOrigin: "https://hooks.vendor.dev",
          token: "synthetic-wake-only-not-a-real-credential",
        },
      }),
    },
  };
}
async function until(check) {
  for (let i = 0; i < 30; i++) {
    const result = await check();
    if (result) return result;
    await sleep(200);
  }
  throw new Error("Expected alarm outcome not observed");
}

test("Grok-compatible wake commits intent, sends only opaque reference, and 200 is started not completed", async () => {
  let calls = 0,
    payload,
    headers,
    url;
  const f = await fixture(
    wakeOptions(async (request) => {
      calls++;
      url = request.url;
      payload = await request.json();
      headers = request.headers;
      return new Response("ignored", { status: 200 });
    }),
  );
  try {
    const request = await send(f);
    const status = await until(async () => {
      const r = await f.api("alpha", `/requests/${request.id}`);
      return r.body.wake.state === "started" && r.body;
    });
    assert.equal(status.state, "pending");
    assert.equal(status.result, null);
    assert.equal(calls, 1);
    assert.deepEqual(payload, { messageId: request.id, relay: "https://relay.company.dev/" });
    assert.equal(url, "https://hooks.vendor.dev/fixed-routine");
    assert.equal(headers.get("authorization"), "Bearer synthetic-wake-only-not-a-real-credential");
    assert.equal(JSON.stringify(status).includes("credential"), false);
  } finally {
    await f.close();
  }
});

for (const mode of ["redirect", "server-error", "network-error"])
  test(`${mode} is held without automatic wake retry`, async () => {
    let calls = 0;
    const f = await fixture(
      wakeOptions(() => {
        calls++;
        if (mode === "network-error") throw new Error("Synthetic network failure");
        return new Response(null, {
          status: mode === "redirect" ? 302 : 503,
          headers: { location: "https://unapproved.invalid/steal" },
        });
      }),
    );
    try {
      const request = await send(f);
      await until(async () => {
        const r = await f.api("alpha", `/requests/${request.id}`);
        return r.body.wake.state === "hold";
      });
      await sleep(1200);
      assert.equal(calls, 1);
      assert.equal((await f.api("alpha", `/requests/${request.id}`)).body.state, "pending");
    } finally {
      await f.close();
    }
  });

test("cancel and revocation before wake dispatch suppress all external calls", async () => {
  for (const action of ["cancel", "disable"]) {
    let calls = 0;
    const f = await fixture(
      wakeOptions(() => {
        calls++;
        return new Response(null, { status: 200 });
      }),
    );
    try {
      const request = await send(f);
      if (action === "cancel") await f.api("alpha", `/requests/${request.id}/cancel`, "POST", {});
      else await f.control({ disablePeer: "beta" });
      await sleep(1300);
      assert.equal(calls, 0);
    } finally {
      await f.close();
    }
  }
});
