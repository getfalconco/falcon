import { NextResponse } from "next/server";
import { requireFounderAdmin } from "@/lib/admin-session";
import {
  approveWaitlistUser,
  listWaitlistUsers,
  removeWaitlistUser,
} from "@/lib/waitlist-users";

async function requireAdmin() {
  return requireFounderAdmin();
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const users = await listWaitlistUsers();
    return NextResponse.json({ users });
  } catch (error) {
    console.error("[admin waitlist GET]", error);
    return NextResponse.json({ error: "Failed to load waitlist users." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as {
      userId?: string;
      action?: "approve" | "remove";
    };

    if (!body.userId || !body.action) {
      return NextResponse.json({ error: "userId and action are required." }, { status: 400 });
    }

    if (body.action === "approve") {
      await approveWaitlistUser(body.userId);
    } else if (body.action === "remove") {
      await removeWaitlistUser(body.userId);
    } else {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }

    const users = await listWaitlistUsers();
    return NextResponse.json({ ok: true, users });
  } catch (error) {
    console.error("[admin waitlist PATCH]", error);
    return NextResponse.json({ error: "Failed to update waitlist user." }, { status: 500 });
  }
}
