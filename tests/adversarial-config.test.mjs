import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/config.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { config, authenticate, wakeEndpoint } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const TOKEN = "synthetic-review-token-not-a-real-secret-00001";
const hash = createHash("sha256").update(TOKEN).digest("hex");
function environment() {
  return {
    POLICY_JSON: JSON.stringify({
      version: 1,
      groups: {
        review: {
          peers: ["alpha", "beta"],
          routes: [{ from: "alpha", to: "beta", topics: ["general"], reply: true }],
        },
      },
    }),
    AUTH_TOKENS_JSON: JSON.stringify([
      { sha256: hash, group: "review", peer: "alpha", role: "peer" },
    ]),
  };
}
function expectClosed(env) {
  assert.throws(
    () => config(env),
    (error) => error.status === 503 && error.code === "configuration_unavailable",
  );
}
function wakeEnvironment(url = "https://hooks.vendor.com/routine") {
  const env = environment();
  const policy = JSON.parse(env.POLICY_JSON);
  policy.groups.review.wake = { beta: { adapter: "grok", endpointId: "wake-beta" } };
  env.POLICY_JSON = JSON.stringify(policy);
  env.WAKE_ENDPOINTS_JSON = JSON.stringify({
    "wake-beta": {
      group: "review",
      peer: "beta",
      url,
      allowedOrigin: "https://hooks.vendor.com",
      token: "synthetic-wake-not-a-real-secret-00001",
    },
  });
  env.RELAY_PUBLIC_URL = "https://relay.vendor.com";
  return env;
}

test("adversarial configuration: missing and malformed registry or policy fail closed", () => {
  for (const env of [
    {},
    { ...environment(), POLICY_JSON: "{" },
    { ...environment(), AUTH_TOKENS_JSON: "[]" },
    { ...environment(), AUTH_TOKENS_JSON: "null" },
  ])
    expectClosed(env);
  for (const policy of [
    { version: 2, groups: {} },
    { version: 1, groups: {} },
    { version: 1, groups: { review: { peers: ["alpha"], routes: [], allowAll: true } } },
  ])
    expectClosed({ ...environment(), POLICY_JSON: JSON.stringify(policy) });
});

test("adversarial configuration: ambiguous and invalid token bindings are rejected", () => {
  const env = environment();
  const valid = JSON.parse(env.AUTH_TOKENS_JSON)[0];
  for (const records of [
    [valid, { ...valid, peer: "beta" }],
    [{ ...valid, role: "superadmin" }],
    [{ ...valid, peer: "outsider" }],
    [{ ...valid, group: "other" }],
    [{ ...valid, sha256: "not-a-hash" }],
    [{ ...valid, notAfter: 1e30 }],
  ])
    expectClosed({ ...env, AUTH_TOKENS_JSON: JSON.stringify(records) });
});

test("adversarial configuration: authentication binds group, token and expiry", async () => {
  const cfg = config(environment());
  const request = (authorization) =>
    new Request("https://relay.vendor.com", { headers: authorization ? { authorization } : {} });
  for (const authorization of [
    undefined,
    "Bearer wrong",
    `Basic ${TOKEN}`,
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN}\tinvalid`,
  ]) {
    await assert.rejects(
      authenticate(request(authorization), cfg, "review"),
      (error) => error.status === 401,
    );
  }
  await assert.rejects(
    authenticate(request(`Bearer ${TOKEN}`), cfg, "other"),
    (error) => error.status === 401,
  );
  assert.equal((await authenticate(request(`Bearer ${TOKEN}`), cfg, "review")).peer, "alpha");
  cfg.tokens[0].notAfter = Date.now() - 1;
  await assert.rejects(
    authenticate(request(`Bearer ${TOKEN}`), cfg, "review"),
    (error) => error.status === 401,
  );
});

test("adversarial configuration: callback rejects literal private destinations and URL ambiguity", () => {
  for (const url of [
    "http://hooks.vendor.com/routine",
    "https://127.0.0.1/routine",
    "https://0x7f000001/routine",
    "https://[::1]/routine",
    "https://169.254.169.254/metadata",
    "https://localhost/routine",
    "https://host.internal/routine",
    "https://hooks.vendor.com/routine?next=secret",
    "https://hooks.vendor.com/routine#fragment",
    "https://user:pass@hooks.vendor.com/routine",
    "https://hooks.vendor.com:444/routine",
    "https://attacker.com/routine",
  ])
    expectClosed(wakeEnvironment(url));
  assert.equal(
    wakeEndpoint(wakeEnvironment(), "wake-beta", "review", "beta").url,
    "https://hooks.vendor.com/routine",
  );
});

test("adversarial configuration: callback requires exact enrollment and supported adapter", () => {
  for (const patch of [
    { group: "other" },
    { peer: "alpha" },
    { allowedOrigin: "https://hooks.vendor.com/other" },
    { token: "short" },
  ]) {
    const env = wakeEnvironment();
    const endpoints = JSON.parse(env.WAKE_ENDPOINTS_JSON);
    Object.assign(endpoints["wake-beta"], patch);
    env.WAKE_ENDPOINTS_JSON = JSON.stringify(endpoints);
    expectClosed(env);
  }
  const env = wakeEnvironment();
  const policy = JSON.parse(env.POLICY_JSON);
  policy.groups.review.wake.beta.adapter = "arbitrary-fetch";
  env.POLICY_JSON = JSON.stringify(policy);
  expectClosed(env);
});

test("adversarial configuration: extreme quotas and malformed routes fail closed", () => {
  for (const patch of [
    { limits: { leaseSeconds: 0 } },
    { limits: { maxTtlSeconds: Number.MAX_SAFE_INTEGER } },
    { peers: ["alpha", "alpha"] },
    { routes: [{ from: "alpha", to: "outsider", topics: ["general"], reply: true }] },
    { routes: [{ from: "alpha", to: "beta", topics: ["general"], reply: "true" }] },
  ]) {
    const env = environment();
    const policy = JSON.parse(env.POLICY_JSON);
    Object.assign(policy.groups.review, patch);
    env.POLICY_JSON = JSON.stringify(policy);
    expectClosed(env);
  }
});
