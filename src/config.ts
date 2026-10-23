import type { Config, Env, GroupPolicy, Limits, Token, WakeEndpoint } from "./types";
import { digest, fail, fields, identifier, integer, object } from "./validation";

export const DEFAULT_LIMITS: Limits = {
  leaseSeconds: 60,
  maxAttempts: 3,
  maxPending: 100,
  maxRequests: 10000,
  maxClaims: 30000,
  maxTextBytes: 8192,
  maxTtlSeconds: 86400,
  maxHops: 3,
  retentionSeconds: 604800,
  ratePerMinute: 120,
};
const RANGES: Record<keyof Limits, [number, number]> = {
  leaseSeconds: [1, 300],
  maxAttempts: [1, 10],
  maxPending: [1, 1000],
  maxRequests: [1, 100000],
  maxClaims: [1, 1000000],
  maxTextBytes: [1, 16384],
  maxTtlSeconds: [1, 604800],
  maxHops: [0, 5],
  retentionSeconds: [1, 2592000],
  ratePerMinute: [1, 1000],
};
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(400, "invalid_list");
  return value as unknown[];
}
function group(value: unknown): GroupPolicy {
  const v = object(value);
  fields(v, ["peers", "routes", "limits", "wake"]);
  const peers = list(v.peers, 100).map(identifier);
  if (!peers.length || new Set(peers).size !== peers.length) fail(400, "invalid_peers");
  const routes = list(v.routes, 1000).map((r) => {
    const route = object(r);
    fields(route, ["from", "to", "topics", "reply"]);
    const from = identifier(route.from);
    const to = identifier(route.to);
    const topics = list(route.topics, 100).map(identifier);
    if (
      !peers.includes(from) ||
      !peers.includes(to) ||
      from === to ||
      !topics.length ||
      typeof route.reply !== "boolean"
    )
      fail(400, "invalid_route");
    return { from, to, topics, reply: route.reply };
  });
  const limits = { ...DEFAULT_LIMITS };
  if (v.limits !== undefined) {
    const raw = object(v.limits);
    fields(raw, Object.keys(RANGES));
    for (const key of Object.keys(raw) as (keyof Limits)[])
      limits[key] = integer(raw[key], ...RANGES[key]);
  }
  const wake: GroupPolicy["wake"] = Object.create(null);
  if (v.wake !== undefined)
    for (const [peer, input] of Object.entries(object(v.wake))) {
      if (!peers.includes(peer)) fail(400, "invalid_wake_peer");
      const item = object(input);
      fields(item, ["adapter", "endpointId"]);
      if (item.adapter !== "grok") fail(400, "unverified_adapter");
      wake[peer] = { adapter: "grok", endpointId: identifier(item.endpointId) };
    }
  return { peers, routes, limits, wake };
}
export function config(env: Env): Config {
  try {
    const policy = object(JSON.parse(env.POLICY_JSON ?? ""));
    fields(policy, ["version", "groups"]);
    if (policy.version !== 1) fail(400, "invalid_version");
    const groups: Record<string, GroupPolicy> = Object.create(null);
    const entries = Object.entries(object(policy.groups));
    if (entries.length > 100) fail(400, "too_many_groups");
    for (const [name, value] of entries) groups[identifier(name)] = group(value);
    const seen = new Set<string>();
    const tokens: Token[] = list(JSON.parse(env.AUTH_TOKENS_JSON ?? ""), 1000).map((input) => {
      const item = object(input);
      fields(item, ["sha256", "group", "peer", "role", "notAfter"]);
      const name = identifier(item.group);
      const peer = identifier(item.peer);
      if (
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        seen.has(item.sha256)
      )
        fail(400, "invalid_token_binding");
      seen.add(item.sha256);
      if (!groups[name]?.peers.includes(peer) || (item.role !== "peer" && item.role !== "admin"))
        fail(400, "invalid_token_scope");
      const token: Token = { sha256: item.sha256, group: name, peer, role: item.role };
      if (item.notAfter !== undefined)
        token.notAfter = integer(item.notAfter, 1, Number.MAX_SAFE_INTEGER);
      return token;
    });
    if (!tokens.length || !entries.length) fail(400, "empty_config");
    // A configured wake route is invalid unless its separately provisioned endpoint is valid.
    for (const [name, policy] of Object.entries(groups))
      for (const [peer, wake] of Object.entries(policy.wake))
        wakeEndpoint(env, wake.endpointId, name, peer);
    return { groups, tokens };
  } catch {
    return fail(503, "configuration_unavailable");
  }
}
export async function authenticate(request: Request, cfg: Config, name: string): Promise<Token> {
  const header = request.headers.get("authorization");
  if (!header || !/^Bearer [A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(header))
    fail(401, "unauthorized");
  const hash = await digest(header.slice(7));
  const token = cfg.tokens.find((t) => t.sha256 === hash && t.group === name);
  if (!token || (token.notAfter !== undefined && Date.now() >= token.notAfter))
    fail(401, "unauthorized");
  return token;
}
export function routeAllowed(
  policy: GroupPolicy,
  from: string,
  to: string,
  topic: string,
  reply = false,
): boolean {
  return policy.routes.some(
    (r) => r.from === from && r.to === to && r.topics.includes(topic) && (!reply || r.reply),
  );
}
function publicHttps(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2048) fail(400, "invalid_endpoint");
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.port ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      url.hostname,
    ) ||
    /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname) ||
    /^[\d.]+$/.test(url.hostname)
  )
    fail(400, "invalid_endpoint");
  return url;
}
export function wakeEndpoint(env: Env, id: string, name: string, peer: string): WakeEndpoint {
  const items = object(JSON.parse(env.WAKE_ENDPOINTS_JSON ?? ""));
  const item = object(items[id]);
  fields(item, ["group", "peer", "url", "allowedOrigin", "token"]);
  if (item.group !== name || item.peer !== peer) fail(400, "invalid_endpoint_scope");
  const url = publicHttps(item.url);
  const origin = publicHttps(item.allowedOrigin);
  if (origin.href !== `${origin.origin}/` || url.origin !== origin.origin || url.pathname === "/")
    fail(400, "invalid_endpoint_origin");
  if (typeof item.token !== "string" || !/^[A-Za-z0-9._~+/-]{16,256}={0,2}$/.test(item.token))
    fail(400, "invalid_endpoint_token");
  relayOrigin(env); // A wake carries the relay origin, so it must be valid too.
  return { group: name, peer, url: url.href, allowedOrigin: origin.origin, token: item.token };
}
export function relayOrigin(env: Env): URL {
  const relay = publicHttps(env.RELAY_PUBLIC_URL);
  if (relay.href !== `${relay.origin}/`) fail(400, "invalid_relay_origin");
  return relay;
}
