import { json, preflight } from "@/lib/strategy/guard";
import { MAX_SESSIONS, MAX_SESSION_CHARS, SESSIONS_TABLE, bodyOf, deskDb, isMissingTable, sessionId, unavailable } from "@/lib/desk/sessions-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Falcon AI sessions of the signed-in member (lib/desk/sessions-db.ts).
 * GET: `{ available, sessions: [{ id, title, pinned, sort_order, folder, created_at, updated_at }] }` (no messages;
 * GET /api/desk/sessions/[id] loads one). PUT `{ sessions: [{ id, title, pinned?, folder?, sortOrder?, createdAt, updatedAt, messages }] }`
 * saves (upsert). `available: false` means the table is not there yet: the client keeps sessions in the browser.
 */

export async function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request) {
  const c = await deskDb(request);
  if (!c.ok) return c.response;
  const { data, error } = await c.db
    .from(SESSIONS_TABLE)
    .select("id, title, pinned, sort_order, folder, created_at, updated_at")
    .eq("user_id", c.userId)
    .order("pinned", { ascending: false })
    .order("sort_order", { ascending: true })
    .limit(MAX_SESSIONS);
  if (error) {
    if (isMissingTable(error)) return unavailable(c.origin);
    console.error("[api/desk/sessions] list", error.code);
    return json({ error: "Sessions could not be loaded." }, 503, c.origin);
  }
  return json({ available: true, sessions: data ?? [] }, 200, c.origin);
}

const iso = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : new Date().toISOString());

export async function PUT(request: Request) {
  const c = await deskDb(request);
  if (!c.ok) return c.response;
  const body = await bodyOf(request);
  const list = Array.isArray(body?.sessions) ? (body!.sessions as Record<string, unknown>[]) : null;
  if (!list || !list.length || list.length > 20) return json({ error: "Send { sessions: [...] } (1 to 20)." }, 400, c.origin);
  const rows = [];
  for (const s of list) {
    const id = sessionId(s?.id);
    if (!id || !Array.isArray(s.messages)) return json({ error: "Each session needs an id and messages." }, 400, c.origin);
    if (JSON.stringify(s.messages).length > MAX_SESSION_CHARS) return json({ error: "A session is too large to save." }, 413, c.origin);
    rows.push({
      user_id: c.userId,
      id,
      title: typeof s.title === "string" && s.title.trim() ? s.title.slice(0, 200) : "New session",
      pinned: s.pinned === true,
      sort_order: typeof s.sortOrder === "number" && Number.isFinite(s.sortOrder) ? Math.max(0, Math.min(1e6, Math.round(s.sortOrder))) : 0,
      folder: typeof s.folder === "string" && s.folder.trim() ? s.folder.slice(0, 100) : null,
      messages: s.messages,
      created_at: iso(s.createdAt),
      updated_at: iso(s.updatedAt),
    });
  }
  const { error } = await c.db.from(SESSIONS_TABLE).upsert(rows, { onConflict: "user_id,id" });
  if (error) {
    if (isMissingTable(error)) return unavailable(c.origin);
    console.error("[api/desk/sessions] save", error.code);
    return json({ error: "Sessions could not be saved." }, 503, c.origin);
  }
  return json({ available: true, saved: rows.length }, 200, c.origin);
}
