import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "./supabase-admin";

/**
 * Server-only data layer for single-use invite links (staff | manager | talent_manager).
 * Tokens are unguessable, single-use, and expire after 24h. Claiming is atomic
 * (a conditional UPDATE), so a token can never be redeemed twice. Reads/writes
 * use the service role; the `admin_invites` table has RLS on with no policies.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type InviteRole = "staff" | "deputy" | "leader" | "talent_manager";
export type InviteStatus = "active" | "claimed" | "expired";

export type Invite = {
  id: string;
  token: string;
  role: InviteRole;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedEmail: string | null;
  status: InviteStatus;
};

type InviteRow = {
  id: string;
  token: string;
  role: InviteRole;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claimed_email: string | null;
};

export class InviteTableMissingError extends Error {
  constructor() {
    super("admin_invites table does not exist");
    this.name = "InviteTableMissingError";
  }
}

export type ClaimFailureReason = "not_found" | "already_used" | "expired";
export class InviteClaimError extends Error {
  constructor(public reason: ClaimFailureReason) {
    super(reason);
    this.name = "InviteClaimError";
  }
}

function isMissingTableError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /admin_invites/.test(error.message ?? "") && /exist/i.test(error.message ?? "");
}

function statusOf(row: InviteRow, now = Date.now()): InviteStatus {
  if (row.claimed_at) return "claimed";
  if (Date.parse(row.expires_at) <= now) return "expired";
  return "active";
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    token: row.token,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    claimedEmail: row.claimed_email,
    status: statusOf(row),
  };
}

export async function createInvite(role: InviteRole, createdBy: string): Promise<Invite> {
  const admin = getSupabaseAdmin();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + DAY_MS).toISOString();

  const { data, error } = await admin
    .from("admin_invites")
    .insert({ token, role, created_by: createdBy, expires_at: expiresAt })
    .select("id, token, role, created_by, created_at, expires_at, claimed_at, claimed_by, claimed_email")
    .single();

  if (error) {
    if (isMissingTableError(error)) throw new InviteTableMissingError();
    throw error;
  }
  return toInvite(data as InviteRow);
}

export async function listInvites(): Promise<Invite[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("admin_invites")
    .select("id, token, role, created_by, created_at, expires_at, claimed_at, claimed_by, claimed_email")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    if (isMissingTableError(error)) throw new InviteTableMissingError();
    throw error;
  }
  return (data ?? []).map((r) => toInvite(r as InviteRow));
}

/** Read a token's role + status without consuming it (for the claim page). */
export async function getInvite(token: string): Promise<Invite | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("admin_invites")
    .select("id, token, role, created_by, created_at, expires_at, claimed_at, claimed_by, claimed_email")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) throw new InviteTableMissingError();
    throw error;
  }
  return data ? toInvite(data as InviteRow) : null;
}

/**
 * Atomically consume a token for a user. The conditional UPDATE (claimed_at is
 * null AND not expired) guarantees single use even under concurrent requests.
 * Throws InviteClaimError with a specific reason on failure.
 */
export async function claimInvite(
  token: string,
  userId: string,
  email: string | null,
): Promise<InviteRole> {
  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data, error } = await admin
    .from("admin_invites")
    .update({ claimed_at: nowIso, claimed_by: userId, claimed_email: email })
    .eq("token", token)
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .select("role")
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) throw new InviteTableMissingError();
    throw error;
  }

  if (data?.role) return data.role as InviteRole;

  // Update matched nothing — figure out why for a precise message.
  const existing = await getInvite(token);
  if (!existing) throw new InviteClaimError("not_found");
  if (existing.claimedAt) throw new InviteClaimError("already_used");
  throw new InviteClaimError("expired");
}
