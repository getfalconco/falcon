import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TrackerStore } from "./store.js";
import type { TrackerMessage } from "./types.js";

/**
 * The message log is read through a bounded in-memory tail now, never as one
 * string — these pin the behaviours the readers rely on: newest first, the
 * ticker filter, the persisted count, and that a second store instance sees
 * what another one appended.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tracker-store-"));
}

function msg(i: number, ticker: string): TrackerMessage {
  return {
    id: `m-${i}`,
    ticker,
    type: "quant_snapshot",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  } as unknown as TrackerMessage;
}

test("readMessages returns newest first, honours limit and ticker", () => {
  const store = new TrackerStore(tmpDir());
  for (let i = 0; i < 30; i++) store.appendMessage(msg(i, i % 3 === 0 ? "AAPL" : "MSFT"));

  const all = store.readMessages({ limit: 5 });
  assert.deepEqual(
    all.map((m) => m.id),
    ["m-29", "m-28", "m-27", "m-26", "m-25"],
  );
  const aapl = store.readMessages({ ticker: "aapl", limit: 3 });
  assert.deepEqual(
    aapl.map((m) => m.id),
    ["m-27", "m-24", "m-21"],
  );
  assert.equal(store.readMessages({ limit: 1000 }).length, 30);
});

test("messageStats counts every persisted line and reports the newest timestamp", () => {
  const dir = tmpDir();
  const store = new TrackerStore(dir);
  assert.deepEqual(store.messageStats(), { count: 0, lastAt: null });
  for (let i = 0; i < 12; i++) store.appendMessage(msg(i, "NVDA"));
  assert.deepEqual(store.messageStats(), { count: 12, lastAt: msg(11, "NVDA").timestamp });
  // Another 5 after the tail was first built: folded in, not rebuilt.
  for (let i = 12; i < 17; i++) store.appendMessage(msg(i, "NVDA"));
  assert.equal(store.messageStats().count, 17);
  assert.equal(store.readMessages({ limit: 1 })[0].id, "m-16");
});

test("a second store instance sees lines another instance appended", () => {
  const dir = tmpDir();
  const writer = new TrackerStore(dir);
  const reader = new TrackerStore(dir);
  writer.appendMessage(msg(0, "AMD"));
  assert.equal(reader.readMessages().length, 1);
  writer.appendMessage(msg(1, "AMD"));
  writer.appendMessage(msg(2, "TSM"));
  assert.deepEqual(
    reader.readMessages().map((m) => m.id),
    ["m-2", "m-1", "m-0"],
  );
  assert.equal(reader.messageStats().count, 3);
});

test("a half-written last line is left for the next read, and corrupt lines are skipped", () => {
  const dir = tmpDir();
  const store = new TrackerStore(dir);
  store.appendMessage(msg(0, "AMD"));
  const file = path.join(dir, "messages.jsonl");
  fs.appendFileSync(file, "not json\n", "utf8");
  fs.appendFileSync(file, '{"id":"m-1","ticker":"AMD","ty', "utf8");
  assert.deepEqual(
    store.readMessages().map((m) => m.id),
    ["m-0"],
  );
  fs.appendFileSync(file, 'pe":"x","timestamp":"2026-01-01T00:00:01.000Z"}\n', "utf8");
  assert.deepEqual(
    store.readMessages().map((m) => m.id),
    ["m-1", "m-0"],
  );
});

test("a log rewritten under the store is rebuilt from its end", () => {
  const dir = tmpDir();
  const store = new TrackerStore(dir);
  for (let i = 0; i < 5; i++) store.appendMessage(msg(i, "AMD"));
  assert.equal(store.messageStats().count, 5);
  fs.writeFileSync(path.join(dir, "messages.jsonl"), `${JSON.stringify(msg(99, "AMD"))}\n`, "utf8");
  assert.deepEqual(
    store.readMessages().map((m) => m.id),
    ["m-99"],
  );
  assert.equal(store.messageStats().count, 1);
});
