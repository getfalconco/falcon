/**
 * Supabase JWT verification for the engine API — the same check
 * apps/research-worker makes, for the same reason.
 *
 * This process holds the Anthropic, Finnhub and Supabase service-role keys and
 * spends real money on every cycle it runs. So every route except /health must
 * prove a signed-in, approved user. The token is handed to Supabase's own
 * /auth/v1/user endpoint rather than verified locally, which keeps the
 * project's JWT secret off this box.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isEngineStaff } from "@meridian/research/engine-channels";

export type AuthedUser = {
  id: string;
  email: string | null;
  approved: boolean;
  /**
   * An invited internal role that counts as engine staff
   * (`app_metadata.role`: staff, deputy, leader; not talent_manager, which
   * runs internships only). Only staff may call the channels that change the
   * shared chain for everyone (STAFF_ENGINE_CHANNELS).
   */
  staff: boolean;
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { user: AuthedUser; at: number }>();

function supabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/$/, ""), anonKey };
}

function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function resolveUser(token: string): Promise<AuthedUser | null> {
  const cached = cache.get(token);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.user;

  const config = supabaseConfig();
  if (!config) {
    console.warn("[engine] Supabase not configured — rejecting all authed routes");
    return null;
  }
  try {
    const res = await fetch(`${config.url}/auth/v1/user`, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: string;
      email?: string;
      app_metadata?: Record<string, unknown>;
    };
    if (!data.id) return null;
    const user: AuthedUser = {
      id: data.id,
      email: typeof data.email === "string" ? data.email : null,
      // Approval is a GRANT: only app_metadata, which the service role writes.
      // user_metadata is client-writable, so trusting it would let a waitlisted
      // account promote itself into paid compute.
      approved: data.app_metadata?.approved === true,
      // Same rule: the role is app_metadata only, never user_metadata.
      staff: isEngineStaff(data.app_metadata),
    };
    cache.set(token, { user, at: Date.now() });
    return user;
  } catch (err) {
    console.warn(`[engine] auth verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function deny(res: ServerResponse, status: number, message: string): null {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: message }));
  return null;
}

export type AuthOutcome =
  | { ok: true; user: AuthedUser }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Decide who a request is. The identity is whatever Supabase says the bearer
 * token belongs to; nothing the caller puts in the body or a header other
 * than Authorization can change it. `approved: false` accepts a signed-in
 * user who is not approved (used only for deleting one's own data).
 */
export async function authenticate(
  req: Pick<IncomingMessage, "headers">,
  options: { approved?: boolean } = {},
): Promise<AuthOutcome> {
  const token = bearerFrom(req as IncomingMessage);
  if (!token) return { ok: false, status: 401, error: "Sign in required." };
  const user = await resolveUser(token);
  if (!user) return { ok: false, status: 401, error: "Session expired or invalid." };
  if (options.approved !== false && !user.approved) {
    return { ok: false, status: 403, error: "This account is not approved yet." };
  }
  return { ok: true, user };
}

/** Gate a request. Returns the user, or writes the error and returns null. */
export async function requireApprovedUser(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthedUser | null> {
  const outcome = await authenticate(req);
  return outcome.ok ? outcome.user : deny(res, outcome.status, outcome.error);
}

/**
 * Gate a request on a valid session only, approved or not. For the one route
 * where refusing an unapproved user would be wrong: erasing their own data.
 */
export async function requireSignedInUser(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthedUser | null> {
  const outcome = await authenticate(req, { approved: false });
  return outcome.ok ? outcome.user : deny(res, outcome.status, outcome.error);
}

/**
 * Service-to-service credential, for the one call that must work after the
 * user's own token is gone: the research worker's account-deletion queue
 * retrying "delete this user's engine data" once the auth user no longer
 * exists. Set the same random value as FALCON_ENGINE_SERVICE_TOKEN on both
 * services. Unset here means the service routes are off (503), never open.
 */
export type ServiceAuthOutcome = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function checkServiceToken(req: Pick<IncomingMessage, "headers">): ServiceAuthOutcome {
  const expected = process.env.FALCON_ENGINE_SERVICE_TOKEN?.trim() ?? "";
  if (expected.length < 32) {
    return { ok: false, status: 503, error: "Service access is not configured." };
  }
  const given = bearerFrom(req as IncomingMessage) ?? "";
  // Compare digests so the comparison is constant-time and length-blind.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!given || !timingSafeEqual(a, b)) return { ok: false, status: 401, error: "Invalid service credential." };
  return { ok: true };
}

export function requireServiceToken(req: IncomingMessage, res: ServerResponse): boolean {
  const outcome = checkServiceToken(req);
  if (!outcome.ok) deny(res, outcome.status, outcome.error);
  return outcome.ok;
}

/** Tests only: forget cached token lookups. */
export function clearAuthCache(): void {
  cache.clear();
}
