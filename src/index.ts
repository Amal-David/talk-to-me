import { authenticate, config, redirectAllowlist, relayOrigin } from "./config";
import { oauthProvider, owner } from "./oauth";
import type { Env } from "./types";
import { errorResponse, fail, response } from "./validation";

export { GroupMailbox } from "./mailbox";
export { Owner } from "./owner";

async function relayRoutes(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    // Owner pages carry their own configuration and authentication.
    if ((url.pathname === "/owner" || url.pathname.startsWith("/owner/")) && !url.search)
      return owner(env).fetch(request);
    const cfg = config(env);
    if (url.pathname === "/health" && request.method === "GET")
      return response({ ok: true, protocol: "talk-to-me/1" });
    const match = /^\/v1\/groups\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\//.exec(url.pathname);
    if (!match || url.search) fail(404, "not_found");
    const name = match[1] as string;
    await authenticate(request, cfg, name);
    return env.GROUPS.get(env.GROUPS.idFromName(name)).fetch(request);
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { protocol, hostname } = new URL(request.url);
    // Checked before any route, OAuth endpoints included.
    if (protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname))
      return response({ error: "https_required" }, 400);
    let origin: URL;
    let allowlist: string[];
    try {
      origin = relayOrigin(env);
      allowlist = redirectAllowlist(env);
    } catch {
      // Without a valid relay origin and redirect allowlist there are no OAuth endpoints at all.
      return relayRoutes(request, env);
    }
    return oauthProvider(origin, allowlist, relayRoutes).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
