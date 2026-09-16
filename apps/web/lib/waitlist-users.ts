import type { User } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin";
import {
  answerLabel,
  isDeclined,
  type ApplicationAnswers,
} from "./application-questions";

export type WaitlistUser = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  status: "pending" | "approved";
  /** How the user described themselves in onboarding (label or free text). */
  role: string | null;
  phone: string | null;
  /** Early-access questionnaire, already resolved to human labels. */
  application: {
    describes: string | null;
    capital: string | null;
    process: string | null;
    hardest: string | null;
    win: string | null;
    agreement: string | null;
    submittedAt: string | null;
  } | null;
  /** They picked "I don't accept" on the agreement question. */
  declined: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  active_trader: "Active trader",
  long_term_investor: "Long-term investor",
  market_researcher: "Market researcher",
  getting_serious: "Getting serious",
  finance_professional: "Finance professional",
  other: "Other",
};

function roleLabel(investorRole: string | null, other: string | null): string | null {
  if (!investorRole) return null;
  if (investorRole === "other") return other?.trim() || "Other";
  return ROLE_LABELS[investorRole] ?? investorRole;
}

/** Map of user_id → onboarding role label. Best effort — never blocks the list. */
async function loadRolesByUserId(userIds: string[]): Promise<Map<string, string>> {
  const roles = new Map<string, string>();
  if (userIds.length === 0) return roles;

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("onboarding_responses")
      .select("user_id, investor_role, investor_role_other")
      .in("user_id", userIds);

    if (error || !data) return roles;

    for (const row of data as Array<{
      user_id: string;
      investor_role: string | null;
      investor_role_other: string | null;
    }>) {
      const label = roleLabel(row.investor_role, row.investor_role_other);
      if (label) roles.set(row.user_id, label);
    }
  } catch {
    // table may not exist yet — leave roles empty
  }

  return roles;
}

function isApprovedMetadata(user: User): boolean {
  // Only app_metadata reflects real access (service-role writes). user_metadata
  // is client-writable, so reading it here would let a forged flag make the
  // admin dashboard display an unapproved account as approved.
  return (user.app_metadata ?? {}).approved === true;
}

function isWaitlistMetadata(user: User): boolean {
  const userMeta = user.user_metadata ?? {};
  const appMeta = user.app_metadata ?? {};
  return userMeta.waitlist === true || appMeta.waitlist === true;
}

function mapUser(user: User, role: string | null): WaitlistUser {
  const metadata = user.user_metadata ?? {};
  const approved = isApprovedMetadata(user) || !isWaitlistMetadata(user);
  const answers = (
    metadata.application && typeof metadata.application === "object"
      ? metadata.application
      : null
  ) as ApplicationAnswers | null;

  return {
    id: user.id,
    email: user.email ?? "—",
    name: typeof metadata.full_name === "string" ? metadata.full_name : null,
    createdAt: user.created_at,
    status: approved ? "approved" : "pending",
    // The questionnaire's own answer wins over the older onboarding table.
    role: answerLabel("describes", answers) ?? role,
    phone: typeof metadata.phone === "string" ? metadata.phone : null,
    application: answers
      ? {
          describes: answerLabel("describes", answers),
          capital: answerLabel("capital", answers),
          process: answerLabel("process", answers),
          hardest: answerLabel("hardest", answers),
          win: answerLabel("win", answers),
          agreement: answerLabel("agreement", answers),
          submittedAt: answers.submittedAt ?? null,
        }
      : null,
    declined: isDeclined(answers),
  };
}

export async function listWaitlistUsers(): Promise<WaitlistUser[]> {
  const admin = getSupabaseAdmin();
  const users: User[] = [];
  let page = 1;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 100,
    });

    if (error) throw error;

    users.push(...data.users);
    if (data.users.length < 100) break;
    page += 1;
  }

  const waitlisted = users.filter(
    (user) => isWaitlistMetadata(user) || isApprovedMetadata(user),
  );
  const roles = await loadRolesByUserId(waitlisted.map((u) => u.id));

  return waitlisted
    .map((user) => mapUser(user, roles.get(user.id) ?? null))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function approveWaitlistUser(userId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data, error: fetchError } = await admin.auth.admin.getUserById(userId);
  if (fetchError) throw fetchError;

  const metadata = data.user.user_metadata ?? {};
  const appMetadata = data.user.app_metadata ?? {};
  const approvedAt = new Date().toISOString();

  // Confirm email on approve — waitlist signups are often unconfirmed, and
  // Supabase blocks signInWithPassword until email_confirmed_at is set.
  const { error } = await admin.auth.admin.updateUserById(userId, {
    email_confirm: true,
    user_metadata: {
      ...metadata,
      waitlist: false,
      approved: true,
      approved_at: approvedAt,
      email_verified: true,
    },
    app_metadata: {
      ...appMetadata,
      waitlist: false,
      approved: true,
      approved_at: approvedAt,
    },
  });

  if (error) throw error;
}

export async function removeWaitlistUser(userId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw error;
}
