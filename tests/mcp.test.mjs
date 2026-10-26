import assert from "node:assert/strict";
import test from "node:test";
import { tokens } from "./helpers.mjs";
import { LEGACY, MODERN, mcpCall, oauthFixture, tool } from "./owner-helpers.mjs";

const TOOLS = [
  "who_am_i",
  "send_message",
  "check_inbox",
  "claim_next",
  "reply",
  "get_status",
  "cancel",
  "list_sent",
];

test("both protocol eras list the same tools, with writes marked as writes", async () => {
  const f = await oauthFixture();
  try {
    // Grok speaks the 2025 protocol with an initialize handshake; ChatGPT speaks 2026-07-28.
    const init = await mcpCall(f, tokens.alpha, "initialize", {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: "synthetic-client", version: "0" },
    });
    assert.equal(init.message.result.protocolVersion, LEGACY);
    const discover = await mcpCall(f, tokens.alpha, "server/discover", {}, MODERN);
    assert.ok(discover.message.result.supportedVersions.includes(MODERN));
    for (const version of [LEGACY, MODERN]) {
      const listed = (await mcpCall(f, tokens.alpha, "tools/list", {}, version)).message.result
        .tools;
      assert.deepEqual(listed.map((t) => t.name).sort(), [...TOOLS].sort(), version);
      const hints = Object.fromEntries(listed.map((t) => [t.name, t.annotations]));
      // Hosts such as ChatGPT can require approval for tools that are not read-only.
      for (const name of ["who_am_i", "check_inbox", "get_status", "list_sent"])
        assert.equal(hints[name].readOnlyHint, true, name);
      for (const name of ["send_message", "claim_next", "reply", "cancel"])
        assert.equal(hints[name].readOnlyHint, false, name);
      assert.equal(hints.cancel.destructiveHint, true);
      // Without its key, repeating a send acts again; repeating a cancel does not.
      assert.equal(hints.send_message.idempotentHint, false);
      assert.equal(hints.cancel.idempotentHint, true);
    }
  } finally {
    await f.close();
  }
});

test("two agents complete a request and reply through MCP, and a retry does not resend", async () => {
  const f = await oauthFixture();
  try {
    const me = await tool(f, tokens.alpha, "who_am_i", {}, MODERN);
    assert.deepEqual(me.data, {
      group: "demo",
      peer: "alpha",
      canSend: [{ to: "beta", topics: ["general"], replyAllowed: true }],
    });
    const message = { to: "beta", topic: "general", text: "Synthetic question?" };
    const sent = await tool(f, tokens.alpha, "send_message", message, MODERN);
    assert.equal(sent.isError, false);
    const id = sent.data.result.id;
    const retry = await tool(f, tokens.alpha, "send_message", {
      ...message,
      idempotencyKey: sent.data.idempotencyKey,
    });
    assert.equal(retry.data.result.id, id);
    const inbox = await tool(f, tokens.beta, "check_inbox");
    assert.deepEqual(
      inbox.data.result.requests.map((r) => [r.id, r.sender, r.contentTrust]),
      [[id, "alpha", "untrusted"]],
    );
    const claimed = await tool(f, tokens.beta, "claim_next");
    assert.equal(claimed.data.result.request.id, id);
    const replied = await tool(f, tokens.beta, "reply", {
      requestId: id,
      leaseToken: claimed.data.result.leaseToken,
      text: "Synthetic answer.",
    });
    assert.equal(replied.data.result.state, "completed");
    const status = await tool(f, tokens.alpha, "get_status", { requestId: id });
    assert.equal(status.data.result.result.text, "Synthetic answer.");
    const sentList = await tool(f, tokens.alpha, "list_sent");
    assert.deepEqual(
      sentList.data.result.requests.map((r) => r.id),
      [id],
    );
    assert.equal((await tool(f, tokens.beta, "claim_next")).data.result, null);
  } finally {
    await f.close();
  }
});

test("tool calls act only as their own peer and report refusals as tool errors", async () => {
  const f = await oauthFixture();
  try {
    // beta has no route to gamma, and alpha cannot pose as beta through extra arguments.
    const forbidden = await tool(f, tokens.beta, "send_message", {
      to: "gamma",
      topic: "general",
      text: "Synthetic",
    });
    assert.deepEqual([forbidden.isError, forbidden.data.result.error], [true, "route_forbidden"]);
    const spoofed = await tool(f, tokens.alpha, "send_message", {
      to: "beta",
      topic: "general",
      text: "Synthetic",
      from: "beta",
      sender: "beta",
    });
    assert.equal(spoofed.data.result.sender, "alpha");
    const id = spoofed.data.result.id;
    // Only the recipient's lease can answer, and a crafted ID cannot reach another route.
    const lease = (await tool(f, tokens.beta, "claim_next")).data.result.leaseToken;
    const wrongPeer = await tool(f, tokens.alpha, "reply", {
      requestId: id,
      leaseToken: lease,
      text: "Synthetic",
    });
    assert.equal(wrongPeer.isError, true);
    const crafted = await tool(f, tokens.beta, "get_status", { requestId: `${id}/cancel` });
    assert.equal(crafted.isError, true);
    assert.match(crafted.data, /Input validation error/);
    assert.equal(
      (await tool(f, tokens.alpha, "get_status", { requestId: id })).data.result.state,
      "leased",
    );
    assert.equal((await tool(f, `ttm_${"x".repeat(43)}`, "who_am_i")).status, 401);
  } finally {
    await f.close();
  }
});
