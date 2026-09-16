import { requireSupabase } from "@/lib/supabase";

/**
 * Waitlist membership, read from the same endpoint the website's waitlist
 * screen uses (apps/web/app/api/waitlist/route.ts).
 */
export type Membership = {
  found: boolean;
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL ?? "https://getfalcon.co").replace(/\/$/, "");

export async function fetchMembership(email: string): Promise<Membership> {
  const res = await fetch(`${SITE_URL}/api/waitlist?email=${encodeURIComponent(email.trim())}`);
  if (!res.ok) throw new Error("Could not load your status. Try again.");

  const data = (await res.json()) as Partial<Membership>;
  return {
    found: data.found === true,
    name: data.name ?? null,
    memberNumber: data.memberNumber ?? null,
    grantedAt: data.grantedAt ?? null,
    approved: data.approved === true,
  };
}

export type ApplyInput = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

/**
 * Creates the account carrying `waitlist: true` — the same metadata shape the
 * web signup writes, so the admin Waitlist tab lists mobile applicants too.
 */
export async function applyForEarlyAccess(input: ApplyInput): Promise<void> {
  const client = requireSupabase();
  const email = input.email.trim();

  const { error } = await client.auth.signUp({
    email,
    password: input.password,
    options: {
      data: {
        full_name: input.fullName.trim(),
        phone: input.phone.trim() || null,
        waitlist: true,
      },
    },
  });

  if (error) {
    const code = error.code;
    if (code === "user_already_exists" || code === "email_exists") {
      throw new Error("That email already has an account. Check your status instead.");
    }
    throw error;
  }

  // Mirror the name into the waitlist record so the ticket has it immediately,
  // even before the email is confirmed. Best effort — never block signup.
  try {
    await fetch(`${SITE_URL}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.fullName.trim(), email }),
    });
  } catch {
    // Status screen falls back to the Supabase session's name.
  }
}
