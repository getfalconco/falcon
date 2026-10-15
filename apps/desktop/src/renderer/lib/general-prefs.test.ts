import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forgetStartScreen, readBriefingAutoOpenPref, RETIRED_START_KEYS, writeBriefingAutoOpenPref } from "./general-prefs";

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("general prefs", () => {
  it("keeps the briefing auto-open switch, on by default", () => {
    const s = memory();
    assert.equal(readBriefingAutoOpenPref(s), true);
    writeBriefingAutoOpenPref(false, s);
    assert.equal(readBriefingAutoOpenPref(s), false);
    writeBriefingAutoOpenPref(true, s);
    assert.equal(readBriefingAutoOpenPref(s), true);
  });

  it("drops the retired start-screen keys and nothing else", () => {
    const s = memory();
    s.setItem("falcon.ui.startView", "last");
    s.setItem("falcon.ui.lastScreen", JSON.stringify({ view: "stock", stock: { symbol: "NVDA" }, tab: "calendar" }));
    writeBriefingAutoOpenPref(false, s);
    forgetStartScreen(s);
    for (const key of RETIRED_START_KEYS) assert.equal(s.getItem(key), null);
    assert.equal(readBriefingAutoOpenPref(s), false);
    forgetStartScreen(s);
    assert.equal(s.data.size, 1);
  });

  it("survives having no storage, or storage that throws", () => {
    assert.equal(readBriefingAutoOpenPref(null), true);
    forgetStartScreen(null);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    assert.equal(readBriefingAutoOpenPref(broken), true);
    writeBriefingAutoOpenPref(false, broken);
    forgetStartScreen(broken);
  });
});
