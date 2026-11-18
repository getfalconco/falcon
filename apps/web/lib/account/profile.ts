/**
 * The member's profile in Settings > Account. Everything lives in Supabase
 * auth `user_metadata` (written with supabase.auth.updateUser):
 *   full_name       the waitlist and early-access forms already set it
 *   preferred_name  what the Dashboard greets them by ("Evening, Kuzey")
 *   work_role       one of WORK_ROLES
 *   avatar_path     "<user_id>/avatar.<ext>" in the private `avatars` bucket
 * user_metadata is client-writable, so none of it is ever used to authorize.
 */

export const NAME_MAX = 80;

export const WORK_ROLES = [
  { id: "individual_investor", label: "Individual investor" },
  { id: "active_trader", label: "Active trader" },
  { id: "financial_advisor", label: "Financial advisor" },
  { id: "analyst_researcher", label: "Analyst / researcher" },
  { id: "portfolio_manager", label: "Portfolio manager" },
  { id: "founder_executive", label: "Founder / executive" },
  { id: "student", label: "Student" },
  { id: "other", label: "Other" },
] as const;

export type WorkRoleId = (typeof WORK_ROLES)[number]["id"];

export function isWorkRole(value: unknown): value is WorkRoleId {
  return typeof value === "string" && WORK_ROLES.some((r) => r.id === value);
}

export type Profile = {
  fullName: string;
  preferredName: string;
  workRole: WorkRoleId | null;
  avatarPath: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, NAME_MAX) : "";
}

/** The profile fields out of a user's `user_metadata`; anything malformed reads as empty. */
export function readProfile(metadata: Record<string, unknown> | null | undefined): Profile {
  const m = metadata ?? {};
  return {
    fullName: text(m.full_name),
    preferredName: text(m.preferred_name),
    workRole: isWorkRole(m.work_role) ? m.work_role : null,
    avatarPath: typeof m.avatar_path === "string" && m.avatar_path ? m.avatar_path : null,
  };
}

/** A name as it is saved: trimmed, inner runs of spaces collapsed, capped. */
export function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}
