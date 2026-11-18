/**
 * Falcon AI memory: short durable preferences and facts a member asked it to
 * keep ("answer in Turkish, briefly", "focus on semiconductors"), used in every
 * session. Pure (no server or browser imports).
 *
 * Until the desk_memory table is applied, the client keeps the list in
 * localStorage (lab/memory-store.ts) and sends it with each chat request as
 * `memory: [{ id, text }]`; the route puts memoryBlock() into the system
 * prompt. The `remember` / `forget` tools (lib/desk/tools/memory.ts) change
 * nothing on the server: the route sends the change on the tool's "done"
 * activity line as `memory: MemoryEvent`, and the client applies it
 * (memoryEventsFromStream, applyMemoryEvents).
 */

export type MemoryItem = { id: string; text: string; at: number };
export type MemoryEvent = { op: "remember"; id: string; text: string } | { op: "forget"; id: string };

export const MEMORY_MAX_ITEMS = 30;
export const MEMORY_MAX_CHARS = 200;
/** Matches TOOL_MARK in app/api/desk/chat/route.ts. */
const TOOL_MARK = "\u001d";

/** One line of memory text: whitespace folded, trimmed, capped. Empty when there is nothing. */
export function memoryText(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > MEMORY_MAX_CHARS ? `${t.slice(0, MEMORY_MAX_CHARS - 1)}…` : t;
}

/** A memory list from storage or a request: valid items only, no duplicates, the newest MEMORY_MAX_ITEMS. */
export function cleanMemory(v: unknown): MemoryItem[] {
  if (!Array.isArray(v)) return [];
  const out: MemoryItem[] = [];
  const seenId = new Set<string>();
  const seenText = new Set<string>();
  for (const x of v) {
    const o = x as Partial<MemoryItem> | null;
    if (!o || typeof o !== "object" || typeof o.id !== "string" || !o.id || o.id.length > 64) continue;
    const text = memoryText(o.text);
    const key = text.toLowerCase();
    if (!text || seenId.has(o.id) || seenText.has(key)) continue;
    seenId.add(o.id);
    seenText.add(key);
    out.push({ id: o.id, text, at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0 });
  }
  return out.slice(-MEMORY_MAX_ITEMS);
}

/** The system prompt block for the saved items, or null when there are none. */
export function memoryBlock(items: MemoryItem[]): string | null {
  if (!items.length) return null;
  return [
    "Memory: what this member asked you to remember across sessions. Follow it in every reply unless their current message says otherwise; do not mention it unless asked. Use `forget` with the id when they ask to drop or change an item.",
    ...items.map((m) => `- [${m.id}] ${m.text}`),
  ].join("\n");
}

/** Remember/forget changes in a raw reply stream (the tool "done" lines that carry `memory`), with the tool call's id. */
export function memoryEventsFromStream(raw: string): { toolId: string; event: MemoryEvent }[] {
  const out: { toolId: string; event: MemoryEvent }[] = [];
  let i = raw.indexOf(TOOL_MARK);
  while (i >= 0) {
    const nl = raw.indexOf("\n", i);
    if (nl < 0) break;
    const line = raw.slice(i + 1, nl);
    if (line.includes('"memory"')) {
      try {
        const ev = JSON.parse(line) as { id?: unknown; memory?: Partial<MemoryEvent> & { text?: unknown } };
        const m = ev.memory;
        if (typeof ev.id === "string" && m && typeof m.id === "string") {
          if (m.op === "remember" && memoryText(m.text)) out.push({ toolId: ev.id, event: { op: "remember", id: m.id, text: memoryText(m.text) } });
          else if (m.op === "forget") out.push({ toolId: ev.id, event: { op: "forget", id: m.id } });
        }
      } catch {
        // A line this client cannot read: skip it.
      }
    }
    i = raw.indexOf(TOOL_MARK, nl);
  }
  return out;
}

/** The list after these changes. Remembering an item already there (same text) only refreshes it. */
export function applyMemoryEvents(items: MemoryItem[], events: MemoryEvent[], now = Date.now()): MemoryItem[] {
  let list = items;
  for (const e of events) {
    if (e.op === "forget") list = list.filter((m) => m.id !== e.id);
    else {
      const text = memoryText(e.text);
      if (!text) continue;
      list = [...list.filter((m) => m.id !== e.id && m.text.toLowerCase() !== text.toLowerCase()), { id: e.id, text, at: now }];
    }
  }
  return list.slice(-MEMORY_MAX_ITEMS);
}

/** The item a `forget` call means: its id, else the one whose text contains (or equals) what was given. */
export function findMemory(items: MemoryItem[], idOrText: { id?: unknown; text?: unknown }): MemoryItem | null {
  const id = typeof idOrText.id === "string" ? idOrText.id.trim() : "";
  if (id) {
    const m = items.find((x) => x.id === id);
    if (m) return m;
  }
  const q = memoryText(typeof idOrText.text === "string" ? idOrText.text : typeof idOrText.id === "string" ? idOrText.id : "").toLowerCase();
  if (!q) return null;
  return items.find((x) => x.text.toLowerCase() === q) ?? items.find((x) => x.text.toLowerCase().includes(q) || q.includes(x.text.toLowerCase())) ?? null;
}

/** A short random id for a new item ("m" + 6 base-36 characters). */
export function memoryId(): string {
  return `m${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}
