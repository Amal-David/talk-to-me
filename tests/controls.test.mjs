import assert from "node:assert/strict";
import test from "node:test";
import { fixture, send } from "./helpers.mjs";

test("pause denies payload reads and writes, permits sender cancel, and resumes explicitly", async () => {
  const f = await fixture();
  try {
    const row = await send(f);
    assert.equal((await f.api("admin", "/control", "POST", { paused: true })).status, 200);
    for (const [peer, path, method, body] of [
      ["alpha", `/requests/${row.id}`, "GET"],
      ["beta", "/inbox", "GET"],
      ["alpha", "/outbox", "GET"],
      ["beta", "/claim", "POST", { claimKey: "paused" }],
    ])
      assert.equal((await f.api(peer, path, method, body)).status, 503);
    assert.equal((await f.api("alpha", `/requests/${row.id}/cancel`, "POST", {})).status, 200);
    assert.equal((await f.api("admin", "/control", "POST", { paused: false })).status, 200);
    assert.equal((await f.api("alpha", `/requests/${row.id}`)).body.state, "cancelled");
  } finally {
    await f.close();
  }
});

test("pending and lifetime request caps reject new acceptance but permit exact replay", async () => {
  for (const limits of [{ maxPending: 1 }, { maxRequests: 1 }]) {
    const f = await fixture({ limits });
    try {
      const row = await send(f, "one");
      assert.equal((await send(f, "one")).id, row.id);
      assert.equal(
        (
          await f.api("alpha", "/requests", "POST", {
            to: "beta",
            topic: "general",
            text: "two",
            idempotencyKey: "two",
          })
        ).status,
        429,
      );
    } finally {
      await f.close();
    }
  }
});

test("claim and peer-rate quotas are bounded, scoped and preserve receipt recovery", async () => {
  let f = await fixture({ limits: { maxClaims: 1 } });
  try {
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "one" })).body, null);
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "two" })).status, 429);
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "one" })).body, null);
  } finally {
    await f.close();
  }
  f = await fixture({ limits: { ratePerMinute: 1 } });
  try {
    assert.equal((await f.api("alpha", "/outbox")).status, 200);
    assert.equal((await f.api("alpha", "/outbox")).status, 429);
    assert.equal((await f.api("beta", "/inbox")).status, 200);
  } finally {
    await f.close();
  }
});

test("lineage is server derived, recipient bound, scoped and capped", async () => {
  const f = await fixture({ limits: { maxHops: 1 } });
  try {
    const parent = await send(f);
    const child = await f.api("beta", "/requests", "POST", {
      to: "alpha",
      topic: "general",
      text: "Follow up",
      idempotencyKey: "child",
      parentRequestId: parent.id,
    });
    assert.equal(child.status, 200);
    assert.equal(child.body.hopCount, 1);
    assert.ok(child.body.expiresAt <= parent.expiresAt);
    const grandchild = await f.api("alpha", "/requests", "POST", {
      to: "beta",
      topic: "general",
      text: "Too deep",
      idempotencyKey: "grandchild",
      parentRequestId: child.body.id,
    });
    assert.equal(grandchild.status, 403);
    assert.equal(grandchild.body.error, "hop_limit");
    const forged = await f.api("alpha", "/requests", "POST", {
      to: "beta",
      topic: "general",
      text: "Wrong parent",
      idempotencyKey: "forged",
      parentRequestId: parent.id,
    });
    assert.equal(forged.status, 403);
  } finally {
    await f.close();
  }
});
