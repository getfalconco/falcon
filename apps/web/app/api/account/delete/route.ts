import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

/**
 * Deletes the signed-in user. The JWT identifies who; the service role
 * performs the delete (client keys cannot call admin.deleteUser).
 *
 * The mobile app calls this route, and the desktop falls back to it when the
 * research-worker (which runs the same deletion inline, see
 * apps/research-worker/src/account-deletion.ts) cannot be reached. This
 * route holds no SnapTrade keys, so it does not remove the SnapTrade user
 * itself, nor the engine's risk data: it records both cleanups in
 * `account_deletion_tasks` BEFORE the auth user is deleted, and the
 * research-worker carries them out within minutes (SnapTrade with its keys,
 * the engine through /service/delete-user-data). If the tasks cannot be
 * recorded, the account is not deleted, so nothing is left behind without a
 * record.
 */

type CleanupStatus = "done" | "none" | "queued" | "unavailable";

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || /schema cache|does not exist/i.test(error.message ?? "")));
}

/** The account's SnapTrade user id, or null when it never linked a brokerage. Throws when it cannot tell. */
async function snaptradeUserIdFor(admin: ReturnType<typeof getSupabaseAdmin>, userId: string): Promise<string | null> {
  for (const table of ["snaptrade_secrets", "broker_links"]) {
    const { data, error } = await admin.from(table).select("snaptrade_user_id").eq("user_id", userId).maybeSingle();
    if (error) {
      if (isMissingTable(error)) continue;
      throw new Error(`${table} lookup failed: ${error.code ?? error.message}`);
    }
    const id = (data as { snaptrade_user_id?: string | null } | null)?.snaptrade_user_id?.trim();
    if (id) return id;
  }
  return null;
}

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
    const userId = data.user.id;

    // 1. What has to be cleaned outside Supabase auth.
    let snaptradeUserId: string | null;
    try {
      snaptradeUserId = await snaptradeUserIdFor(admin, userId);
    } catch (err) {
      console.error("[account/delete] lookup", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Could not reach your account's data. Nothing was deleted. Try again later." }, { status: 503 });
    }

    // 2. Record the cleanups before anything is deleted.
    const stamp = new Date().toISOString();
    const base = { user_id: userId, status: "pending", attempts: 0, next_attempt_at: stamp };
    const tasks = [
      ...(snaptradeUserId ? [{ ...base, task: "snaptrade_user", payload: { snaptrade_user_id: snaptradeUserId } }] : []),
      { ...base, task: "engine_risk", payload: {} },
    ];
    const { error: queueError } = await admin.from("account_deletion_tasks").insert(tasks);
    if (queueError) {
      console.error("[account/delete] queue", queueError.code ?? queueError.message);
      return NextResponse.json(
        { error: "Falcon could not schedule removal of your brokerage link and engine data. Your account was not deleted. Try again later." },
        { status: 503 },
      );
    }

    // 3. The auth user, last. Its sessions and every row keyed to it
    // (on delete cascade, including the stored SnapTrade secret) go with it.
    await admin.auth.admin.signOut(token, "global").catch(() => undefined);
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) {
      // The account still exists: its cleanups must not run.
      await admin
        .from("account_deletion_tasks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("status", "pending")
        .then(undefined, () => undefined);
      throw deleteError;
    }

    const cleanup: { snaptrade: CleanupStatus; engine: CleanupStatus } = {
      snaptrade: snaptradeUserId ? "queued" : "none",
      engine: "queued",
    };
    return NextResponse.json({ ok: true, userId, cleanup });
  } catch (error) {
    console.error("[account/delete]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not delete the account." }, { status: 500 });
  }
}
