import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  APPLICATION_QUESTIONS,
  type ApplicationAnswers,
} from "@/lib/application-questions";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import type { User } from "@supabase/supabase-js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only known question ids, trimmed and length-capped, reach the metadata. */
function sanitizeApplication(
  input: ApplicationAnswers | undefined,
): ApplicationAnswers | null {
  if (!input || typeof input !== "object") return null;

  const allowed = new Set<string>(["submittedAt"]);
  for (const question of APPLICATION_QUESTIONS) {
    allowed.add(question.id);
    allowed.add(`${question.id}Other`);
  }

  const clean: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key) || typeof raw !== "string") continue;
    const value = raw.trim().slice(0, 2000);
    if (value) clean[key] = value;
  }

  return Object.keys(clean).length > 0 ? clean : null;
}

function isMember(user: User): boolean {
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
async function memberNumberFor(email: string): Promise<number | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;

  const members = data.users
    .filter(isMember)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const idx = members.findIndex((u) => u.email?.toLowerCase() === email);
  return idx === -1 ? null : idx + 1;
}

/**
 * Membership-card lookup for the login waitlist screen: returns the member's
 * name, ordinal number and join date. Read-only; unknown emails return
 * found:false.
 */
export async function GET(request: Request) {
  try {
    // Enumeration + amplification guard: this lists every user per call.
    const limit = rateLimit(`waitlist-get:${clientIp(request)}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const url = new URL(request.url);
    const email = url.searchParams.get("email")?.trim().toLowerCase() ?? "";
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;

    const user = data.users.find((u) => u.email?.toLowerCase() === email);
    if (!user || !isMember(user)) {
      return NextResponse.json({ found: false });
    }

    const memberNumber = await memberNumberFor(email);
    const name =
      typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null;
    const approved =
      user.user_metadata?.approved === true || user.app_metadata?.approved === true;

    return NextResponse.json({
      found: true,
      name,
      memberNumber,
      grantedAt: user.created_at,
      approved,
    });
  } catch (error) {
    console.error("[api/waitlist GET]", error);
    return NextResponse.json({ error: "Failed to load membership." }, { status: 500 });
  }
}

/**
 * Pre-launch founding-membership capture. Stores name + email as a Supabase
 * auth user carrying `waitlist: true` metadata — exactly what the admin
 * Waitlist tab lists — and returns the caller's membership number (join
 * order). No password is set; this is claim capture, not a full signup.
 */
export async function POST(request: Request) {
  try {
    // Creates a Supabase auth user with no auth on the caller — throttle hard so
    // it can't be scripted into mass account creation / squatting.
    const limit = rateLimit(`waitlist-post:${clientIp(request)}`, {
      limit: 8,
      windowMs: 60_000,
    });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const body = (await request.json()) as {
      name?: string;
      email?: string;
      password?: string;
      phone?: string;
      application?: ApplicationAnswers;
    };
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    // Optional: set when the visitor signed up from the login screen, so they
    // can sign back in later with the credentials they just chose.
    const password = body.password;
    const phone = body.phone?.trim() || null;
    // The early-access questionnaire. Declining the agreement still stores the
    // application — the admin list flags it rather than dropping it.
    const application = sanitizeApplication(body.application);

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

    const admin = getSupabaseAdmin();

    // Fresh capture. Creating the user here (service role) needs no
    // confirmation email, so joining never depends on the mail provider.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: false,
      ...(password ? { password } : {}),
      user_metadata: {
        full_name: name || null,
        waitlist: true,
        ...(phone ? { phone } : {}),
        ...(application ? { application } : {}),
      },
    });

    if (!createError && created?.user) {
      const memberNumber = await memberNumberFor(email);
      return NextResponse.json({ ok: true, status: "created", memberNumber });
    }

    // Email already exists → merge the name, keep them a member, idempotently.
    // Never downgrade a user who is already approved.
    const { data: list, error: listError } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listError) throw listError;

    const existing = list.users.find((u) => u.email?.toLowerCase() === email);
    if (!existing) {
      throw createError ?? new Error("Failed to create waitlist entry.");
    }

    const meta = existing.user_metadata ?? {};
    const approved = meta.approved === true || existing.app_metadata?.approved === true;

    await admin.auth.admin.updateUserById(existing.id, {
      user_metadata: {
        ...meta,
        full_name: name || (typeof meta.full_name === "string" ? meta.full_name : null),
        waitlist: approved ? meta.waitlist === true : true,
        ...(phone ? { phone } : {}),
        // A re-application replaces the previous answers, never erases them.
        ...(application ? { application } : {}),
      },
    });

    const memberNumber = await memberNumberFor(email);
    return NextResponse.json({ ok: true, status: "updated", memberNumber });
  } catch (error) {
    console.error("[api/waitlist POST]", error);
    return NextResponse.json({ error: "Failed to claim your ticket." }, { status: 500 });
  }
}
