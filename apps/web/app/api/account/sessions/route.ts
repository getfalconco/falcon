import { NextResponse } from "next/server";
import { deviceLabel } from "@/lib/account/user-agent";
import { coarseLocation, isUuid, sessionIdFromToken, sortSessions, type SessionView, type SessionsResponse } from "@/lib/account/sessions";
import { SessionsUnavailable, endSession, listSessions } from "@/lib/account/sessions-server";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";

/**
 * Settings > Account, "Where you're logged in".
 *
 * GET lists the signed-in member's unexpired sessions from auth.sessions
 * (lib/account/sessions-server.ts): device from the stored user agent, the
 * current one marked from the access token's `session_id` claim. Location is
 * only known for this request (the host's geo headers); other rows show a
 * dash. IPs are never read, returned or logged. When auth.sessions cannot be
 * read (no DATABASE_URL, no permission) it answers `listed: false` with this
 * device only.
 *
 * DELETE { id } ends one of the member's other sessions and its refresh
 * tokens. "Log out of all devices" is supabase.auth.signOut({ scope: "global" })
 * on the client, not this route.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function code(err: unknown): string {
  return err instanceof SessionsUnavailable ? err.message : "unexpected";
}

export async function GET(request: Request) {
  const token = bearerToken(request);
  const user = await userFromAccessToken(token).catch(() => null);
  if (!token || !user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  const currentId = sessionIdFromToken(token);
  const here = coarseLocation(request.headers);

  try {
    const rows = await listSessions(user.id);
    const sessions: SessionView[] = rows.map((r) => ({
      id: r.id,
      device: deviceLabel(r.user_agent),
      current: r.id === currentId,
      location: r.id === currentId ? here : null,
      signedInAt: new Date(r.created_at).toISOString(),
      lastActiveAt: new Date(r.last_active_at).toISOString(),
    }));
    const body: SessionsResponse = { listed: true, sessions: sortSessions(sessions) };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    console.error("[account/sessions] list", code(err));
    const body: SessionsResponse = {
      listed: false,
      current: currentId
        ? { id: currentId, device: deviceLabel(request.headers.get("user-agent")), location: here, current: true, signedInAt: null, lastActiveAt: new Date().toISOString() }
        : null,
    };
    return NextResponse.json(body, { headers: NO_STORE });
  }
}

export async function DELETE(request: Request) {
  const token = bearerToken(request);
  const user = await userFromAccessToken(token).catch(() => null);
  if (!token || !user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: NO_STORE });

  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = body?.id;
  if (!isUuid(id)) return NextResponse.json({ error: "Unknown session." }, { status: 400, headers: NO_STORE });
  if (id === sessionIdFromToken(token)) return NextResponse.json({ error: "Use Log out to end this session." }, { status: 400, headers: NO_STORE });

  try {
    const ended = await endSession(user.id, id);
    if (!ended) return NextResponse.json({ error: "That session has already ended." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    console.error("[account/sessions] end", code(err));
    return NextResponse.json({ error: "Could not log that device out. Try again." }, { status: 503, headers: NO_STORE });
  }
}
