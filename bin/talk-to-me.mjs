#!/usr/bin/env node
/** Portable text-only relay client. No dependencies, plugins, or shell execution. */
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";

const INPUT_LIMIT = 128 * 1024;
// The relay's TEXT_BODY_BYTES: its largest text at six times its size once JSON-escaped, plus 4 KiB.
const BODY_LIMIT = 100 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const COMMANDS = new Set(["send", "inbox", "outbox", "claim", "ack", "result", "status", "cancel"]);
const HELP = `talk-to-me: private text request/reply relay (Node.js 22.13+)

Environment (required; credentials never belong in arguments):
  TALK_TO_ME_URL       Relay origin, HTTPS; HTTP only for localhost/loopback
  TALK_TO_ME_GROUP     Configured private group
  TALK_TO_ME_TOKEN     This peer's ttm_ connection token from the relay's owner page

Commands:
  send --to PEER --topic TOPIC --text TEXT --idempotency-key KEY
       [--ttl-seconds N] [--parent-request-id ID]
  inbox
  outbox
  claim --claim-key KEY
  ack ID --lease-token LEASE
  result ID --lease-token LEASE --text TEXT --idempotency-key KEY
  status ID
  cancel ID

For send, claim, ack, result, or cancel, use --json FILE or --json -
instead of body flags to read one JSON object from a file or stdin.
Use JSON input for private text and lease tokens to avoid shell history.
Request IDs remain positional. Never pass a bearer token on the command line.
Use stable caller-generated idempotency/claim keys when retrying.
Outputs JSON. No automatic retries, daemon, polling loop, or message execution.
`;

export class ClientError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "ClientError";
    this.exitCode = exitCode;
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientError(`${label} must be a nonempty string.`);
  }
  return value;
}

function segment(value, label) {
  assertString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new ClientError(
      `${label} must start with a letter or number, followed by letters, numbers, underscores, periods, colons, or hyphens (1–128 characters).`,
    );
  }
  return value;
}

export function configuration(env = process.env) {
  let url;
  try {
    url = new URL(assertString(env.TALK_TO_ME_URL, "TALK_TO_ME_URL"));
  } catch {
    throw new ClientError("TALK_TO_ME_URL must be a valid relay origin.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ClientError(
      "Use HTTPS for a remote relay; HTTP is allowed only for localhost or loopback.",
    );
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ClientError(
      "TALK_TO_ME_URL must be an origin without credentials, path, query, or fragment.",
    );
  }
  const group = segment(env.TALK_TO_ME_GROUP, "TALK_TO_ME_GROUP");
  const token = assertString(env.TALK_TO_ME_TOKEN, "TALK_TO_ME_TOKEN");
  // Only connection tokens minted on the relay's owner page (CONNECTION_TOKEN in src/owner.ts);
  // anything else never leaves the machine.
  if (!/^ttm_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new ClientError(
      "TALK_TO_ME_TOKEN must be a ttm_ connection token from the relay's owner page.",
    );
  }
  return { origin: url.origin, group, token };
}

export function parseArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]))) {
    return { help: true };
  }
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) throw new ClientError("Unknown command. Run talk-to-me --help.");
  const flags = Object.create(null);
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      // Reject unknown flags without echoing them: they could contain credentials.
      if (
        ![
          "--to",
          "--topic",
          "--text",
          "--idempotency-key",
          "--ttl-seconds",
          "--parent-request-id",
          "--claim-key",
          "--lease-token",
          "--json",
        ].includes(arg)
      ) {
        throw new ClientError(
          "Unknown option. Bearer tokens are accepted only through TALK_TO_ME_TOKEN.",
        );
      }
      if (Object.hasOwn(flags, arg)) throw new ClientError("Duplicate option.");
      if (i + 1 >= rest.length || rest[i + 1].startsWith("--"))
        throw new ClientError(
          "An option is missing its value. Use JSON input for text beginning with --.",
        );
      flags[arg] = rest[++i];
    } else {
      positionals.push(arg);
    }
  }
  const takesId = ["ack", "result", "status", "cancel"].includes(command);
  if (positionals.length !== (takesId ? 1 : 0))
    throw new ClientError(
      takesId
        ? "This command requires exactly one request ID."
        : "This command does not accept positional arguments.",
    );
  const id = takesId ? segment(positionals[0], "Request ID") : undefined;
  const allowed = {
    send: [
      "--to",
      "--topic",
      "--text",
      "--idempotency-key",
      "--ttl-seconds",
      "--parent-request-id",
      "--json",
    ],
    inbox: [],
    outbox: [],
    status: [],
    claim: ["--claim-key", "--json"],
    ack: ["--lease-token", "--json"],
    result: ["--lease-token", "--idempotency-key", "--text", "--json"],
    cancel: ["--json"],
  }[command];
  if (Object.keys(flags).some((key) => !allowed.includes(key)))
    throw new ClientError("This command does not accept one of the supplied options.");
  if (flags["--json"] && Object.keys(flags).length !== 1)
    throw new ClientError("Do not mix --json with body options.");
  return { command, id, flags };
}

async function readLimited(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new ClientError("Input or response exceeds the client size limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function validateBody(command, body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ClientError("JSON input must be one object.");
  const fields = {
    send: {
      required: ["to", "topic", "text", "idempotencyKey"],
      optional: ["ttlSeconds", "parentRequestId"],
    },
    claim: { required: ["claimKey"], optional: [] },
    ack: { required: ["leaseToken"], optional: [] },
    result: { required: ["leaseToken", "idempotencyKey", "text"], optional: [] },
    cancel: { required: [], optional: [] },
  }[command];
  if (!fields) return undefined;
  const allowed = [...fields.required, ...fields.optional];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new ClientError(
      "JSON input contains an unsupported field. Identity comes from the bearer credential, not the body.",
    );
  for (const key of fields.required) assertString(body[key], key);
  if (body.to !== undefined) segment(body.to, "to");
  if (body.parentRequestId !== undefined) segment(body.parentRequestId, "parentRequestId");
  if (
    body.ttlSeconds !== undefined &&
    (!Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds <= 0)
  ) {
    throw new ClientError("ttlSeconds must be a positive integer.");
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > BODY_LIMIT)
    throw new ClientError("Serialized request body exceeds 100 KiB.");
  return body;
}

export async function requestFor(parsed, stdin = process.stdin) {
  const { command, id, flags } = parsed;
  const routes = {
    send: ["POST", "/requests"],
    inbox: ["GET", "/inbox"],
    outbox: ["GET", "/outbox"],
    claim: ["POST", "/claim"],
    ack: ["POST", `/requests/${id}/ack`],
    result: ["POST", `/requests/${id}/result`],
    status: ["GET", `/requests/${id}`],
    cancel: ["POST", `/requests/${id}/cancel`],
  };
  const [method, path] = routes[command];
  if (method === "GET") return { method, path };
  let body = {};
  if (flags["--json"]) {
    let raw;
    try {
      raw = await readLimited(
        flags["--json"] === "-" ? stdin : createReadStream(flags["--json"]),
        INPUT_LIMIT,
      );
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError("Could not read the JSON input file or stdin.");
    }
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ClientError("Input is not valid JSON.");
    }
  } else {
    const mapping = {
      "--to": "to",
      "--topic": "topic",
      "--text": "text",
      "--idempotency-key": "idempotencyKey",
      "--ttl-seconds": "ttlSeconds",
      "--parent-request-id": "parentRequestId",
      "--claim-key": "claimKey",
      "--lease-token": "leaseToken",
    };
    for (const [option, value] of Object.entries(flags))
      body[mapping[option]] = option === "--ttl-seconds" ? Number(value) : value;
  }
  return { method, path, body: validateBody(command, body) };
}

export function redactedJson(value, token) {
  const redact = (item) => {
    if (typeof item === "string") return token ? item.split(token).join("[REDACTED]") : item;
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [redact(key), redact(entry)]),
      );
    return item;
  };
  // Redact before serializing so punctuation in a secret cannot damage JSON syntax.
  return `${JSON.stringify(redact(value), null, 2)}\n`;
}

export async function run(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      stdout.write(HELP);
      return 0;
    }
    const config = configuration(env);
    const request = await requestFor(parsed, stdin);
    let response;
    try {
      response = await fetchImpl(`${config.origin}/v1/groups/${config.group}${request.path}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ClientError(
        "Relay request failed or timed out. The outcome may be unknown; inspect status before retrying, and reuse the same idempotency or claim key.",
        1,
      );
    }
    let payload;
    try {
      const raw = response.body ? await readLimited(response.body, OUTPUT_LIMIT) : "";
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new ClientError(
        `Relay returned an unreadable or oversized response (HTTP ${response.status}). The action may already have completed; inspect status before retrying.`,
        1,
      );
    }
    if (!response.ok) {
      stderr.write(
        redactedJson({ ok: false, status: response.status, error: payload }, config.token),
      );
      return 1;
    }
    stdout.write(redactedJson(payload, config.token));
    return 0;
  } catch (error) {
    const known = error instanceof ClientError;
    stderr.write(
      redactedJson(
        { ok: false, error: known ? error.message : "Unexpected client failure." },
        env.TALK_TO_ME_TOKEN,
      ),
    );
    return known ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run();
}
