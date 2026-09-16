import type { IncomingMessage, ServerResponse } from "node:http";
import { falconError } from "./errors.js";

/**
 * Supabase JWT verification for the compute API.
 *
 * This service holds provider API keys and runs paid LLM work, so every route
 * except /health must prove a signed-in, approved user. Rather than verify the
 * JWT signature locally (which would mean shipping the project's JWT secret
 * here), we hand the bearer token to Supabase's own /auth/v1/user endpoint —
 * the same check apps/desktop's main process makes before a privileged write.
 */

export type AuthedUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  approved: boolean;
};

function displayNameFromMetadata(
  meta: Record<string, unknown> | undefined,
  email: string | null,
): string | null {
  if (meta) {
    for (const key of ["full_name", "name", "display_name"]) {
      const value = meta[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const local = email?.split("@")[0]?.trim();
  return local || null;
}

function emailFromGoTrue(data: {
  email?: string;
  identities?: Array<{ identity_data?: Record<string, unknown> }>;
}): string | null {
  if (typeof data.email === "string" && data.email.includes("@") && !data.email.startsWith("(")) {
    return data.email.trim();
  }
  for (const identity of data.identities ?? []) {
    const nested = identity.identity_data?.email;
    if (typeof nested === "string" && nested.includes("@") && !nested.startsWith("(")) {
      return nested.trim();
    }
  }
  return null;
}

function authedUserFromGoTrue(data: {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  identities?: Array<{ identity_data?: Record<string, unknown> }>;
}): AuthedUser | null {
  if (!data.id) return null;
  const email = emailFromGoTrue(data);
  return {
    id: data.id,
    email,
    displayName: displayNameFromMetadata(data.user_metadata, email),
    // Approval is a GRANT, so it must come only from app_metadata, which the
    // service role writes. user_metadata is client-writable (a signed-in user
    // can call auth.updateUser({ data: { approved: true } })), so trusting it
    // would let any waitlisted account self-promote into paid compute.
    approved: data.app_metadata?.approved === true,
  };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { user: AuthedUser; at: number }>();

function supabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/** Resolves the caller, or null when the token is missing/invalid. */
export async function resolveUser(token: string): Promise<AuthedUser | null> {
  const cached = cache.get(token);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.user;

  const config = supabaseConfig();
  if (!config) {
    console.warn("[auth] Supabase not configured — rejecting all authed routes");
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
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
      identities?: Array<{ identity_data?: Record<string, unknown> }>;
    };
    const user = authedUserFromGoTrue(data);
    if (!user) return null;

    cache.set(token, { user, at: Date.now() });
    return user;
  } catch (err) {
    console.warn("[auth] verification failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

const userByIdCache = new Map<string, { user: AuthedUser; at: number }>();

/** Admin lookup for async job errors that only have `user_id`. */
export async function lookupUserById(userId: string): Promise<AuthedUser | null> {
  const cached = userByIdCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.user;

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  try {
    const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      user?: {
        id?: string;
        email?: string;
        user_metadata?: Record<string, unknown>;
        app_metadata?: Record<string, unknown>;
        identities?: Array<{ identity_data?: Record<string, unknown> }>;
      };
      id?: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
      identities?: Array<{ identity_data?: Record<string, unknown> }>;
    };
    const user = authedUserFromGoTrue(raw.user ?? raw);
    if (!user) return null;
    userByIdCache.set(userId, { user, at: Date.now() });
    return user;
  } catch (err) {
    console.warn("[auth] user lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function resolveUserFromReq(req: IncomingMessage): Promise<AuthedUser | null> {
  const token = bearerFrom(req);
  if (!token) return null;
  return resolveUser(token);
}

/**
 * Gate a request. Returns the user, or writes the error response and returns
 * null — callers should bail out when null.
 */
export async function requireApprovedUser(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthedUser | null> {
  const token = bearerFrom(req);
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: falconError("FAL-AUTH-01") }));
    return null;
  }

  const user = await resolveUser(token);
  if (!user) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: falconError("FAL-AUTH-02") }));
    return null;
  }

  // Compute costs money — waitlisted accounts don't get to spend it.
  if (!user.approved) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: falconError("FAL-AUTH-03") }));
    return null;
  }

  return user;
}

/**
 * Permissive CORS for desktop, Expo Go, and LAN phones.
 * React Native often sends no Origin; Expo may send exp://… — allow both.
 */
export function applyCors(res: ServerResponse, req?: IncomingMessage): void {
  const origin = typeof req?.headers.origin === "string" ? req.headers.origin.trim() : "";
  res.setHeader("Access-Control-Allow-Origin", origin && origin !== "null" ? origin : "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (origin) res.setHeader("Vary", "Origin");
}
