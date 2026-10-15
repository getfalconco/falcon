import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThesisSaveError, createThesisCache, type ThesisBridge } from "./thesis-cache";
import type { StockThesisResult } from "../../../shared/stock-thesis";

/** An in-memory main process: theses per account, with a switchable failure. */
function fakeMain() {
  const byAccount = new Map<string, Map<string, string>>();
  const state = { account: "me", fail: null as null | "signed_out" | "unavailable", gets: 0, sets: [] as string[] };
  const theses = () => {
    let m = byAccount.get(state.account);
    if (!m) byAccount.set(state.account, (m = new Map()));
    return m;
  };
  const bridge: ThesisBridge = {
    async get(ticker): Promise<StockThesisResult> {
      state.gets++;
      if (state.fail) return { ok: false, error: state.fail };
      const text = theses().get(ticker);
      return { ok: true, thesis: text ? { ticker, text, updated_at: "2026-10-15T00:00:00.000Z" } : null };
    },
    async set(ticker, text): Promise<StockThesisResult> {
      state.sets.push(`${ticker}:${text}`);
      if (state.fail) return { ok: false, error: state.fail };
      if (!text.trim()) {
        theses().delete(ticker);
        return { ok: true, thesis: null };
      }
      theses().set(ticker, text);
      return { ok: true, thesis: { ticker, text, updated_at: "2026-10-15T00:00:00.000Z" } };
    },
  };
  return { bridge, state };
}

describe("thesis cache", () => {
  it("is loading until the first read, then holds the stored text", async () => {
    const { bridge } = fakeMain();
    const cache = createThesisCache(() => bridge, () => "me");
    assert.deepEqual(cache.snapshot("NVDA"), { text: null, loading: true });
    await cache.ensure("nvda");
    assert.deepEqual(cache.snapshot("NVDA"), { text: null, loading: false, loaded: true });
  });

  it("reads each ticker once, and keeps the snapshot object until it changes", async () => {
    const { bridge, state } = fakeMain();
    const cache = createThesisCache(() => bridge);
    await Promise.all([cache.ensure("NVDA"), cache.ensure("NVDA")]);
    await cache.ensure("NVDA");
    assert.equal(state.gets, 1);
    assert.equal(cache.snapshot("NVDA"), cache.snapshot("nvda"));
  });

  it("a save reaches every reader of that ticker", async () => {
    const { bridge } = fakeMain();
    const cache = createThesisCache(() => bridge);
    await cache.ensure("NVDA");
    let told = 0;
    cache.subscribe(() => told++);
    await cache.save("nvda", "Data center demand");
    assert.equal(cache.snapshot("NVDA").text, "Data center demand");
    assert.ok(told >= 1);
    await cache.save("NVDA", "");
    assert.equal(cache.snapshot("NVDA").text, null);
  });

  it("runs saves for one ticker in order, the last one standing", async () => {
    const { bridge, state } = fakeMain();
    const slow: ThesisBridge = {
      get: bridge.get,
      set: (t, text) => new Promise((resolve) => setTimeout(() => resolve(bridge.set(t, text)), text === "first" ? 20 : 0)),
    };
    const cache = createThesisCache(() => slow);
    await Promise.all([cache.save("NVDA", "first"), cache.save("NVDA", "second")]);
    assert.deepEqual(state.sets, ["NVDA:first", "NVDA:second"]);
    assert.equal(cache.snapshot("NVDA").text, "second");
  });

  it("rejects a save main did not keep, and leaves the text as it was", async () => {
    const { bridge, state } = fakeMain();
    const cache = createThesisCache(() => bridge);
    await cache.save("NVDA", "kept");
    state.fail = "unavailable";
    await assert.rejects(() => cache.save("NVDA", "lost"), (err: unknown) => err instanceof ThesisSaveError && err.code === "unavailable");
    assert.equal(cache.snapshot("NVDA").text, "kept");
    await assert.rejects(() => createThesisCache(() => null).save("NVDA", "x"), ThesisSaveError);
  });

  it("a failed read shows an empty field and is asked again next time", async () => {
    const { bridge, state } = fakeMain();
    state.fail = "signed_out";
    const cache = createThesisCache(() => bridge);
    await cache.ensure("NVDA");
    assert.deepEqual(cache.snapshot("NVDA"), { text: null, loading: false, loaded: false });
    state.fail = null;
    await bridge.set("NVDA", "Back");
    await cache.ensure("NVDA");
    assert.equal(cache.snapshot("NVDA").text, "Back");
  });

  it("drops what it read when the account changes", async () => {
    const { bridge, state } = fakeMain();
    const scope = { current: "me" };
    const cache = createThesisCache(() => bridge, () => scope.current);
    await cache.save("NVDA", "Mine");
    scope.current = "them";
    state.account = "them";
    assert.deepEqual(cache.snapshot("NVDA"), { text: null, loading: true });
    await cache.ensure("NVDA");
    assert.equal(cache.snapshot("NVDA").text, null);
  });

  it("with no bridge, shows an empty field instead of loading forever", async () => {
    const cache = createThesisCache(() => null);
    await cache.ensure("NVDA");
    assert.equal(cache.snapshot("NVDA").loading, false);
  });
});
