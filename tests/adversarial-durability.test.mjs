import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixture, policy, send } from "./helpers.mjs";

// Read-only inspection of synthetic local persistence proves alarms ran without
// an HTTP status request accidentally triggering the same maintenance sweep.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* Early Node 22 lacks this optional test inspector. */
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function databaseFile(dir) {
  const files = await readdir(dir, { recursive: true });
  const file = files.find((name) => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite"));
  assert.ok(file, "Expected a persisted Durable Object database");
  return join(dir, file);
}
function read(file, sql, ...args) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
}
async function until(check, timeoutMs = 6000) {
  const stop = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < stop);
  throw new Error("Expected durable alarm transition was not observed");
}
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
          token: "synthetic-wake-review-not-a-real-secret",
        },
      }),
    },
  };
}
const sqlite = {
  skip: DatabaseSync
    ? false
    : "Read-only SQLite inspector needs Node 22.13+; not counted as verified on this runtime",
};

test(
  "adversarial durability: expiry and content-purge alarms survive restart without incoming requests",
  sqlite,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "talk-to-me-review-alarms-"));
    let f;
    try {
      f = await fixture({ persist: dir, limits: { retentionSeconds: 1 } });
      const row = await send(f, "alarm-only", { ttlSeconds: 2 });
      const file = await databaseFile(dir);
      await f.close();
      f = undefined;
      f = await fixture({ persist: dir, limits: { retentionSeconds: 1 } });
      await f.mf.ready;
      await until(
        () => read(file, "SELECT state FROM requests WHERE id=?", row.id).state === "expired",
      );
      const purged = await until(() => {
        const value = read(file, "SELECT state,text,purged FROM requests WHERE id=?", row.id);
        return value.purged === 1 && value;
      });
      assert.equal(purged.state, "expired");
      assert.equal(purged.text, null);
    } finally {
      if (f) await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "adversarial durability: final lease deadline dead-letters by alarm without an API-triggered sweep",
  sqlite,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "talk-to-me-review-deadletter-"));
    let f;
    try {
      f = await fixture({ persist: dir, limits: { leaseSeconds: 1, maxAttempts: 1 } });
      const row = await send(f, "dead-letter");
      const claimed = await f.api("beta", "/claim", "POST", { claimKey: "last-attempt" });
      assert.equal(claimed.status, 200);
      const file = await databaseFile(dir);
      await f.close();
      f = undefined;
      f = await fixture({ persist: dir, limits: { leaseSeconds: 1, maxAttempts: 1 } });
      await f.mf.ready;
      await until(
        () => read(file, "SELECT state FROM requests WHERE id=?", row.id).state === "dead_letter",
      );
      const current = read(
        file,
        "SELECT lease_token,lease_until,attempts FROM requests WHERE id=?",
        row.id,
      );
      assert.equal(current.lease_token, null);
      assert.equal(current.lease_until, null);
      assert.equal(current.attempts, 1);
    } finally {
      if (f) await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "adversarial durability: restarted wake alarm observes committed request and in-flight intent before callback",
  sqlite,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "talk-to-me-review-wake-commit-"));
    let f;
    let calls = 0;
    let observed;
    try {
      const options = wakeOptions(async (request) => {
        calls++;
        const payload = await request.json();
        const file = await databaseFile(dir);
        observed = {
          payload,
          url: request.url,
          row: read(file, "SELECT state,text FROM requests WHERE id=?", payload.messageId),
          wake: read(
            file,
            "SELECT state,attempted_at FROM wakes WHERE request_id=?",
            payload.messageId,
          ),
        };
        return new Response(null, { status: 200 });
      });
      f = await fixture({ ...options, persist: dir });
      const row = await send(f, "wake-restart");
      const file = await databaseFile(dir);
      await f.close();
      f = undefined;
      f = await fixture({ ...options, persist: dir });
      await f.mf.ready;
      await until(
        () => read(file, "SELECT state FROM wakes WHERE request_id=?", row.id).state === "started",
      );
      assert.equal(calls, 1);
      assert.equal(observed.row.state, "pending");
      assert.equal(observed.row.text, "Synthetic hello");
      assert.equal(observed.wake.state, "in_flight");
      assert.ok(observed.wake.attempted_at > 0);
      assert.deepEqual(observed.payload, {
        messageId: row.id,
        relay: "https://relay.company.dev/",
      });
      assert.equal(observed.url, "https://hooks.vendor.dev/fixed-routine");
    } finally {
      if (f) await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "adversarial durability: real callback timeout holds the possible effect and does not repeat after restart",
  sqlite,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "talk-to-me-review-timeout-"));
    let f;
    let calls = 0;
    try {
      const options = wakeOptions(async () => {
        calls++; // Represents an effect accepted before its response is lost/delayed.
        await delay(11000);
        return new Response(null, { status: 200 });
      });
      f = await fixture({ ...options, persist: dir });
      const row = await send(f, "timeout");
      const file = await databaseFile(dir);
      await until(
        () => read(file, "SELECT state FROM wakes WHERE request_id=?", row.id).state === "hold",
        15000,
      );
      assert.equal(calls, 1);
      await f.close();
      f = undefined;
      f = await fixture({ ...options, persist: dir });
      await f.mf.ready;
      await delay(1500);
      assert.equal(calls, 1);
      assert.equal(read(file, "SELECT state FROM wakes WHERE request_id=?", row.id).state, "hold");
      assert.equal((await f.api("alpha", `/requests/${row.id}`)).body.state, "pending");
    } finally {
      if (f) await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "adversarial durability: completion write failure rolls back result and acknowledgment atomically",
  sqlite,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "talk-to-me-review-rollback-"));
    let f;
    try {
      f = await fixture({ persist: dir });
      const row = await send(f, "atomic-result");
      const claim = await f.api("beta", "/claim", "POST", { claimKey: "atomic-claim" });
      assert.equal(claim.status, 200);
      const file = await databaseFile(dir);
      // A real SQLite fault after the result UPDATE, not a mocked storage API.
      const db = new DatabaseSync(file);
      try {
        db.exec(
          "CREATE TRIGGER review_fail_completion BEFORE INSERT ON events WHEN NEW.kind='completed' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END",
        );
      } finally {
        db.close();
      }
      const body = {
        leaseToken: claim.body.leaseToken,
        idempotencyKey: "atomic-answer",
        text: "synthetic answer",
      };
      const rejected = await f.api("beta", `/requests/${row.id}/result`, "POST", body);
      assert.equal(rejected.status, 500);
      assert.deepEqual(rejected.body, { error: "internal_error" });
      const unchanged = read(
        file,
        "SELECT state,result_text,result_key,ack_at,lease_token FROM requests WHERE id=?",
        row.id,
      );
      assert.equal(unchanged.state, "leased");
      assert.equal(unchanged.result_text, null);
      assert.equal(unchanged.result_key, null);
      assert.equal(unchanged.ack_at, null);
      assert.equal(unchanged.lease_token, claim.body.leaseToken);
      const recovery = new DatabaseSync(file);
      try {
        recovery.exec("DROP TRIGGER review_fail_completion");
      } finally {
        recovery.close();
      }
      assert.equal((await f.api("beta", `/requests/${row.id}/result`, "POST", body)).status, 200);
    } finally {
      if (f) await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
