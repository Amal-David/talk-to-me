import { DurableObject } from "cloudflare:workers";
import { config, RANGES, routeAllowed, TEXT_BODY_BYTES, wakeEndpoint } from "./config";
import type { Env, GroupControl, GroupPolicy, GroupState, Principal, RequestRow } from "./types";
import {
  bodyJson,
  digest,
  errorResponse,
  fail,
  fields,
  identifier,
  integer,
  response,
  textValue,
} from "./validation";

// Exact retries are checked against these absolute bounds; the group's own, possibly lowered,
// limits apply only to new requests and results, so changing a limit never breaks a retry.
const MAX_TEXT_BYTES = RANGES.maxTextBytes[1];
const MAX_TTL_SECONDS = RANGES.maxTtlSeconds[1];
// Fingerprinted as this constant, not the group's current cap, so lowering the cap keeps retries exact.
const DEFAULT_TTL_SECONDS = 3600;

interface ClaimRow extends Record<string, SqlStorageValue> {
  peer: string;
  claim_key: string;
  request_id: string | null;
  lease_token: string | null;
  lease_until: number | null;
}
interface WakeRow extends Record<string, SqlStorageValue> {
  request_id: string;
  state: string;
  attempted_at: number | null;
  status_code: number | null;
}

export class GroupMailbox extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disabled_peers (peer TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, topic TEXT NOT NULL,
        text TEXT, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, ack_at INTEGER,
        result_text TEXT, result_key TEXT, result_fingerprint TEXT, result_lease TEXT,
        terminal_at INTEGER, purge_at INTEGER, parent_id TEXT, hops INTEGER NOT NULL, purged INTEGER NOT NULL DEFAULT 0,
        UNIQUE(sender, request_key)
      );
      CREATE INDEX IF NOT EXISTS request_inbox ON requests(recipient, state, created_at);
      CREATE INDEX IF NOT EXISTS request_outbox ON requests(sender, created_at);
      CREATE TABLE IF NOT EXISTS claims (
        peer TEXT NOT NULL, claim_key TEXT NOT NULL, request_id TEXT, lease_token TEXT, lease_until INTEGER,
        PRIMARY KEY(peer, claim_key)
      );
      CREATE TABLE IF NOT EXISTS wakes (request_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempted_at INTEGER, status_code INTEGER);
      CREATE TABLE IF NOT EXISTS rates (peer TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    // v0.1 (published on main) kept disabled peers in `revoked`. Carry them over once, so an
    // upgraded mailbox never re-enables a peer without the owner's passkey.
    if (
      this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='revoked'").toArray()
        .length
    )
      ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT OR IGNORE INTO disabled_peers(peer) SELECT peer FROM revoked");
        this.sql.exec("DROP TABLE revoked");
      });
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
  private paused(): boolean {
    return this.setting("paused") === "true";
  }
  private active(policy: GroupPolicy, peer: string): boolean {
    return (
      policy.peers.includes(peer) &&
      !this.first("SELECT peer FROM disabled_peers WHERE peer=?", peer)
    );
  }
  private permitted(policy: GroupPolicy, row: RequestRow, reply = false): boolean {
    return (
      this.active(policy, row.sender) &&
      this.active(policy, row.recipient) &&
      routeAllowed(policy, row.sender, row.recipient, row.topic, reply)
    );
  }
  private event(id: string | null, kind: string, now: number): void {
    this.sql.exec("INSERT INTO events(request_id,kind,at) VALUES(?,?,?)", id, kind, now);
  }
  private get(id: string): RequestRow {
    return (
      this.first<RequestRow>("SELECT * FROM requests WHERE id=?", id) ?? fail(404, "not_found")
    );
  }
  private view(row: RequestRow): object {
    const wake = this.first<WakeRow>("SELECT * FROM wakes WHERE request_id=?", row.id);
    return {
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      topic: row.topic,
      text: row.text,
      state: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      acknowledgedAt: row.ack_at,
      parentRequestId: row.parent_id,
      hopCount: row.hops,
      contentTrust: "untrusted",
      purged: !!row.purged,
      result:
        row.result_key === null
          ? null
          : { text: row.result_text, completedAt: row.terminal_at, contentTrust: "untrusted" },
      wake: wake ? { state: wake.state, statusCode: wake.status_code } : { state: "disabled" },
    };
  }
  private readAllowed(policy: GroupPolicy, principal: Principal, row: RequestRow): void {
    if (
      ![row.sender, row.recipient].includes(principal.peer) ||
      !this.permitted(policy, row, row.result_key !== null)
    )
      fail(404, "not_found");
  }
  private liveLease(row: RequestRow, peer: string, lease: string, now: number): void {
    if (
      row.recipient !== peer ||
      row.state !== "leased" ||
      row.lease_token !== lease ||
      (row.lease_until ?? 0) <= now ||
      row.expires_at <= now
    )
      fail(409, "lease_not_current");
  }
  private rate(principal: Principal, policy: GroupPolicy, now: number): void {
    const window = Math.floor(now / 60000);
    const previous = this.first<{ window: number; count: number }>(
      "SELECT window,count FROM rates WHERE peer=?",
      principal.peer,
    );
    const count = previous?.window === window ? previous.count + 1 : 1;
    if (count > policy.limits.ratePerMinute) fail(429, "rate_limit");
    this.sql.exec(
      "INSERT INTO rates(peer,window,count) VALUES(?,?,?) ON CONFLICT(peer) DO UPDATE SET window=excluded.window,count=excluded.count",
      principal.peer,
      window,
      count,
    );
  }
  private sweep(policy: GroupPolicy, now: number): void {
    const retention = policy.limits.retentionSeconds * 1000;
    this.sql.exec(
      "UPDATE requests SET state='expired',terminal_at=?,purge_at=?,lease_token=NULL,lease_until=NULL WHERE state IN ('pending','leased') AND expires_at<=?",
      now,
      now + retention,
      now,
    );
    this.sql.exec(
      "UPDATE requests SET state='dead_letter',terminal_at=?,purge_at=?,lease_token=NULL,lease_until=NULL WHERE state='leased' AND lease_until<=? AND attempts>=max_attempts",
      now,
      now + retention,
      now,
    );
    this.sql.exec(
      "UPDATE requests SET state='pending',lease_token=NULL,lease_until=NULL,ack_at=NULL WHERE state='leased' AND lease_until<=?",
      now,
    );
    this.sql.exec(
      "UPDATE requests SET text=NULL,result_text=NULL,purged=1 WHERE purged=0 AND purge_at IS NOT NULL AND purge_at<=?",
      now,
    );
    this.sql.exec(
      "UPDATE wakes SET state='suppressed' WHERE state='pending' AND request_id IN (SELECT id FROM requests WHERE state!='pending')",
    );
  }
  private async schedule(): Promise<void> {
    // Keep an earlier alarm: frequent status polling must not postpone a queued wake.
    // The short input gate serializes getAlarm + deadline selection + set/delete.
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.getAlarm();
      const next = this.first<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
        SELECT expires_at AS due FROM requests WHERE state IN ('pending','leased')
        UNION ALL SELECT lease_until FROM requests WHERE state='leased'
        UNION ALL SELECT purge_at FROM requests WHERE purged=0 AND purge_at IS NOT NULL
      )`)?.due;
      const wake =
        !this.paused() &&
        this.first<{ due: number | null }>(
          "SELECT MIN(r.created_at+1000) AS due FROM wakes w JOIN requests r ON r.id=w.request_id WHERE w.state='pending'",
        )?.due;
      const due = wake ? Math.min(next ?? Number.MAX_SAFE_INTEGER, wake) : next;
      if (due !== null && due !== undefined) {
        await this.ctx.storage.setAlarm(
          Math.max(Date.now() + 100, Math.min(current ?? Number.MAX_SAFE_INTEGER, due)),
        );
      } else await this.ctx.storage.deleteAlarm();
    });
  }

  // RPC only: the Worker authenticates the caller and passes the principal; there is no
  // fetch handler, so nothing on the internet can reach this object directly.
  async handle(request: Request, principal: Principal): Promise<Response> {
    try {
      const url = new URL(request.url);
      const match = /^\/v1\/groups\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})(\/.*)$/.exec(url.pathname);
      if (!match || url.search || match[1] !== principal.group) fail(404, "not_found");
      this.assertBound(principal.group);
      const name = principal.group;
      const path = match[2] as string;
      const policy = config(this.env).groups[name] ?? fail(401, "unauthorized");
      const body = request.method === "POST" ? await bodyJson(request, TEXT_BODY_BYTES) : {};
      // Hash before the transaction; all authority/state is checked again inside it.
      let fingerprint: string | undefined;
      if (path === "/requests" && request.method === "POST") {
        fields(body, ["to", "topic", "text", "idempotencyKey", "ttlSeconds", "parentRequestId"]);
        const to = identifier(body.to),
          topic = identifier(body.topic),
          text = textValue(body.text, MAX_TEXT_BYTES);
        identifier(body.idempotencyKey);
        const ttl = integer(body.ttlSeconds ?? DEFAULT_TTL_SECONDS, 1, MAX_TTL_SECONDS);
        const parent = body.parentRequestId === undefined ? null : identifier(body.parentRequestId);
        fingerprint = await digest(JSON.stringify([to, topic, text, ttl, parent]));
      } else if (path.endsWith("/result") && request.method === "POST") {
        fields(body, ["leaseToken", "idempotencyKey", "text"]);
        identifier(body.leaseToken);
        identifier(body.idempotencyKey);
        textValue(body.text, MAX_TEXT_BYTES);
        fingerprint = await digest(JSON.stringify([body.idempotencyKey, body.text]));
      }
      const output = this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        if (!this.active(policy, principal.peer)) fail(403, "peer_disabled");
        const storedName = this.setting("group");
        if (storedName && storedName !== name) fail(404, "not_found");
        this.sql.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('group',?)", name);
        this.sweep(policy, now);
        const isCancel = /^\/requests\/[^/]+\/cancel$/.test(path);
        if (this.paused() && !isCancel) fail(503, "group_paused");
        this.rate(principal, policy, now);
        if (request.method === "POST" && path === "/requests")
          return this.enqueue(body, principal, policy, fingerprint as string, now);
        if (request.method === "POST" && path === "/claim")
          return this.claim(body, principal, policy, now);
        if (request.method === "GET" && (path === "/inbox" || path === "/outbox")) {
          const column = path === "/inbox" ? "recipient" : "sender";
          const rows = this.sql
            .exec<RequestRow>(
              `SELECT * FROM requests WHERE ${column}=? ORDER BY created_at DESC,id DESC LIMIT 100`,
              principal.peer,
            )
            .toArray();
          return {
            requests: rows
              .filter((r) => this.permitted(policy, r, r.result_key !== null))
              .map((r) => this.view(r)),
            limit: 100,
          };
        }
        const item =
          /^\/requests\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})(?:\/(ack|result|cancel))?$/.exec(path);
        if (!item) fail(404, "not_found");
        const row = this.get(item[1] as string);
        this.readAllowed(policy, principal, row);
        if (request.method === "GET" && !item[2]) return this.view(row);
        if (request.method !== "POST") fail(405, "method_not_allowed");
        if (item[2] === "cancel") {
          fields(body, []);
          if (principal.peer !== row.sender) fail(403, "forbidden");
          if (row.state === "cancelled") return this.view(row);
          if (!["pending", "leased"].includes(row.state)) fail(409, "already_terminal");
          this.sql.exec(
            "UPDATE requests SET state='cancelled',terminal_at=?,purge_at=?,lease_token=NULL,lease_until=NULL WHERE id=?",
            now,
            now + policy.limits.retentionSeconds * 1000,
            row.id,
          );
          this.sql.exec(
            "UPDATE wakes SET state='suppressed' WHERE request_id=? AND state='pending'",
            row.id,
          );
          this.event(row.id, "cancelled", now);
          return this.view(this.get(row.id));
        }
        const lease = identifier(body.leaseToken);
        if (item[2] === "ack") {
          fields(body, ["leaseToken"]);
          this.liveLease(row, principal.peer, lease, now);
          if (row.ack_at === null) {
            this.sql.exec("UPDATE requests SET ack_at=? WHERE id=?", now, row.id);
            this.event(row.id, "acknowledged", now);
          }
          return this.view(this.get(row.id));
        }
        if (item[2] === "result") {
          if (!this.permitted(policy, row, true)) fail(403, "reply_forbidden");
          if (principal.peer !== row.recipient) fail(403, "forbidden");
          if (row.state === "completed") {
            if (row.result_lease !== lease || row.result_fingerprint !== fingerprint)
              fail(409, "result_conflict");
            return this.view(row);
          }
          textValue(body.text, policy.limits.maxTextBytes);
          this.liveLease(row, principal.peer, lease, now);
          this.sql.exec(
            "UPDATE requests SET state='completed',result_text=?,result_key=?,result_fingerprint=?,result_lease=?,terminal_at=?,purge_at=?,ack_at=COALESCE(ack_at,?),lease_token=NULL,lease_until=NULL WHERE id=?",
            body.text as string,
            body.idempotencyKey as string,
            fingerprint as string,
            lease,
            now,
            now + policy.limits.retentionSeconds * 1000,
            now,
            row.id,
          );
          this.event(row.id, "completed", now);
          return this.view(this.get(row.id));
        }
        return fail(404, "not_found");
      });
      await this.schedule();
      return response(output);
    } catch (error) {
      return errorResponse(error);
    }
  }
  // Called only by the Owner object after it has checked the owner's session.
  async control(group: string, change: GroupControl): Promise<GroupState> {
    this.assertBound(group);
    this.ctx.storage.transactionSync(() => {
      if (change.paused !== undefined)
        this.sql.exec(
          "INSERT INTO settings(key,value) VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          String(change.paused),
        );
      if (change.disablePeer !== undefined) {
        this.sql.exec("INSERT OR IGNORE INTO disabled_peers(peer) VALUES(?)", change.disablePeer);
        // Suppressed wakes stay suppressed; re-enabling the peer does not re-send them.
        this.sql.exec(
          "UPDATE wakes SET state='suppressed' WHERE state='pending' AND request_id IN (SELECT id FROM requests WHERE sender=? OR recipient=?)",
          change.disablePeer,
          change.disablePeer,
        );
      }
      if (change.enablePeer !== undefined)
        this.sql.exec("DELETE FROM disabled_peers WHERE peer=?", change.enablePeer);
      this.event(null, "control_changed", Date.now());
      // Control events are capped independently so repeated toggling cannot fill storage.
      this.sql.exec(
        "DELETE FROM events WHERE request_id IS NULL AND seq NOT IN (SELECT seq FROM events WHERE request_id IS NULL ORDER BY seq DESC LIMIT 1000)",
      );
    });
    // Resuming must bring held-back wakes due again without waiting for other traffic.
    await this.schedule();
    return this.status(group);
  }
  // Read-only, for the owner page; it never writes or creates group state.
  status(group: string): GroupState {
    this.assertBound(group);
    return {
      paused: this.paused(),
      disabled: this.sql
        .exec<{ peer: string }>("SELECT peer FROM disabled_peers ORDER BY peer")
        .toArray()
        .map((r) => r.peer),
    };
  }
  // This object serves exactly one group: the one its ID was derived from.
  private assertBound(group: string): void {
    if (this.ctx.id.toString() !== this.env.GROUPS.idFromName(group).toString())
      fail(404, "not_found");
  }
  private enqueue(
    body: Record<string, unknown>,
    principal: Principal,
    policy: GroupPolicy,
    fingerprint: string,
    now: number,
  ): object {
    const to = body.to as string,
      topic = body.topic as string,
      key = body.idempotencyKey as string;
    if (!this.active(policy, to) || !routeAllowed(policy, principal.peer, to, topic))
      fail(403, "route_forbidden");
    const old = this.first<RequestRow>(
      "SELECT * FROM requests WHERE sender=? AND request_key=?",
      principal.peer,
      key,
    );
    if (old) {
      if (old.fingerprint !== fingerprint) fail(409, "idempotency_conflict");
      this.readAllowed(policy, principal, old);
      return this.view(old);
    }
    const ttl =
      (body.ttlSeconds as number | undefined) ??
      Math.min(DEFAULT_TTL_SECONDS, policy.limits.maxTtlSeconds);
    textValue(body.text, policy.limits.maxTextBytes);
    integer(ttl, 1, policy.limits.maxTtlSeconds);
    const all = this.first<{ n: number }>("SELECT COUNT(*) AS n FROM requests")?.n ?? 0;
    const pending =
      this.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM requests WHERE state IN ('pending','leased')",
      )?.n ?? 0;
    if (all >= policy.limits.maxRequests || pending >= policy.limits.maxPending)
      fail(429, "capacity_limit");
    let hops = 0;
    let parent: RequestRow | undefined;
    if (body.parentRequestId !== undefined) {
      parent = this.get(body.parentRequestId as string);
      this.readAllowed(policy, principal, parent);
      if (
        parent.recipient !== principal.peer ||
        !["pending", "leased", "completed"].includes(parent.state) ||
        parent.expires_at <= now
      )
        fail(403, "invalid_parent");
      hops = parent.hops + 1;
    }
    if (hops > policy.limits.maxHops) fail(403, "hop_limit");
    const expires = Math.min(now + ttl * 1000, parent?.expires_at ?? Number.MAX_SAFE_INTEGER);
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO requests(id,sender,recipient,topic,text,request_key,fingerprint,state,created_at,expires_at,max_attempts,parent_id,hops) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?)",
      id,
      principal.peer,
      to,
      topic,
      body.text as string,
      key,
      fingerprint,
      now,
      expires,
      policy.limits.maxAttempts,
      parent?.id ?? null,
      hops,
    );
    if (policy.wake[to])
      this.sql.exec("INSERT INTO wakes(request_id,state) VALUES(?,'pending')", id);
    this.event(id, "accepted", now);
    return this.view(this.get(id));
  }
  private claim(
    body: Record<string, unknown>,
    principal: Principal,
    policy: GroupPolicy,
    now: number,
  ): object | null {
    fields(body, ["claimKey"]);
    const key = identifier(body.claimKey);
    const old = this.first<ClaimRow>(
      "SELECT * FROM claims WHERE peer=? AND claim_key=?",
      principal.peer,
      key,
    );
    if (old) {
      if (!old.request_id) return null;
      const row = this.get(old.request_id);
      if (!this.permitted(policy, row)) fail(403, "route_forbidden");
      this.liveLease(row, principal.peer, old.lease_token as string, now);
      return {
        request: this.view(row),
        leaseToken: old.lease_token,
        leaseExpiresAt: old.lease_until,
      };
    }
    if (
      (this.first<{ n: number }>("SELECT COUNT(*) AS n FROM claims")?.n ?? 0) >=
      policy.limits.maxClaims
    )
      fail(429, "claim_capacity_limit");
    const candidates = this.sql
      .exec<RequestRow>(
        "SELECT * FROM requests WHERE recipient=? AND state='pending' ORDER BY created_at,id",
        principal.peer,
      )
      .toArray();
    const row = candidates.find((r) => this.permitted(policy, r));
    if (!row) {
      this.sql.exec("INSERT INTO claims(peer,claim_key) VALUES(?,?)", principal.peer, key);
      return null;
    }
    const lease = crypto.randomUUID(),
      until = Math.min(now + policy.limits.leaseSeconds * 1000, row.expires_at);
    this.sql.exec(
      "UPDATE requests SET state='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
      lease,
      until,
      row.id,
    );
    this.sql.exec(
      "INSERT INTO claims(peer,claim_key,request_id,lease_token,lease_until) VALUES(?,?,?,?,?)",
      principal.peer,
      key,
      row.id,
      lease,
      until,
    );
    this.sql.exec(
      "UPDATE wakes SET state='suppressed' WHERE request_id=? AND state='pending'",
      row.id,
    );
    this.event(row.id, "claimed", now);
    return { request: this.view(this.get(row.id)), leaseToken: lease, leaseExpiresAt: until };
  }
  async alarm(): Promise<void> {
    const name = this.setting("group");
    if (!name) return;
    let policy: GroupPolicy;
    try {
      policy = config(this.env).groups[name] ?? fail(503, "configuration_unavailable");
    } catch {
      return;
    } // Fail closed; a valid subsequent API request restarts maintenance.
    this.ctx.storage.transactionSync(() => this.sweep(policy, Date.now()));
    if (!this.paused()) await this.dispatchWake(name, policy);
    await this.schedule();
  }
  private async dispatchWake(name: string, policy: GroupPolicy): Promise<void> {
    const job = this.ctx.storage.transactionSync(() => {
      // An interrupted attempt has an uncertain external outcome and must not be replayed.
      this.sql.exec("UPDATE wakes SET state='hold' WHERE state='in_flight'");
      const pending = this.first<WakeRow>(
        "SELECT * FROM wakes WHERE state='pending' ORDER BY request_id LIMIT 1",
      );
      if (!pending) return undefined;
      const row = this.get(pending.request_id);
      if (
        row.state !== "pending" ||
        row.expires_at <= Date.now() ||
        !this.permitted(policy, row) ||
        !policy.wake[row.recipient]
      ) {
        this.sql.exec("UPDATE wakes SET state='suppressed' WHERE request_id=?", row.id);
        return undefined;
      }
      this.sql.exec(
        "UPDATE wakes SET state='in_flight',attempted_at=? WHERE request_id=?",
        Date.now(),
        row.id,
      );
      this.event(row.id, "wake_attempted", Date.now());
      return row;
    });
    if (!job) return;
    await this.ctx.storage.sync(); // Persist intent BEFORE any external effect.
    // Sync can yield: recheck all mutable gates, then initiate fetch without another yield.
    const current = this.get(job.id);
    if (this.paused()) {
      this.sql.exec(
        "UPDATE wakes SET state='pending',attempted_at=NULL WHERE request_id=? AND state='in_flight'",
        job.id,
      );
      return;
    }
    if (
      current.state !== "pending" ||
      current.expires_at <= Date.now() ||
      !this.permitted(policy, current)
    ) {
      this.sql.exec(
        "UPDATE wakes SET state='suppressed' WHERE request_id=? AND state='in_flight'",
        job.id,
      );
      return;
    }
    const endpoint = wakeEndpoint(
      this.env,
      policy.wake[job.recipient]?.endpointId as string,
      name,
      job.recipient,
    );
    let state = "hold",
      status: number | null = null;
    try {
      const result = await fetch(endpoint.url, {
        method: "POST",
        redirect: "manual",
        headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: job.id, relay: this.env.RELAY_PUBLIC_URL }),
        signal: AbortSignal.timeout(10000),
      });
      status = result.status;
      if (status === 200) state = "started";
      await result.body?.cancel();
    } catch {
      /* Timeout/network/crash ambiguity is held for operator reconciliation, never blind retry. */
    }
    this.sql.exec(
      "UPDATE wakes SET state=?,status_code=? WHERE request_id=? AND state='in_flight'",
      state,
      status,
      job.id,
    );
  }
}
