import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUserEventsStore } from "./user-events-store";

let dir: string;
let file: string;
let user = "user-a";
let ids = 0;

function makeStore() {
  return createUserEventsStore({
    file,
    userKey: () => user,
    now: () => new Date("2026-10-10T09:00:00.000Z"),
    newId: () => `ue_test${String(++ids).padStart(4, "0")}`,
  });
}

const timed = {
  title: "Call with IR",
  all_day: false,
  date: null,
  end_date: null,
  start_at: "2026-10-12T13:00:00.000Z",
  end_at: "2026-10-12T14:00:00.000Z",
  ticker: "nvda",
  sector: "Technology",
  color: "blue",
  notes: "Ask about supply.",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-cal-"));
  file = path.join(dir, "calendar", "user-events.json");
  user = "user-a";
  ids = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("user events store", () => {
  it("creates, lists, updates and deletes an event", () => {
    const store = makeStore();
    const created = store.create(timed);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.event.ticker, "NVDA");
    assert.equal(created.event.created_at, "2026-10-10T09:00:00.000Z");
    assert.deepEqual(store.list().map((e) => e.id), [created.event.id]);

    const updated = store.update(created.event.id, { ...timed, title: "Call moved", start_at: "2026-10-13T13:00:00.000Z", end_at: "2026-10-13T13:30:00.000Z" });
    assert.equal(updated.ok, true);
    assert.equal(store.list()[0].title, "Call moved");
    assert.equal(store.list()[0].created_at, created.event.created_at);

    assert.deepEqual(store.remove(created.event.id), { ok: true });
    assert.deepEqual(store.list(), []);
    // Gone already is still a success.
    assert.deepEqual(store.remove(created.event.id), { ok: true });
  });

  it("refuses invalid input without touching the file", () => {
    const store = makeStore();
    const result = store.create({ ...timed, end_at: "2026-10-12T12:00:00.000Z" });
    assert.deepEqual(result, { ok: false, error: "The event ends before it starts.", code: "endsBeforeStart" });
    assert.equal(fs.existsSync(file), false);
  });

  it("keeps each account's events apart", () => {
    const store = makeStore();
    store.create(timed);
    user = "user-b";
    assert.deepEqual(store.list(), []);
    store.create({ ...timed, title: "Other account" });
    assert.equal(store.list().length, 1);
    user = "user-a";
    assert.equal(store.list()[0].title, "Call with IR");
  });

  it("drops a corrupt row on load and keeps the rest", () => {
    const store = makeStore();
    const created = store.create(timed);
    assert.equal(created.ok, true);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    disk.users["user-a"].push({ id: "../../etc", title: "bad" }, { id: "ue_brokenrow", title: "", all_day: true });
    fs.writeFileSync(file, JSON.stringify(disk));
    assert.equal(store.list().length, 1);
  });

  it("treats an unreadable file as empty", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    const store = makeStore();
    assert.deepEqual(store.list(), []);
    assert.equal(store.create(timed).ok, true);
  });

  it("refuses ids that are not its own and updates of missing events", () => {
    const store = makeStore();
    assert.equal(store.update("../x", timed).ok, false);
    assert.equal(store.update("ue_missing000", timed).ok, false);
    assert.equal(store.remove(42).ok, false);
  });

  it("sorts all-day events by date with timed ones", () => {
    const store = makeStore();
    store.create(timed);
    store.create({ ...timed, title: "Holiday", all_day: true, date: "2026-10-11", end_date: "2026-10-11", start_at: null, end_at: null });
    assert.deepEqual(store.list().map((e) => e.title), ["Holiday", "Call with IR"]);
  });
});
