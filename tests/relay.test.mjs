import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixture, send } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("two synthetic agents: enqueue, lease, delivery ack, canonical result and sender outbox", async () => {
  const f = await fixture();
  try {
    const request = await send(f);
    const delivery = await f.api("beta", "/claim", "POST", { claimKey: "poll-1" });
    assert.equal(delivery.body.request.id, request.id);
    assert.equal(delivery.body.request.attempts, 1);
    const lease = delivery.body.leaseToken;
    const ack = await f.api("beta", `/requests/${request.id}/ack`, "POST", { leaseToken: lease });
    assert.equal(ack.body.state, "leased");
    assert.ok(ack.body.acknowledgedAt);
    const input = { leaseToken: lease, idempotencyKey: "result-1", text: "Synthetic reply" };
    const result = await f.api("beta", `/requests/${request.id}/result`, "POST", input);
    assert.equal(result.body.state, "completed");
    assert.equal(result.body.result.text, "Synthetic reply");
    assert.equal(
      (await f.api("beta", `/requests/${request.id}/result`, "POST", input)).status,
      200,
    );
    assert.equal(
      (await f.api("beta", `/requests/${request.id}/result`, "POST", { ...input, text: "Changed" }))
        .status,
      409,
    );
    const seen = await f.api("alpha", `/requests/${request.id}`);
    assert.equal(seen.body.result.text, "Synthetic reply");
    assert.equal(JSON.stringify(seen).includes(lease), false);
    assert.equal((await f.api("alpha", "/outbox")).body.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("concurrent duplicate enqueue and claim preserve one request, one lease and one canonical result", async () => {
  const f = await fixture();
  try {
    const requests = await Promise.all(Array.from({ length: 10 }, () => send(f, "same-key")));
    assert.equal(new Set(requests.map((r) => r.id)).size, 1);
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        f.api("beta", "/claim", "POST", { claimKey: `claim-${i}` }),
      ),
    );
    assert.equal(claims.filter((r) => r.body !== null).length, 1);
    const claim = claims.find((r) => r.body !== null).body;
    const replies = await Promise.all(
      ["first", "second"].map((text) =>
        f.api("beta", `/requests/${claim.request.id}/result`, "POST", {
          leaseToken: claim.leaseToken,
          idempotencyKey: text,
          text,
        }),
      ),
    );
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  } finally {
    await f.close();
  }
});

test("durable restart/replay preserves accepted requests, claim receipts, result and fencing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "talk-to-me-restart-"));
  let f = await fixture({ persist: directory });
  try {
    const request = await send(f, "durable-key");
    const claim = (await f.api("beta", "/claim", "POST", { claimKey: "durable-claim" })).body;
    await f.close();
    f = await fixture({ persist: directory });
    const replay = await send(f, "durable-key");
    assert.equal(replay.id, request.id);
    assert.equal(replay.attempts, 1);
    const resumed = (await f.api("beta", "/claim", "POST", { claimKey: "durable-claim" })).body;
    assert.equal(resumed.leaseToken, claim.leaseToken);
    const result = {
      leaseToken: claim.leaseToken,
      idempotencyKey: "durable-result",
      text: "Recovered reply",
    };
    assert.equal(
      (await f.api("beta", `/requests/${request.id}/result`, "POST", result)).status,
      200,
    );
    await f.close();
    f = await fixture({ persist: directory });
    assert.equal(
      (await f.api("beta", `/requests/${request.id}/result`, "POST", result)).status,
      200,
    );
    assert.equal(
      (await f.api("alpha", `/requests/${request.id}`)).body.result.text,
      "Recovered reply",
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired lease retries with a new nonce and bounded final attempt dead-letters", async () => {
  const f = await fixture({ limits: { leaseSeconds: 1, maxAttempts: 2 } });
  try {
    const request = await send(f, "retry");
    const first = (await f.api("beta", "/claim", "POST", { claimKey: "first" })).body;
    await sleep(1200);
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "first" })).status, 409);
    const second = (await f.api("beta", "/claim", "POST", { claimKey: "second" })).body;
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(second.request.attempts, 2);
    assert.equal(
      (await f.api("beta", `/requests/${request.id}/ack`, "POST", { leaseToken: first.leaseToken }))
        .status,
      409,
    );
    await sleep(1200);
    assert.equal((await f.api("alpha", `/requests/${request.id}`)).body.state, "dead_letter");
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "third" })).body, null);
  } finally {
    await f.close();
  }
});

test("expiry dominates lease retry; retention purges text but not idempotency history", async () => {
  const f = await fixture({ limits: { leaseSeconds: 1, maxAttempts: 1, retentionSeconds: 1 } });
  try {
    const request = await send(f, "expires", { ttlSeconds: 1 });
    await f.api("beta", "/claim", "POST", { claimKey: "one" });
    await sleep(1250);
    assert.equal((await f.api("alpha", `/requests/${request.id}`)).body.state, "expired");
    await sleep(1250);
    const purged = (await f.api("alpha", `/requests/${request.id}`)).body;
    assert.equal(purged.text, null);
    assert.equal(purged.purged, true);
    const replay = await send(f, "expires", { ttlSeconds: 1 });
    assert.equal(replay.id, request.id);
    assert.equal(replay.state, "expired");
    assert.equal(replay.text, null);
    assert.equal(
      (
        await f.api("alpha", "/requests", "POST", {
          to: "beta",
          topic: "general",
          text: "changed",
          idempotencyKey: "expires",
          ttlSeconds: 1,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("empty claim keys never consume newly arriving work on replay", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "empty" })).body, null);
    await send(f);
    assert.equal((await f.api("beta", "/claim", "POST", { claimKey: "empty" })).body, null);
    assert.ok((await f.api("beta", "/claim", "POST", { claimKey: "new" })).body);
  } finally {
    await f.close();
  }
});
