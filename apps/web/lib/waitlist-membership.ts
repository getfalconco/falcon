import type { User } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

/**
 * Server-only helpers for the waitlist routes (app/api/waitlist/*). Route
 * files may only export handlers, so the shared pieces live here.
 */

/** The ticket a member sees about themselves. Never anyone else's. */
export type OwnMembership = {
  found: boolean;
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

export const NOT_A_MEMBER: OwnMembership = {
  found: false,
  name: null,
  memberNumber: null,
  grantedAt: null,
  approved: false,
};

export function isMember(user: User): boolean {
  const userMeta = user.user_metadata ?? {};
  const appMeta = user.app_metadata ?? {};
  return (
    userMeta.waitlist === true ||
    appMeta.waitlist === true ||
    userMeta.approved === true ||
    appMeta.approved === true
  );
}

/** Ordinal position of `email` among all members, by join date (1-based). */
export async function memberNumberFor(email: string): Promise<number | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;

  const target = email.trim().toLowerCase();
  const members = data.users
    .filter(isMember)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const idx = members.findIndex((u) => u.email?.toLowerCase() === target);
  return idx === -1 ? null : idx + 1;
}

/** The bearer token on a request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 ? token : null;
}

/**
 * Verifies a Supabase access token server-side and returns its user, or null
 * when the token is missing, expired or revoked.
 */
export async function userFromAccessToken(token: string | null): Promise<User | null> {
  if (!token) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

/**
 * The signed-in user's own ticket. Approval is read from app_metadata only,
 * the service-role-only half (user_metadata is client-writable).
 */
export async function membershipOf(user: User): Promise<OwnMembership> {
  if (!user.email || !isMember(user)) return NOT_A_MEMBER;
  const name =
    typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : null;
  return {
    found: true,
    name,
    memberNumber: await memberNumberFor(user.email),
    grantedAt: user.created_at ?? null,
    approved: user.app_metadata?.approved === true,
  };
}
