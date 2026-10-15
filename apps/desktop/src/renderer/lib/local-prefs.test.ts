import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listLocalPreferenceKeys, resetLocalPreferences, type PrefsStore } from "./local-prefs";

/** A Storage stand-in that keeps insertion order, as browsers do in practice. */
function memoryStore(initial: Record<string, string>): PrefsStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("local preferences reset", () => {
  it("removes every falcon.ui. key, including neighbours", () => {
    const store = memoryStore({
      "falcon.ui.theme.choice": "dark",
      "falcon.ui.cardOrder.v4": "[]",
      "falcon.ui.shortcuts.v1": "{}",
    });
    const removed = resetLocalPreferences(store);
    assert.deepEqual(removed, ["falcon.ui.theme.choice", "falcon.ui.cardOrder.v4", "falcon.ui.shortcuts.v1"]);
    assert.equal(store.data.size, 0);
  });

  it("leaves the reader's own data and the session alone", () => {
    const store = memoryStore({
      "falcon.ui.chartTimeframe": "1M",
      "falcon.paper.u1.cash": "10000",
      "falcon.paperBalance": "5",
      "meridian-watchlist": "[]",
      "meridian-recent-stock-search": "[]",
      "sb-abc-auth-token": "{}",
      "falcon.uiish": "x",
    });
    resetLocalPreferences(store);
    assert.deepEqual(
      [...store.data.keys()],
      [
        "falcon.paper.u1.cash",
        "falcon.paperBalance",
        "meridian-watchlist",
        "meridian-recent-stock-search",
        "sb-abc-auth-token",
        "falcon.uiish",
      ],
    );
  });

  it("is a no-op without storage", () => {
    assert.deepEqual(listLocalPreferenceKeys(null), []);
    assert.deepEqual(resetLocalPreferences(null), []);
  });
});
