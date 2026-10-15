import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createThesisStore, readTheses, removeTheses, thesisFile } from "./thesis-store";
import { THESIS_MAX_CHARS, THESIS_MAX_PER_USER } from "../../shared/stock-thesis";

const ME = "56b7a75c-ac79-4e42-8286-26596d02622d";
const OTHER = "11111111-2222-3333-4444-555555555555";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-theses-"));
}

function storeFor(root: string, key: { current: string }, at = "2026-10-15T09:00:00.000Z") {
  return createThesisStore({ root, userKey: () => key.current, now: () => new Date(at) });
}

describe("thesis store", () => {
  it("saves, reads back and clears a thesis per ticker", () => {
    const root = tempRoot();
    const store = storeFor(root, { current: ME });
    assert.deepEqual(store.get("nvda"), { ok: true, thesis: null });
    const saved = store.set("nvda", "  Data center demand keeps rising.\r\nMargins hold up.  \n\n");
    assert.deepEqual(saved, {
      ok: true,
      thesis: { ticker: "NVDA", text: "  Data center demand keeps rising.\nMargins hold up.", updated_at: "2026-10-15T09:00:00.000Z" },
    });
    assert.deepEqual(store.get("NVDA"), saved);
    const onDisk = JSON.parse(fs.readFileSync(thesisFile(root, ME)!, "utf8"));
    assert.deepEqual(Object.keys(onDisk.theses), ["NVDA"]);
    assert.deepEqual(store.set("NVDA", "   "), { ok: true, thesis: null });
    assert.deepEqual(store.get("NVDA"), { ok: true, thesis: null });
  });

  it("keeps each account's theses in its own file", () => {
    const root = tempRoot();
    const key = { current: ME };
    const store = storeFor(root, key);
    store.set("AAPL", "Mine");
    key.current = OTHER;
    assert.deepEqual(store.get("AAPL"), { ok: true, thesis: null });
    store.set("AAPL", "Theirs");
    key.current = ME;
    const mine = store.get("AAPL");
    assert.equal(mine.ok && mine.thesis?.text, "Mine");
    assert.deepEqual(
      readTheses(root, OTHER).map((t) => t.text),
      ["Theirs"],
    );
  });

  it("reads and writes nothing without a signed-in account", () => {
    const root = tempRoot();
    for (const k of ["anon", "local", "", "../etc"]) {
      const store = storeFor(root, { current: k });
      assert.deepEqual(store.get("NVDA"), { ok: false, error: "signed_out" });
      assert.deepEqual(store.set("NVDA", "x"), { ok: false, error: "signed_out" });
    }
    assert.equal(fs.existsSync(path.join(root, "theses")), false);
  });

  it("refuses a ticker that is not one and text over the cap", () => {
    const store = storeFor(tempRoot(), { current: ME });
    assert.deepEqual(store.set("../x", "a"), { ok: false, error: "invalid_ticker" });
    assert.deepEqual(store.get(42), { ok: false, error: "invalid_ticker" });
    assert.deepEqual(store.set("NVDA", "x".repeat(THESIS_MAX_CHARS + 1)), { ok: false, error: "too_long" });
    assert.deepEqual(store.set("NVDA", { text: "x" }), { ok: false, error: "too_long" });
    assert.equal(store.set("BRK.B", "x".repeat(THESIS_MAX_CHARS)).ok, true);
  });

  it("caps how many tickers one account keeps", () => {
    const root = tempRoot();
    const theses: Record<string, unknown> = {};
    for (let i = 0; i < THESIS_MAX_PER_USER; i++) theses[`T${i}`] = { text: "x", updated_at: "2026-10-01T00:00:00.000Z" };
    fs.mkdirSync(path.join(root, "theses"), { recursive: true });
    fs.writeFileSync(thesisFile(root, ME)!, JSON.stringify({ schema_version: 1, theses }));
    const store = storeFor(root, { current: ME });
    assert.deepEqual(store.set("NEW", "x"), { ok: false, error: "full" });
    assert.equal(store.set("T1", "edited").ok, true);
  });

  it("drops a bad row on its own and survives a broken file", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "theses"), { recursive: true });
    fs.writeFileSync(
      thesisFile(root, ME)!,
      JSON.stringify({ schema_version: 1, theses: { NVDA: { text: "Good", updated_at: "2026-10-01T00:00:00.000Z" }, AMD: { text: 7 }, "a/b": { text: "x" } } }),
    );
    assert.deepEqual(
      readTheses(root, ME).map((t) => t.ticker),
      ["NVDA"],
    );
    fs.writeFileSync(thesisFile(root, OTHER)!, "{ not json");
    const store = storeFor(root, { current: OTHER });
    assert.deepEqual(store.get("NVDA"), { ok: true, thesis: null });
    assert.equal(store.set("NVDA", "Fresh").ok, true);
  });

  it("removes the account's file on deletion, and only that one", () => {
    const root = tempRoot();
    const key = { current: ME };
    const store = storeFor(root, key);
    store.set("NVDA", "Mine");
    key.current = OTHER;
    store.set("NVDA", "Theirs");
    removeTheses(root, ME);
    removeTheses(root, ME);
    assert.equal(fs.existsSync(thesisFile(root, ME)!), false);
    assert.equal(fs.existsSync(thesisFile(root, OTHER)!), true);
    assert.throws(() => removeTheses(root, "local"));
  });
});
