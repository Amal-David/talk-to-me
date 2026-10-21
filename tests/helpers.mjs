import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
export const tokens = Object.freeze({
  alpha: "synthetic-alpha-test-token-not-for-production-0001",
  beta: "synthetic-beta-test-token-not-for-production-00002",
  gamma: "synthetic-gamma-test-token-not-for-production-0003",
  admin: "synthetic-admin-test-token-not-for-production-0004",
  other: "synthetic-other-test-token-not-for-production-0005",
});
export function policy(limits = {}) {
  return {
    version: 1,
    groups: {
      demo: {
        peers: ["alpha", "beta", "gamma", "admin"],
        routes: [
          { from: "alpha", to: "beta", topics: ["general"], reply: true },
          { from: "beta", to: "alpha", topics: ["general"], reply: true },
        ],
        limits,
      },
      other: { peers: ["other"], routes: [] },
    },
  };
}
export function authTokens() {
  return Object.entries(tokens).map(([peer, token]) => ({
    sha256: createHash("sha256").update(token).digest("hex"),
    group: peer === "other" ? "other" : "demo",
    peer,
    role: peer === "admin" ? "admin" : "peer",
  }));
}
export async function fixture(options = {}) {
  const bindings = {
    POLICY_JSON:
      typeof options.policy === "string"
        ? options.policy
        : JSON.stringify(options.policy ?? policy(options.limits)),
    AUTH_TOKENS_JSON:
      typeof options.auth === "string"
        ? options.auth
        : JSON.stringify(options.auth ?? authTokens()),
    ...options.bindings,
  };
  const mf = new Miniflare({
    modules: true,
    scriptPath: resolve("dist/worker.js"),
    compatibilityDate: "2026-07-30",
    durableObjects: { GROUPS: { className: "GroupMailbox", useSQLite: true } },
    bindings,
    ...(options.persist ? { durableObjectsPersist: options.persist } : {}),
    // All tests deny network access unless an explicit offline fake is supplied.
    outboundService:
      options.outbound ??
      (() => {
        throw new Error("Unexpected external request");
      }),
  });
  const api = async (peer, path, method = "GET", body, group = "demo") => {
    const result = await mf.dispatchFetch(`https://relay.example/v1/groups/${group}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokens[peer] ?? peer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json() };
  };
  return { mf, api, close: () => mf.dispose() };
}
export async function send(f, key = "request-one", extra = {}) {
  const res = await f.api("alpha", "/requests", "POST", {
    to: "beta",
    topic: "general",
    text: "Synthetic hello",
    idempotencyKey: key,
    ...extra,
  });
  if (res.status !== 200) throw new Error(`Send failed: ${JSON.stringify(res)}`);
  return res.body;
}
