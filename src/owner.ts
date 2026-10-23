import { DurableObject } from "cloudflare:workers";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { relayOrigin } from "./config";
import { homePage, setupPage, signInPage } from "./owner-pages";
import type { CredentialRow, Env } from "./types";
import { bodyJson, digest, errorResponse, fail, fields, object, response } from "./validation";

const SESSION_COOKIE = "__Host-ttm_owner";
const SESSION_SECONDS = 900;
const CHALLENGE_MS = 300_000;
// Anyone can request a sign-in challenge, so a full table evicts the oldest instead of refusing.
const MAX_CHALLENGES = 1000;
const SETUP_FAILURES = 5;
const SETUP_WINDOW_MS = 900_000;
// Each challenge is issued for one purpose and only verifies that purpose.
const PURPOSE = {
  setup: "setup",
  signIn: "sign-in",
  addPasskeyStepUp: "step-up:add-passkey",
  addPasskey: "add-passkey",
} as const;
type Purpose = (typeof PURPOSE)[keyof typeof PURPOSE];

function randomToken(): string {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
}
function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export class Owner extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS challenges (challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `);
  }
  private first<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...args: SqlStorageValue[]
  ): T | undefined {
    return this.sql.exec<T>(query, ...args).toArray()[0];
  }
  private setting(key: string): string | undefined {
    return this.first<{ value: string }>("SELECT value FROM settings WHERE key=?", key)?.value;
  }
  private put(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  private credentials(): CredentialRow[] {
    return this.sql.exec<CredentialRow>("SELECT * FROM credentials ORDER BY created_at").toArray();
  }
  private ensureUserId(): Uint8Array<ArrayBuffer> {
    let id = this.setting("user_id");
    if (!id) {
      id = randomToken();
      this.put("user_id", id);
    }
    return isoBase64URL.toBuffer(id) as Uint8Array<ArrayBuffer>;
  }

  private issueChallenge(challenge: string, purpose: Purpose): void {
    const now = Date.now();
    this.sql.exec("DELETE FROM challenges WHERE expires_at<=?", now);
    this.sql.exec(
      "DELETE FROM challenges WHERE challenge IN (SELECT challenge FROM challenges ORDER BY expires_at DESC LIMIT -1 OFFSET ?)",
      MAX_CHALLENGES - 1,
    );
    this.sql.exec(
      "INSERT INTO challenges(challenge,purpose,expires_at) VALUES(?,?,?)",
      challenge,
      purpose,
      now + CHALLENGE_MS,
    );
  }
  // Deleting before verification makes every challenge single-use, even if verification then fails.
  private consumeChallenge(challenge: string, purpose: Purpose): boolean {
    return (
      this.sql
        .exec(
          "DELETE FROM challenges WHERE challenge=? AND purpose=? AND expires_at>? RETURNING challenge",
          challenge,
          purpose,
          Date.now(),
        )
        .toArray().length === 1
    );
  }

  private async registrationOptions(origin: URL, purpose: Purpose): Promise<object> {
    const options = await generateRegistrationOptions({
      rpName: "talk-to-me",
      rpID: origin.hostname,
      userName: "owner",
      userID: this.ensureUserId(),
      attestationType: "none",
      excludeCredentials: this.credentials().map((c) => ({ id: c.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    this.issueChallenge(options.challenge, purpose);
    return options;
  }
  private async register(origin: URL, purpose: Purpose, input: unknown): Promise<void> {
    // The library validates the response's shape; any failure means "not verified".
    const result = await verifyRegistrationResponse({
      response: object(input) as unknown as RegistrationResponseJSON,
      expectedChallenge: (challenge) => this.consumeChallenge(challenge, purpose),
      expectedOrigin: origin.origin,
      expectedRPID: origin.hostname,
      requireUserVerification: true,
    }).catch(() => undefined);
    const info = result?.verified ? result.registrationInfo : undefined;
    if (!info) return fail(400, "passkey_not_verified");
    this.sql.exec(
      "INSERT INTO credentials(id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?)",
      info.credential.id,
      isoBase64URL.fromBuffer(info.credential.publicKey),
      info.credential.counter,
      JSON.stringify(info.credential.transports ?? []),
      Date.now(),
    );
  }

  private async authenticationOptions(origin: URL, purpose: Purpose): Promise<object> {
    if (!this.first("SELECT 1 AS found FROM credentials LIMIT 1")) fail(409, "no_passkey");
    const options = await generateAuthenticationOptions({
      rpID: origin.hostname,
      userVerification: "required",
    });
    this.issueChallenge(options.challenge, purpose);
    return options;
  }
  private async authenticate(origin: URL, purpose: Purpose, input: unknown): Promise<void> {
    const assertion = object(input);
    const stored = this.first<CredentialRow>(
      "SELECT * FROM credentials WHERE id=?",
      String(assertion.id),
    );
    if (!stored) return fail(401, "passkey_not_verified");
    const credential = {
      id: stored.id,
      publicKey: isoBase64URL.toBuffer(stored.public_key) as Uint8Array<ArrayBuffer>,
      counter: stored.counter,
      transports: JSON.parse(stored.transports) as AuthenticatorTransport[],
    };
    // The library validates the response's shape; any failure means "not verified".
    const result = await verifyAuthenticationResponse({
      response: assertion as unknown as AuthenticationResponseJSON,
      expectedChallenge: (challenge) => this.consumeChallenge(challenge, purpose),
      expectedOrigin: origin.origin,
      expectedRPID: origin.hostname,
      requireUserVerification: true,
      credential,
    }).catch(() => undefined);
    if (!result?.verified) return fail(401, "passkey_not_verified");
    this.sql.exec(
      "UPDATE credentials SET counter=?,last_used_at=? WHERE id=?",
      result.authenticationInfo.newCounter,
      Date.now(),
      stored.id,
    );
  }

  private setupCode(): string {
    const code = this.env.OWNER_SETUP_CODE;
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(code))
      fail(503, "setup_unavailable");
    return code as string;
  }
  // A code value works once; setting a different OWNER_SETUP_CODE allows recovery.
  private async checkSetupCode(input: unknown): Promise<string> {
    const hash = await digest(this.setupCode());
    if (this.setting("used_setup_code") === hash) fail(409, "setup_code_used");
    const now = Date.now();
    const failures = JSON.parse(this.setting("setup_failures") ?? '{"since":0,"count":0}') as {
      since: number;
      count: number;
    };
    const current = now - failures.since < SETUP_WINDOW_MS ? failures : { since: now, count: 0 };
    if (current.count >= SETUP_FAILURES) fail(429, "too_many_attempts");
    const encoder = new TextEncoder();
    // Both sides are SHA-256 hex digests, so the lengths always match.
    if (
      typeof input !== "string" ||
      !crypto.subtle.timingSafeEqual(encoder.encode(await digest(input)), encoder.encode(hash))
    ) {
      this.put("setup_failures", JSON.stringify({ ...current, count: current.count + 1 }));
      fail(403, "invalid_setup_code");
    }
    return hash;
  }

  private async session(request: Request): Promise<string | undefined> {
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) return undefined;
    const hash = await digest(cookie.slice(SESSION_COOKIE.length + 1));
    return this.first("SELECT hash FROM sessions WHERE hash=? AND expires_at>?", hash, Date.now())
      ? hash
      : undefined;
  }
  private async startSession(): Promise<Response> {
    const token = randomToken();
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at<=?", now);
    this.sql.exec(
      "INSERT INTO sessions(hash,expires_at) VALUES(?,?)",
      await digest(token),
      now + SESSION_SECONDS * 1000,
    );
    const res = response({ ok: true });
    res.headers.set("Set-Cookie", sessionCookie(token, SESSION_SECONDS));
    return res;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      let origin: URL;
      try {
        origin = relayOrigin(this.env);
      } catch {
        return fail(503, "configuration_unavailable");
      }
      const { pathname } = new URL(request.url);
      if (request.method === "GET") {
        if (pathname === "/owner/setup") return setupPage();
        if (pathname === "/owner/sign-in") return signInPage();
        if (pathname === "/owner") {
          if (!(await this.session(request)))
            return new Response(null, { status: 303, headers: { Location: "/owner/sign-in" } });
          return homePage(this.credentials());
        }
        return fail(404, "not_found");
      }
      if (request.method !== "POST") fail(405, "method_not_allowed");
      // Cross-site protection for every state change, alongside the SameSite=Strict cookie.
      if (request.headers.get("origin") !== origin.origin) fail(403, "origin_mismatch");
      const body = await bodyJson(request);

      if (pathname === "/owner/setup/options") {
        fields(body, ["code"]);
        await this.checkSetupCode(body.code);
        return response(await this.registrationOptions(origin, PURPOSE.setup));
      }
      if (pathname === "/owner/setup/verify") {
        fields(body, ["code", "response"]);
        const hash = await this.checkSetupCode(body.code);
        await this.register(origin, PURPOSE.setup, body.response);
        this.put("used_setup_code", hash);
        return this.startSession();
      }
      if (pathname === "/owner/sign-in/options") {
        fields(body, []);
        return response(await this.authenticationOptions(origin, PURPOSE.signIn));
      }
      if (pathname === "/owner/sign-in/verify") {
        fields(body, ["response"]);
        await this.authenticate(origin, PURPOSE.signIn, body.response);
        return this.startSession();
      }

      const session = await this.session(request);
      if (!session) fail(401, "sign_in_required");
      if (pathname === "/owner/sign-out") {
        fields(body, []);
        this.sql.exec("DELETE FROM sessions WHERE hash=?", session as string);
        const res = response({ ok: true });
        res.headers.set("Set-Cookie", sessionCookie("", 0));
        return res;
      }
      // Adding a passkey grants access, so it needs a fresh passkey assertion, not just a session.
      if (pathname === "/owner/passkeys/step-up") {
        fields(body, []);
        return response(await this.authenticationOptions(origin, PURPOSE.addPasskeyStepUp));
      }
      if (pathname === "/owner/passkeys/options") {
        fields(body, ["assertion"]);
        await this.authenticate(origin, PURPOSE.addPasskeyStepUp, body.assertion);
        return response(await this.registrationOptions(origin, PURPOSE.addPasskey));
      }
      if (pathname === "/owner/passkeys/verify") {
        fields(body, ["response"]);
        await this.register(origin, PURPOSE.addPasskey, body.response);
        return response({ ok: true });
      }
      return fail(404, "not_found");
    } catch (error) {
      return errorResponse(error);
    }
  }
}
