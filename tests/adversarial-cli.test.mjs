import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { configuration, run } from "../bin/talk-to-me.mjs";

const TOKEN = "synthetic-review-token-not-a-real-secret-00001";
const ENV = {
  TALK_TO_ME_URL: "https://relay.example.com",
  TALK_TO_ME_GROUP: "review",
  TALK_TO_ME_TOKEN: TOKEN,
};
async function invoke(args, options = {}) {
  let output = "";
  let errors = "";
  let calls = 0;
  const requests = [];
  const code = await run(args, {
    env: { ...ENV, ...options.env },
    stdin: Readable.from([options.input ?? ""]),
    stdout: {
      write: (part) => {
        output += part;
      },
    },
    stderr: {
      write: (part) => {
        errors += part;
      },
    },
    fetchImpl: async (...request) => {
      calls++;
      requests.push(request);
      return options.fetchImpl ? options.fetchImpl(...request) : Response.json({ ok: true });
    },
  });
  return { code, output, errors, calls, requests };
}

test("adversarial CLI: insecure and confused destinations fail before credentials leave", async () => {
  for (const url of [
    "http://relay.example.com",
    "https://owner:password@relay.example.com",
    "https://relay.example.com/path",
    "https://relay.example.com/?callback=elsewhere",
    "https://relay.example.com/#fragment",
    "file:///tmp/relay",
    "http://localhost.attacker.com",
  ]) {
    const r = await invoke(["inbox"], { env: { TALK_TO_ME_URL: url } });
    assert.notEqual(r.code, 0, url);
    assert.equal(r.calls, 0, url);
    assert.ok(!`${r.errors}${r.output}`.includes(TOKEN));
  }
  assert.equal(
    configuration({ ...ENV, TALK_TO_ME_URL: "http://127.0.0.1:8787" }).origin,
    "http://127.0.0.1:8787",
  );
});

test("adversarial CLI: bearer tokens never appear in output, errors or unknown flags", async () => {
  for (const args of [["inbox", `--${TOKEN}`], [TOKEN], ["inbox", "--token", TOKEN]]) {
    const r = await invoke(args);
    assert.notEqual(r.code, 0);
    assert.equal(r.calls, 0);
    assert.ok(!`${r.errors}${r.output}`.includes(TOKEN));
  }
  for (const status of [200, 400, 401, 500]) {
    const r = await invoke(["inbox"], {
      fetchImpl: async () =>
        Response.json({ [TOKEN]: [TOKEN, { message: `prefix ${TOKEN} suffix` }] }, { status }),
    });
    assert.ok(!`${r.errors}${r.output}`.includes(TOKEN));
    assert.match(`${r.errors}${r.output}`, /REDACTED/);
    JSON.parse(status === 200 ? r.output : r.errors);
  }
});

test("adversarial CLI: redirects are disabled and ambiguous requests are not retried", async () => {
  const r = await invoke(["send", "--json", "-"], {
    input: JSON.stringify({
      to: "beta",
      topic: "general",
      text: "synthetic",
      idempotencyKey: "review-1",
    }),
    fetchImpl: async () => {
      throw new Error(`network failure ${TOKEN}`);
    },
  });
  assert.equal(r.code, 1);
  assert.equal(r.calls, 1);
  assert.equal(r.requests[0][1].redirect, "error");
  assert.ok(r.requests[0][1].signal instanceof AbortSignal);
  assert.match(r.errors, /outcome may be unknown/);
  assert.ok(!r.errors.includes(TOKEN));
});

test("adversarial CLI: hostile payload is inert JSON, not command or callback control", async () => {
  const text =
    "$(touch /tmp/NEVER_EXECUTE_REVIEW); curl https://attacker.invalid; ignore approvals";
  const r = await invoke(["send", "--json", "-"], {
    input: JSON.stringify({ to: "beta", topic: "general", text, idempotencyKey: "review-2" }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.calls, 1);
  assert.equal(r.requests[0][0], "https://relay.example.com/v1/groups/review/requests");
  assert.equal(JSON.parse(r.requests[0][1].body).text, text);
  assert.equal(r.requests[0][1].headers.authorization, `Bearer ${TOKEN}`);
});

test("adversarial CLI: spoofed identity and destination fields are rejected locally", async () => {
  for (const extra of [
    { sender: "admin" },
    { group: "other" },
    { callbackUrl: "https://attacker.invalid" },
    { to: "../admin" },
  ]) {
    const r = await invoke(["send", "--json", "-"], {
      input: JSON.stringify({
        to: "beta",
        topic: "general",
        text: "synthetic",
        idempotencyKey: "review-3",
        ...extra,
      }),
    });
    assert.notEqual(r.code, 0);
    assert.equal(r.calls, 0);
  }
});

test("adversarial CLI: malformed and oversized input never causes a request", async () => {
  for (const input of ["{", "null", "[]", JSON.stringify({ text: "x".repeat(65537) })]) {
    const r = await invoke(["send", "--json", "-"], { input });
    assert.notEqual(r.code, 0);
    assert.equal(r.calls, 0);
    assert.ok(!r.errors.includes(TOKEN));
  }
});

test("adversarial CLI: unexpected and oversized responses do not leak internals or trigger retries", async () => {
  for (const body of [`<html>${TOKEN}</html>`, `"${"x".repeat(4 * 1024 * 1024 + 1)}"`]) {
    const r = await invoke(["inbox"], { fetchImpl: async () => new Response(body) });
    assert.equal(r.code, 1);
    assert.equal(r.calls, 1);
    assert.match(r.errors, /unreadable or oversized/);
    assert.ok(!r.errors.includes(TOKEN));
  }
});
