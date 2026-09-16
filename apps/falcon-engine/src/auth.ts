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

import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthedUser = { id: string; email: string | null; approved: boolean };

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

/** Gate a request. Returns the user, or writes the error and returns null. */
export async function requireApprovedUser(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthedUser | null> {
  const token = bearerFrom(req);
  if (!token) return deny(res, 401, "Sign in required.");
  const user = await resolveUser(token);
  if (!user) return deny(res, 401, "Session expired or invalid.");
  if (!user.approved) return deny(res, 403, "This account is not approved yet.");
  return user;
}
