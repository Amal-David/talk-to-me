export interface Env {
  GROUPS: DurableObjectNamespace;
  OWNER: DurableObjectNamespace;
  OWNER_SETUP_CODE?: string;
  POLICY_JSON?: string;
  AUTH_TOKENS_JSON?: string;
  WAKE_ENDPOINTS_JSON?: string;
  RELAY_PUBLIC_URL?: string;
}
export interface Limits {
  leaseSeconds: number;
  maxAttempts: number;
  maxPending: number;
  maxRequests: number;
  maxClaims: number;
  maxTextBytes: number;
  maxTtlSeconds: number;
  maxHops: number;
  retentionSeconds: number;
  ratePerMinute: number;
}
export interface Route {
  from: string;
  to: string;
  topics: string[];
  reply: boolean;
}
export interface GroupPolicy {
  peers: string[];
  routes: Route[];
  limits: Limits;
  wake: Record<string, { adapter: "grok"; endpointId: string }>;
}
export interface Token {
  sha256: string;
  group: string;
  peer: string;
  role: "peer" | "admin";
  notAfter?: number;
}
export interface Config {
  groups: Record<string, GroupPolicy>;
  tokens: Token[];
}
export interface WakeEndpoint {
  group: string;
  peer: string;
  url: string;
  allowedOrigin: string;
  token: string;
}
export interface CredentialRow extends Record<string, SqlStorageValue> {
  id: string;
  public_key: string;
  counter: number;
  transports: string;
  created_at: number;
  last_used_at: number | null;
}
export type RequestState =
  | "pending"
  | "leased"
  | "completed"
  | "cancelled"
  | "expired"
  | "dead_letter";
export interface RequestRow extends Record<string, SqlStorageValue> {
  id: string;
  sender: string;
  recipient: string;
  topic: string;
  text: string | null;
  request_key: string;
  fingerprint: string;
  state: RequestState;
  created_at: number;
  expires_at: number;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  ack_at: number | null;
  result_text: string | null;
  result_key: string | null;
  result_fingerprint: string | null;
  result_lease: string | null;
  terminal_at: number | null;
  purge_at: number | null;
  parent_id: string | null;
  hops: number;
  purged: number;
}
