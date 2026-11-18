import { json, preflight } from "@/lib/strategy/guard";
import { SESSIONS_TABLE, deskDb, isMissingTable, sessionId, unavailable } from "@/lib/desk/sessions-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One Falcon AI session of the signed-in member: GET loads it with its messages, DELETE removes it. */

export async function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const c = await deskDb(request);
  if (!c.ok) return c.response;
  const id = sessionId(params.id);
  if (!id) return json({ error: "Unknown session." }, 400, c.origin);
  const { data, error } = await c.db
    .from(SESSIONS_TABLE)
    .select("id, title, pinned, sort_order, folder, messages, created_at, updated_at")
    .eq("user_id", c.userId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return unavailable(c.origin);
    console.error("[api/desk/sessions] load", error.code);
    return json({ error: "The session could not be loaded." }, 503, c.origin);
  }
  if (!data) return json({ error: "Not found." }, 404, c.origin);
  return json({ available: true, session: data }, 200, c.origin);
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const c = await deskDb(request);
  if (!c.ok) return c.response;
  const id = sessionId(params.id);
  if (!id) return json({ error: "Unknown session." }, 400, c.origin);
  const { error } = await c.db.from(SESSIONS_TABLE).delete().eq("user_id", c.userId).eq("id", id);
  if (error) {
    if (isMissingTable(error)) return unavailable(c.origin);
    console.error("[api/desk/sessions] delete", error.code);
    return json({ error: "The session could not be deleted." }, 503, c.origin);
  }
  return json({ available: true, deleted: id }, 200, c.origin);
}
