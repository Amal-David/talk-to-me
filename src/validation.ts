export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function fail(status: number, code: string): never {
  throw new HttpError(status, code);
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(400, "invalid_object");
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(400, "unknown_field");
}
// Group, peer, topic, key and request IDs; they appear in URL paths, so nothing looser may pass.
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(400, "invalid_identifier");
  return value as string;
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    fail(400, "invalid_integer");
  return value as number;
}
export function textValue(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    // A lone UTF-16 surrogate would be stored as U+FFFD and grow past the byte count checked here.
    !value.isWellFormed() ||
    new TextEncoder().encode(value).length > maxBytes
  )
    fail(400, "invalid_text");
  return value as string;
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export async function bodyJson(
  request: Request,
  maxBytes = 32768,
): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    fail(415, "json_required");
  if (request.headers.has("content-encoding")) fail(415, "encoding_not_supported");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "body_required");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail(413, "body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return fail(400, "invalid_json");
  }
  return object(parsed);
}
export function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
export function errorResponse(error: unknown): Response {
  return error instanceof HttpError
    ? response({ error: error.code }, error.status)
    : response({ error: "internal_error" }, 500);
}
