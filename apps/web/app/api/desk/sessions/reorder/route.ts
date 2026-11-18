import { json, preflight } from "@/lib/strategy/guard";
import { MAX_SESSIONS, SESSIONS_TABLE, bodyOf, deskDb, isMissingTable, sessionId, unavailable } from "@/lib/desk/sessions-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST `{ ids: [...] }`: the member's grid order (pinned first); sort_order becomes each id's position. */

export async function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request) {
  const c = await deskDb(request);
  if (!c.ok) return c.response;
  const body = await bodyOf(request);
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).map(sessionId) : null;
  if (!ids || ids.length > MAX_SESSIONS || ids.some((x) => !x)) return json({ error: "Send { ids: [...] }." }, 400, c.origin);
  const results = await Promise.all(ids.map((id, i) => c.db.from(SESSIONS_TABLE).update({ sort_order: i }).eq("user_id", c.userId).eq("id", id!)));
  const error = results.find((r) => r.error)?.error;
  if (error) {
    if (isMissingTable(error)) return unavailable(c.origin);
    console.error("[api/desk/sessions] reorder", error.code);
    return json({ error: "The order could not be saved." }, 503, c.origin);
  }
  return json({ available: true }, 200, c.origin);
}
