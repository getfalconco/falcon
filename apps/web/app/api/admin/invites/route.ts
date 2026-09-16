import { NextResponse } from "next/server";
import { requireFounderAdmin } from "@/lib/admin-session";
import {
  createInvite,
  listInvites,
  InviteTableMissingError,
  type InviteRole,
} from "@/lib/admin-invites";

const MISSING_TABLE_MSG =
  "The admin_invites table does not exist yet. Run apps/web/supabase/admin_invites.sql in the Supabase SQL editor.";

const ALLOWED_ROLES: InviteRole[] = ["staff", "deputy", "leader", "talent_manager"];

export async function GET() {
  const session = await requireFounderAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const invites = await listInvites();
    return NextResponse.json({ invites });
  } catch (error) {
    if (error instanceof InviteTableMissingError) {
      return NextResponse.json({ invites: [], missingTable: true });
    }
    console.error("[admin invites GET]", error);
    return NextResponse.json({ error: "Failed to load invites." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireFounderAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { role?: string };
    const role = body.role;
    if (!role || !ALLOWED_ROLES.includes(role as InviteRole)) {
      return NextResponse.json(
        { error: "role must be 'staff', 'deputy', 'leader', or 'talent_manager'." },
        { status: 400 },
      );
    }

    const invite = await createInvite(role as InviteRole, session.email);
    const url = `${new URL(request.url).origin}/invite/${invite.token}`;
    return NextResponse.json({ invite, url });
  } catch (error) {
    if (error instanceof InviteTableMissingError) {
      return NextResponse.json({ error: MISSING_TABLE_MSG }, { status: 409 });
    }
    console.error("[admin invites POST]", error);
    return NextResponse.json({ error: "Failed to create invite." }, { status: 500 });
  }
}
