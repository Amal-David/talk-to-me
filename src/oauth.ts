import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  type OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import {
  CONNECTION_DAYS,
  config,
  connectionDays,
  identities,
  identity,
  identityKey,
  identityLabel,
  LABEL_MAX,
} from "./config";
import { mcpResponse } from "./mcp";
import { approvalPage } from "./owner-pages";
import type { ConnectionProps, Env } from "./types";
import { bodyJson, digest, errorResponse, fail, fields, response, textValue } from "./validation";

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
export const owner = (env: Env) => env.OWNER.get(env.OWNER.idFromName("owner"));

// Copies the library's consent cookies and framing headers onto our own response.
function withLibraryHeaders(res: Response, headers: Headers): Response {
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name !== "set-cookie" && name !== "location" && !res.headers.has(key))
      res.headers.set(key, value);
  });
  for (const cookie of headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
  return res;
}

async function authorize(request: Request, env: OAuthEnv, allowlist: string[]): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    // Refuse before rendering, so an approval page never offers to send a token elsewhere.
    if (!allowlist.includes(authRequest.redirectUri)) fail(400, "redirect_not_allowed");
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    // No agent names on this page: anyone can reach it, so they appear only after the passkey.
    return withLibraryHeaders(approvalPage(details, consent.handle), consent.headers);
  }
  if (request.method !== "POST") fail(405, "method_not_allowed");
  if (request.headers.get("origin") !== new URL(request.url).origin) fail(403, "origin_mismatch");
  const body = await bodyJson(request);
  const handle = textValue(body.handle, 512);
  // The approval page posts JSON and follows the returned address itself.
  if (body.decision === "deny") {
    fields(body, ["handle", "decision"]);
    const denied = await oauth.denyConsent(request, handle);
    return withLibraryHeaders(response({ redirectTo: denied.redirectTo }), denied.headers);
  }
  const relayOwner = owner(env);
  // Step 1: the owner's passkey, checked before the consent is consumed so a failed touch can
  // be retried. Only then does the page learn which agents a connection may act as.
  if (body.decision === "verify") {
    fields(body, ["handle", "decision", "assertion"]);
    if (!(await relayOwner.verifyApproval(handle, body.assertion)))
      fail(401, "passkey_not_verified");
    return response({
      identities: identities(config(env)).map((i) => ({
        id: identityKey(i),
        label: identityLabel(i),
      })),
      days: CONNECTION_DAYS,
    });
  }
  // Step 2: the owner's choice, accepted once per verified approval.
  fields(body, ["handle", "decision", "identity", "days"]);
  if (body.decision !== "approve") fail(400, "invalid_decision");
  const target = identity(config(env), body.identity);
  const days = connectionDays(body.days);
  if (!(await relayOwner.consumeApproval(handle))) fail(401, "passkey_not_verified");
  const approved = await oauth.approveConsent(request, handle);
  const authRequest = approved.request;
  // Checked again because the allowlist can change between page load and approval.
  if (!allowlist.includes(authRequest.redirectUri)) fail(400, "redirect_not_allowed");
  const details = await oauth.describeConsent(authRequest);
  const props = await relayOwner.createConnection({
    ...target,
    days,
    label: Array.from(`${details.clientName} → ${details.redirectHost}`)
      .slice(0, LABEL_MAX)
      .join(""),
    credential: { kind: "oauth", clientId: authRequest.clientId },
  });
  let redirectTo: string;
  try {
    ({ redirectTo } = await oauth.completeAuthorization({
      request: authRequest,
      // The library forbids ":" in user IDs, which group and peer IDs may contain.
      userId: await digest(identityKey(target)),
      metadata: {},
      scope: authRequest.scope,
      props,
    }));
  } catch (error) {
    // No grant was issued, so the connection must not stay live.
    await relayOwner.revokeConnection(props.connectionId);
    throw error;
  }
  return withLibraryHeaders(response({ redirectTo }), approved.headers);
}

// The MCP endpoint. The Owner object's check makes revocation take effect on the next call.
async function protectedResource(request: Request, env: Env, ctx: ExecutionContext) {
  const props = ctx.props as ConnectionProps;
  const live = await owner(env).activeConnection(props.connectionId);
  if (live) return mcpResponse(request, env, { group: live.group, peer: live.peer });
  const res = response({ error: "invalid_token" }, 401);
  res.headers.set("WWW-Authenticate", 'Bearer error="invalid_token"');
  return res;
}

export function oauthProvider(
  origin: URL,
  allowlist: string[],
  relayRoutes: (request: Request, env: Env) => Promise<Response>,
): OAuthProvider<Env> {
  const resource = `${origin.origin}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: protectedResource } satisfies ExportedHandler<Env>,
    defaultHandler: {
      fetch: async (request, env) => {
        if (new URL(request.url).pathname !== "/authorize") return relayRoutes(request, env);
        try {
          return await authorize(request, env as OAuthEnv, allowlist);
        } catch (error) {
          if (error instanceof AuthorizationError || error instanceof CimdFetchError)
            return response({ error: "invalid_authorization_request" }, 400);
          return errorResponse(error);
        }
      },
    } satisfies ExportedHandler<Env>,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // Exactly what live ChatGPT and Grok connectors requested and accepted.
    scopesSupported: ["relay", "offline_access"],
    requiredScopes: ["relay"],
    resourceMetadata: {
      resource,
      authorization_servers: [origin.origin],
      resource_name: "talk-to-me",
    },
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || !uris.every((uri) => allowlist.includes(uri)))
        return { code: "invalid_redirect_uri", description: "redirect_uri is not allowed" };
      return undefined;
    },
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      const connection = props as ConnectionProps;
      if (grantType === "authorization_code")
        return {
          refreshTokenTTL: Math.max(60, Math.floor((connection.expiresAt - Date.now()) / 1000)),
        };
      // A revoked or expired connection cannot refresh; invalid_grant also deletes the grant.
      if (!(await owner(env).activeConnection(connection.connectionId)))
        throw new OAuthError("invalid_grant", { description: "connection is no longer active" });
      return undefined;
    },
    resolveExternalToken: async ({ token, env }) => {
      const props = await owner(env).tokenConnection(token);
      return props ? { props, audience: resource } : null;
    },
  });
}
