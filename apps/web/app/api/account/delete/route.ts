import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

/**
 * Deletes the signed-in user. The JWT identifies who; the service role
 * performs the delete (client keys cannot call admin.deleteUser).
 */
export async function POST(request: Request) {
  try {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      return NextResponse.json({ error: "Your session expired. Sign in again." }, { status: 401 });
    }

    await admin.auth.admin.signOut(data.user.id, "global").catch(() => undefined);
    const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id);
    if (deleteError) throw deleteError;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[account/delete]", error);
    return NextResponse.json({ error: "Could not delete the account." }, { status: 500 });
  }
}
