import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const sha256hex = (value) => createHash("sha256").update(value).digest("hex");
// Synthetic connection tokens in the relay's ttm_ + 43 base64url character format.
const syntheticToken = (name) =>
  `ttm_${createHash("sha256").update(`synthetic-${name}`).digest("base64url")}`;
export const tokens = Object.freeze({
  alpha: syntheticToken("alpha"),
  beta: syntheticToken("beta"),
  gamma: syntheticToken("gamma"),
  other: syntheticToken("other"),
});
const groupOf = (peer) => (peer === "other" ? "other" : "demo");
export function policy(limits = {}) {
  return {
    version: 1,
    groups: {
      demo: {
        peers: ["alpha", "beta", "gamma"],
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
export async function fixture(options = {}) {
  const bindings = {
    POLICY_JSON:
      typeof options.policy === "string"
        ? options.policy
        : JSON.stringify(options.policy ?? policy(options.limits)),
    ...options.bindings,
  };
  const mf = new Miniflare({
    modules: true,
    scriptPath: resolve("dist/worker.js"),
    compatibilityDate: "2026-07-30",
    durableObjects: {
      GROUPS: { className: "GroupMailbox", useSQLite: true },
      OWNER: { className: "Owner", useSQLite: true },
    },
    kvNamespaces: ["OAUTH_KV"],
    bindings,
    ...(options.persist ? { durableObjectsPersist: options.persist } : {}),
    // All tests deny network access unless an explicit offline fake is supplied.
    outboundService:
      options.outbound ??
      (() => {
        throw new Error("Unexpected external request");
      }),
  });
  const ownerNamespace = await mf.getDurableObjectNamespace("OWNER");
  const ownerStub = ownerNamespace.get(ownerNamespace.idFromName("owner"));
  // Gives a peer a connection token the way the owner pages would, minus the passkey ceremony.
  const connect = async (peer, token, days = 30) =>
    ownerStub.createConnection({
      group: groupOf(peer),
      peer,
      days,
      label: `synthetic ${peer}`,
      credential: { kind: "token", tokenHash: sha256hex(token) },
    });
  // A restarted fixture on persisted storage already holds these connections.
  for (const [peer, token] of Object.entries(tokens))
    if (!(await ownerStub.tokenConnection(token))) await connect(peer, token);
  const groupsNamespace = await mf.getDurableObjectNamespace("GROUPS");
  // Owner-only group controls, called the way the Owner object calls them.
  const control = (change, group = "demo") =>
    groupsNamespace.get(groupsNamespace.idFromName(group)).control(group, change);
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
  return { mf, api, connect, control, close: () => mf.dispose() };
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
