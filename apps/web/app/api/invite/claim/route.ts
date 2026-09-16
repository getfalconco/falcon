import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  claimInvite,
  InviteClaimError,
  InviteTableMissingError,
} from "@/lib/admin-invites";

const CLAIM_MESSAGES: Record<string, string> = {
  not_found: "This invite link is not valid.",
  already_used: "This invite link has already been used.",
  expired: "This invite link has expired.",
};

export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const accessToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!accessToken) {
    return NextResponse.json({ error: "You must be signed in to claim an invite." }, { status: 401 });
  }

  let token: string;
  try {
    const body = (await request.json()) as { token?: string };
    if (!body.token) {
      return NextResponse.json({ error: "Missing invite token." }, { status: 400 });
    }
    token = body.token;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Verify the caller's identity from their Supabase access token.
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user) {
    return NextResponse.json({ error: "Your session is invalid. Sign in again." }, { status: 401 });
  }

  try {
    // Consume the token atomically first, then grant the role to this account.
    const role = await claimInvite(token, user.id, user.email ?? null);

    const userMeta = user.user_metadata ?? {};
    const appMeta = user.app_metadata ?? {};
    const grantedAt = new Date().toISOString();

    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      email_confirm: true,
      user_metadata: {
        ...userMeta,
        role,
        approved: true,
        waitlist: false,
        role_granted_at: grantedAt,
      },
      app_metadata: {
        ...appMeta,
        role,
        approved: true,
        waitlist: false,
      },
    });

    if (updateError) {
      console.error("[invite claim] role grant failed", updateError);
      return NextResponse.json(
        { error: "Invite consumed but the role could not be applied. Contact an admin." },
        { status: 500 },
      );
    }

    const name =
      (typeof userMeta.full_name === "string" && userMeta.full_name.trim()) ||
      (user.email ? user.email.split("@")[0] : "Member");

    return NextResponse.json({ ok: true, role, name });
  } catch (error) {
    if (error instanceof InviteClaimError) {
      return NextResponse.json(
        { error: CLAIM_MESSAGES[error.reason] ?? "This invite link cannot be used." },
        { status: 409 },
      );
    }
    if (error instanceof InviteTableMissingError) {
      return NextResponse.json({ error: "Invites are not configured yet." }, { status: 409 });
    }
    console.error("[invite claim]", error);
    return NextResponse.json({ error: "Failed to claim invite." }, { status: 500 });
  }
}
