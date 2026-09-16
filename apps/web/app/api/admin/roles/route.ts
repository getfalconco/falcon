import { NextResponse } from "next/server";
import { requireFounderAdmin } from "@/lib/admin-session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

async function findUserIdByEmail(email: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  const normalized = email.trim().toLowerCase();

  // Paginate — Auth Admin has no getUserByEmail helper in all SDK versions.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    const users = data?.users ?? [];
    const match = users.find((u) => (u.email ?? "").toLowerCase() === normalized);
    if (match) return match.id;
    if (users.length < 200) break;
  }
  return null;
}

/**
 * Founder-only: set app_metadata.role on an existing Falcon account
 * (e.g. promote Aras from staff → talent_manager without a new invite).
 */
export async function POST(request: Request) {
  const session = await requireFounderAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { email?: string; role?: string };
    const email = body.email?.trim().toLowerCase() ?? "";
    const role = body.role?.trim();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    if (role !== "talent_manager") {
      return NextResponse.json(
        { error: "Only role 'talent_manager' can be granted here." },
        { status: 400 },
      );
    }

    const userId = await findUserIdByEmail(email);
    if (!userId) {
      return NextResponse.json(
        { error: "No Falcon account found for that email. Ask them to sign up first." },
        { status: 404 },
      );
    }

    const admin = getSupabaseAdmin();
    const { data: existing, error: getError } = await admin.auth.admin.getUserById(userId);
    if (getError || !existing.user) {
      return NextResponse.json({ error: "Could not load user." }, { status: 500 });
    }

    const user = existing.user;
    const grantedAt = new Date().toISOString();
    const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...(user.user_metadata ?? {}),
        role,
        approved: true,
        waitlist: false,
        role_granted_at: grantedAt,
      },
      app_metadata: {
        ...(user.app_metadata ?? {}),
        role,
        approved: true,
        waitlist: false,
      },
    });

    if (updateError) {
      console.error("[admin roles]", updateError);
      return NextResponse.json({ error: "Failed to update role." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, email, role });
  } catch (err) {
    console.error("[admin roles]", err);
    return NextResponse.json({ error: "Failed to grant role." }, { status: 500 });
  }
}
