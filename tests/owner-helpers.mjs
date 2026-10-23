import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fixture } from "./helpers.mjs";

export const OWNER_ORIGIN = "https://relay.company.dev";
export const SETUP_CODE = "synthetic-owner-setup-code-not-for-production-0001";
export async function ownerFixture(options = {}) {
  const f = await fixture({
    ...options,
    bindings: { RELAY_PUBLIC_URL: OWNER_ORIGIN, OWNER_SETUP_CODE: SETUP_CODE, ...options.bindings },
  });
  // Any request to the relay origin; the body is parsed as JSON when it is JSON.
  const request = async (path, init = {}) => {
    const res = await f.mf.dispatchFetch(`${OWNER_ORIGIN}${path}`, { redirect: "manual", ...init });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const cookies = res.headers.getSetCookie();
    return {
      status: res.status,
      body: parsed,
      cookies,
      cookie: cookies[0]?.split(";")[0],
      location: res.headers.get("location"),
    };
  };
  // GET when body is undefined, otherwise a JSON POST carrying the relay's Origin header.
  const owner = (path, body, { cookie, origin = OWNER_ORIGIN } = {}) =>
    request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(body !== undefined && origin ? { Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...f, request, owner };
}

// Minimal CBOR encoder covering what WebAuthn fixtures need: integers, text, bytes and maps.
function cbor(value) {
  const head = (major, n) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}

// A software passkey: real P-256 signatures over hand-built authenticator data. `over` changes one
// field (origin, rpId, uv, counter) to produce the malformed responses the relay must reject.
export function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const rawId = randomBytes(16);
  const id = rawId.toString("base64url");
  let counter = 0;
  const sha256 = (data) => createHash("sha256").update(data).digest();
  const authData = (over, extra = Buffer.alloc(0)) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(over.counter ?? counter);
    const flags = 0x01 | (over.uv === false ? 0 : 0x04) | (extra.length ? 0x40 : 0);
    return Buffer.concat([
      sha256(over.rpId ?? new URL(OWNER_ORIGIN).hostname),
      Buffer.from([flags]),
      count,
      extra,
    ]);
  };
  const clientData = (type, options, over) =>
    Buffer.from(
      JSON.stringify({
        type,
        challenge: options.challenge,
        origin: over.origin ?? OWNER_ORIGIN,
        crossOrigin: false,
      }),
    );
  return {
    id,
    create(options, over = {}) {
      const key = new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(rawId.length);
      const attested = Buffer.concat([Buffer.alloc(16), idLength, rawId, cbor(key)]);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", options, over).toString("base64url"),
          attestationObject: cbor({
            fmt: "none",
            attStmt: {},
            authData: authData(over, attested),
          }).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    get(options, over = {}) {
      if (over.counter === undefined) counter += 1;
      const data = authData(over);
      const client = clientData("webauthn.get", options, over);
      const signature = sign("sha256", Buffer.concat([data, sha256(client)]), privateKey);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: data.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}

// Registers the first passkey through the setup page and returns it with the session cookie.
export async function setUp(f, key = authenticator()) {
  const options = await f.owner("/owner/setup/options", { code: SETUP_CODE });
  assert.equal(options.status, 200);
  const done = await f.owner("/owner/setup/verify", {
    code: SETUP_CODE,
    response: key.create(options.body),
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { key, cookie: done.cookie };
}

export const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
// An owner fixture with OAuth and the MCP endpoint enabled.
export const oauthFixture = () =>
  ownerFixture({ bindings: { OAUTH_REDIRECT_URIS: JSON.stringify([CHATGPT_REDIRECT]) } });

export const LEGACY = "2025-11-25";
export const MODERN = "2026-07-28";
// One JSON-RPC call to /mcp, shaped the way each protocol era sends it (both seen from real hosts).
export async function mcpCall(f, token, method, params = {}, version = LEGACY) {
  const modern = version === MODERN;
  const meta = {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "synthetic-client", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const res = await f.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      ...(modern ? { "Mcp-Method": method } : {}),
      ...(modern && params.name ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern ? { ...params, _meta: meta } : params,
    }),
  });
  // Replies may be a JSON body or a single-event SSE stream.
  const message =
    typeof res.body === "string"
      ? JSON.parse(
          res.body
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? "null",
        )
      : res.body;
  return { status: res.status, message };
}
// Calls a tool and decodes its JSON text content.
export async function tool(f, token, name, args = {}, version = LEGACY) {
  const { status, message } = await mcpCall(
    f,
    token,
    "tools/call",
    { name, arguments: args },
    version,
  );
  const text = message?.result?.content?.[0]?.text;
  // Relay results are JSON; argument validation errors are plain text.
  let data = text;
  try {
    data = text && JSON.parse(text);
  } catch {}
  return { status, isError: message?.result?.isError === true, data, message };
}
