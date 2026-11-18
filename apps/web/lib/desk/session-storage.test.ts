// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/session-storage.test.ts
// Falcon AI session storage (lib/desk/session-storage.ts), memory (lib/desk/memory.ts) and the remember/forget tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIVE_MS,
  RESULT_CHARS,
  TOMBSTONE_MS,
  addTombstones,
  beat,
  deletedKey,
  isLive,
  markDeleted,
  mergeForWrite,
  mergeIncoming,
  mergeSessions,
  migrateLegacy,
  parseStored,
  parseTombstones,
  pruneForStorage,
  sessionsKey,
  writeMerged,
  type StorageLike,
  type StoredSession,
} from "./session-storage";
import { applyMemoryEvents, cleanMemory, findMemory, memoryBlock, memoryEventsFromStream, MEMORY_MAX_ITEMS } from "./memory";
import { FORGET_TOOL, REMEMBER_TOOL, runMemoryTool } from "./tools/memory";
import { deskToolCommand } from "./tools/command";

const session = (id: string, updatedAt: number, extra: Partial<StoredSession> = {}): StoredSession => ({
  id,
  title: `S ${id}`,
  createdAt: updatedAt,
  updatedAt,
  messages: [
    { id: `${id}-u`, role: "user", text: "hi", at: updatedAt, images: [{ id: `${id}-i`, thumb: `data:image/png;base64,${"A".repeat(2000)}`, w: 10, h: 10 }] },
    { id: `${id}-a`, role: "assistant", text: "hello", at: updatedAt, tools: [{ id: "t", label: "Quote", state: "done", at: 0, result: "x".repeat(20_000), chart: { kind: "line" } }] },
  ],
  ...extra,
});

test("stored lists parse leniently", () => {
  assert.equal(parseStored(null), null);
  assert.equal(parseStored("not json"), null);
  assert.equal(parseStored("{}"), null);
  assert.deepEqual(parseStored(JSON.stringify([{ id: 1 }, session("a", 1)]))!.map((s) => s.id), ["a"]);
});

test("merge keeps the primary order and the newest copy", () => {
  const a = [session("a", 5, { title: "old" }), session("b", 1)];
  const b = [session("c", 3), session("a", 9, { title: "new" })];
  const m = mergeSessions(a, b);
  assert.deepEqual(m.map((s) => s.id), ["a", "b", "c"]);
  assert.equal(m[0].title, "new");
});

test("the sessionStorage copy is moved into localStorage once, pinned first", () => {
  const local = JSON.stringify([session("a", 5)]);
  const legacy = JSON.stringify([session("b", 2, { pinned: true }), session("a", 1, { title: "stale" })]);
  const m = migrateLegacy(local, legacy);
  assert.deepEqual(m.map((s) => s.id), ["b", "a"]);
  assert.equal(m[1].title, "S a");
  assert.deepEqual(migrateLegacy(null, legacy).map((s) => s.id), ["b", "a"]);
  assert.deepEqual(migrateLegacy(local, null).map((s) => s.id), ["a"]);
});

test("writing caps tool results and keeps charts", () => {
  const { list } = pruneForStorage([session("a", 1)]);
  const t = list[0].messages[1].tools![0];
  assert.ok(t.result!.length <= RESULT_CHARS + 20);
  assert.deepEqual(t.chart, { kind: "line" });
});

test("answered ask tokens are dropped except near the end", () => {
  const s = session("a", 1);
  s.messages = [
    { id: "1", role: "assistant", text: "q", at: 1, ask: { id: "k", questions: [], token: "T".repeat(5000), answers: [{ q: 0 }] } },
    { id: "2", role: "user", text: "x", at: 2 },
    { id: "3", role: "assistant", text: "q2", at: 3, ask: { id: "k2", questions: [], token: "keep", answers: [] } },
    { id: "4", role: "user", text: "y", at: 4 },
  ];
  const out = pruneForStorage([s]).list[0].messages;
  assert.equal(out[0].ask!.token, "");
  assert.equal(out[2].ask!.token, "keep");
});

test("over budget: oldest sessions lose results and thumbnails first, then the oldest unpinned go", () => {
  const list = [session("new", 30), session("mid", 20), session("old", 10, { pinned: true })];
  const full = pruneForStorage(list).json.length;
  const r1 = pruneForStorage(list, full - 2000);
  assert.equal(r1.dropped, 0);
  const old = r1.list.find((s) => s.id === "old")!;
  assert.ok(old.messages[1].tools![0].result!.length < 1000);
  assert.ok(r1.json.length <= full - 2000);
  // Newest untouched.
  assert.ok(r1.list.find((s) => s.id === "new")!.messages[1].tools![0].result!.length > 1000);
  const r2 = pruneForStorage(list, 900);
  assert.ok(r2.list.some((s) => s.id === "new"));
  assert.ok(r2.list.some((s) => s.id === "old"), "pinned sessions are never dropped");
  assert.ok(!r2.list.some((s) => s.id === "mid"));
  assert.equal(r2.dropped, 1);
  // Thumbnails go before sessions do.
  assert.equal(r2.list.find((s) => s.id === "old")!.messages[0].images![0].thumb, null);
});

test("memory lists are cleaned, deduped and capped", () => {
  const raw = [{ id: "m1", text: "  Prefers   Turkish " }, { id: "m1", text: "dup id" }, { id: "m2", text: "prefers turkish" }, { id: "m3", text: "" }, null, { id: 5, text: "x" }, { id: "m4", text: "y".repeat(500) }];
  const m = cleanMemory(raw);
  assert.deepEqual(m.map((x) => x.id), ["m1", "m4"]);
  assert.equal(m[0].text, "Prefers Turkish");
  assert.equal(m[1].text.length, 200);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, text: `item ${i}` }));
  assert.equal(cleanMemory(many).length, MEMORY_MAX_ITEMS);
  assert.equal(memoryBlock([]), null);
  assert.match(memoryBlock(m)!, /\[m1\] Prefers Turkish/);
});

test("remember/forget events are read from the stream and applied", () => {
  const TM = "\u001d";
  const raw =
    `text ${TM}${JSON.stringify({ id: "t1", state: "running", label: "x" })}\n` +
    `${TM}${JSON.stringify({ id: "t1", state: "done", memory: { op: "remember", id: "m9", text: "Answer in Turkish, briefly" } })}\n` +
    `more${TM}${JSON.stringify({ id: "t2", state: "done", memory: { op: "forget", id: "m1" } })}\n` +
    `${TM}{"id":"t3","memory":`;
  const ev = memoryEventsFromStream(raw);
  assert.deepEqual(ev.map((e) => e.toolId), ["t1", "t2"]);
  const next = applyMemoryEvents([{ id: "m1", text: "old", at: 0 }], ev.map((e) => e.event), 5);
  assert.deepEqual(next, [{ id: "m9", text: "Answer in Turkish, briefly", at: 5 }]);
});

test("remember and forget tools", () => {
  const items = [{ id: "m1", text: "Focuses on semiconductors", at: 0 }];
  const r = runMemoryTool(REMEMBER_TOOL.name, { text: "Answer in Turkish" }, items);
  assert.equal(r.ok, true);
  assert.equal(r.event?.op, "remember");
  assert.equal(items.length, 2);
  const again = runMemoryTool(REMEMBER_TOOL.name, { text: "answer in turkish" }, items);
  assert.equal(again.event, undefined);
  assert.equal(runMemoryTool(REMEMBER_TOOL.name, { text: " " }, items).ok, false);
  const f = runMemoryTool(FORGET_TOOL.name, { text: "semiconductors" }, items);
  assert.deepEqual(f.event, { op: "forget", id: "m1" });
  assert.equal(runMemoryTool(FORGET_TOOL.name, { id: "nope" }, items).ok, false);
  assert.equal(findMemory(items, { id: items[0].id })?.text, "Answer in Turkish");
  assert.equal(deskToolCommand("remember", { text: "Answer in Turkish" }).cmd, '/remember "Answer in Turkish"');
});

/* ---------- Two tabs of one browser (one shared localStorage, each tab its own list in memory) ---------- */

function sharedStorage(quota = Infinity): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > quota) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

/** A tab: its own list, written with writeMerged, and the storage event applied with mergeIncoming. */
function tab(storage: StorageLike, scope = "w1") {
  const t = {
    list: [] as StoredSession[],
    write(list: StoredSession[]) {
      const r = writeMerged(storage, scope, list)!;
      t.list = r.list;
      return r;
    },
    /** The storage event: another tab wrote. */
    receive() {
      t.list = mergeIncoming(t.list, parseStored(storage.getItem(sessionsKey(scope))) ?? [], parseTombstones(storage.getItem(deletedKey(scope))));
    },
    remove(id: string) {
      markDeleted(storage, scope, [id], 1_000);
      t.write(t.list.filter((s) => s.id !== id));
    },
  };
  return t;
}

const ids = (l: { id: string }[]) => l.map((s) => s.id);

test("two tabs: a session made in one tab is never dropped by the other tab's write", () => {
  const storage = sharedStorage();
  const a = tab(storage);
  const b = tab(storage);
  a.write([session("x", 1)]);
  b.receive();
  // Both tabs start a session before either has seen the other's storage event (the race that lost sessions).
  a.write([session("s1", 10), ...a.list]);
  const rb = b.write([session("s2", 11), ...b.list]);
  assert.equal(rb.adopted, true, "b's write takes in a's new session");
  assert.deepEqual(ids(parseStored(storage.getItem(sessionsKey("w1")))!).sort(), ["s1", "s2", "x"]);
  // a's storage event: a now shows b's session too, and keeps its own.
  a.receive();
  assert.deepEqual(ids(a.list).sort(), ["s1", "s2", "x"]);
  // A storage event whose list lacks a session only this tab has (written in between): kept.
  a.list = [session("s3", 12), ...a.list];
  a.receive();
  assert.ok(ids(a.list).includes("s3"));
});

test("two tabs: the copy updated last wins; a tie keeps the writer's; a deleted session stays deleted", () => {
  const storage = sharedStorage();
  const a = tab(storage);
  const b = tab(storage);
  a.write([session("s1", 10, { title: "first" }), session("x", 1)]);
  b.receive();
  // a finishes the reply in s1 (newer); b still holds the old copy and writes something else.
  a.write(a.list.map((s) => (s.id === "s1" ? { ...s, title: "answered", updatedAt: 20 } : s)));
  b.write([session("s2", 15), ...b.list]);
  const stored = parseStored(storage.getItem(sessionsKey("w1")))!;
  assert.equal(stored.find((s) => s.id === "s1")!.title, "answered", "b's stale copy does not overwrite a's newer one");
  // A tie keeps the writer's copy.
  assert.equal(mergeForWrite([session("k", 5, { title: "mine" })], [session("k", 5, { title: "stored" })]).list[0]!.title, "mine");
  // a deletes x; b, which still has it, writes again: x stays deleted, and b's list loses it on the next event.
  a.receive();
  a.remove("x");
  b.write(b.list);
  assert.ok(!ids(parseStored(storage.getItem(sessionsKey("w1")))!).includes("x"));
  b.receive();
  assert.ok(!ids(b.list).includes("x"));
  assert.deepEqual(ids(b.list).sort(), ["s1", "s2"]);
});

test("two tabs: order and pins", () => {
  const m = mergeForWrite([session("a", 1), session("c", 1)], [session("a", 1), session("b", 1), session("c", 1), session("p", 1, { pinned: true })]);
  assert.deepEqual(ids(m.list), ["p", "a", "b", "c"], "another tab's sessions keep their place among the others; pinned first");
});

test("tombstones: kept 30 days, newest first, capped", () => {
  const t = addTombstones({ old: 0, keep: TOMBSTONE_MS }, ["new"], TOMBSTONE_MS + 10);
  assert.deepEqual(Object.keys(t).sort(), ["keep", "new"]);
  assert.deepEqual(parseTombstones("not json"), {});
  assert.deepEqual(parseTombstones(JSON.stringify({ a: 1, b: "x" })), { a: 1 });
});

test("two tabs: a reply streaming in another tab shows as running while that page beats, stopped once it is gone", () => {
  let pages = beat({}, "pageA", 1_000);
  assert.equal(isLive(pages, "pageA", 1_000 + LIVE_MS - 1), true);
  assert.equal(isLive(pages, "pageA", 1_000 + LIVE_MS + 1), false, "a page that stopped beating (crashed) is gone");
  pages = beat(pages, "pageB", 2_000);
  pages = beat(pages, "pageA", 2_000, false);
  assert.equal(isLive(pages, "pageA", 2_001), false, "a page that went away removed itself");
  assert.equal(isLive(pages, "pageB", 2_001), true);
  assert.equal(isLive(pages, undefined, 2_001), false);
  assert.deepEqual(Object.keys(beat({ stale: 0 }, "p", LIVE_MS + 5)), ["p"]);
});

test("two tabs: a full disk halves the budget; a refused write returns null", () => {
  const big = Array.from({ length: 6 }, (_, i) => session(`s${i}`, i));
  const tight = sharedStorage(60_000);
  const r = writeMerged(tight, "w1", big)!;
  assert.ok(r.json.length <= 60_000);
  assert.equal(r.list.length, 6, "the tab keeps every session in memory");
  assert.equal(writeMerged(sharedStorage(10), "w1", big), null);
});
