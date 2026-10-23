import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fixture } from "./helpers.mjs";

export const OWNER_ORIGIN = "https://relay.company.dev";
export const SETUP_CODE = "synthetic-owner-setup-code-not-for-production-0001";
export async function ownerFixture(options = {}) {
  const f = await fixture({
    ...options,
    bindings: { RELAY_PUBLIC_URL: OWNER_ORIGIN, OWNER_SETUP_CODE: SETUP_CODE, ...options.bindings },
  });
  // GET when body is undefined, otherwise a JSON POST carrying the relay's Origin header.
  const owner = async (path, body, { cookie, origin = OWNER_ORIGIN } = {}) => {
    const headers = {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(body !== undefined && origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const res = await f.mf.dispatchFetch(`${OWNER_ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      body: parsed,
      cookie: res.headers.get("set-cookie")?.split(";")[0],
      location: res.headers.get("location"),
    };
  };
  return { ...f, owner };
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
