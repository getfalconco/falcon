import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { rateLimit } from "@/lib/rate-limit";
import { json, originAllowed, requireMember } from "@/lib/strategy/guard";

/**
 * Shared by /api/desk/sessions/*: the signed-in member, and the admin client
 * when the desk_sessions table can be used. Every query filters by the
 * member's id. `{ available: false }` (200) means "keep sessions in this
 * browser": no account (the development preview), no Supabase config, or the
 * table not applied yet (supabase/migrations/20261120_desk_sessions.sql).
 */

export const SESSIONS_TABLE = "desk_sessions";
/** Characters of one session's messages JSON the server keeps. */
export const MAX_SESSION_CHARS = 2_000_000;
export const MAX_BODY_CHARS = 4_000_000;
export const MAX_SESSIONS = 300;

/** A Postgres or PostgREST error that means the table (or column) is not there yet. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "42703") return true;
  return /does not exist|could not find the table|schema cache/i.test(error.message ?? "");
}

export const unavailable = (origin: string | null) => json({ available: false }, 200, origin);

export type DeskDb = { ok: true; db: SupabaseClient; userId: string; origin: string | null } | { ok: false; response: Response };

export async function deskDb(request: Request): Promise<DeskDb> {
  const o = originAllowed(request);
  if (!o.ok) return { ok: false, response: json({ error: "This origin is not allowed." }, 403) };
  const member = await requireMember(request);
  if (!member.ok) return { ok: false, response: json({ error: member.error }, member.status, o.origin) };
  if (!member.userId) return { ok: false, response: unavailable(o.origin) };
  const r = rateLimit(`desk-sessions:user:${member.userId}`, { limit: 240, windowMs: 60_000 });
  if (!r.ok) return { ok: false, response: json({ error: "Too many requests in a short time." }, 429, o.origin, { "Retry-After": String(r.retryAfter) }) };
  try {
    return { ok: true, db: getSupabaseAdmin(), userId: member.userId, origin: o.origin };
  } catch {
    return { ok: false, response: unavailable(o.origin) };
  }
}

/** A session id from the client: short, plain characters. */
export function sessionId(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

/** The JSON body of a request, capped; null when it is too large or not JSON. */
export async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
