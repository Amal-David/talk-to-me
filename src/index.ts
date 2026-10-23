import { authenticate, config } from "./config";
import type { Env } from "./types";
import { errorResponse, fail, response } from "./validation";

export { GroupMailbox } from "./mailbox";
export { Owner } from "./owner";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        fail(400, "https_required");
      // Owner pages carry their own configuration and authentication.
      if ((url.pathname === "/owner" || url.pathname.startsWith("/owner/")) && !url.search)
        return env.OWNER.get(env.OWNER.idFromName("owner")).fetch(request);
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
  },
} satisfies ExportedHandler<Env>;
