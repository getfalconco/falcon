import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHomeTabStore, overlayShowing } from "./home-tab-store";

describe("home tab store", () => {
  it("starts with only the first tab mounted", () => {
    const s = createHomeTabStore("dashboard");
    assert.deepEqual(s.get(), { tab: "dashboard", mounted: ["dashboard"] });
  });

  it("keeps every opened tab mounted, in the fixed tab order", () => {
    const s = createHomeTabStore("dashboard");
    s.open("earnings");
    s.open("calendar");
    assert.equal(s.get().tab, "calendar");
    assert.deepEqual(s.get().mounted, ["dashboard", "calendar", "earnings"]);
  });

  it("keeps the same mounted list (by reference) on a switch between kept tabs", () => {
    const s = createHomeTabStore("dashboard");
    s.open("calendar");
    const before = s.get().mounted;
    s.open("dashboard");
    assert.equal(s.get().mounted, before);
  });

  it("drops an evicted tab, but never the one being opened", () => {
    const s = createHomeTabStore("dashboard");
    s.open("calendar");
    s.open("agents", "calendar");
    assert.deepEqual(s.get().mounted, ["dashboard", "agents"]);
    s.open("agents", "agents");
    assert.deepEqual(s.get().mounted, ["dashboard", "agents"]);
  });

  it("can unmount the front tab, and opening it mounts it again", () => {
    const s = createHomeTabStore("dashboard");
    s.open("calendar");
    s.evict("calendar");
    assert.deepEqual(s.get(), { tab: "calendar", mounted: ["dashboard"] });
    s.open("calendar");
    assert.deepEqual(s.get().mounted, ["dashboard", "calendar"]);
  });

  it("mounts a prefetched tab behind the front one", () => {
    const s = createHomeTabStore("dashboard");
    s.mount("agents");
    assert.deepEqual(s.get(), { tab: "dashboard", mounted: ["dashboard", "agents"] });
  });

  it("tells subscribers only about real changes", () => {
    const s = createHomeTabStore("dashboard");
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.open("dashboard");
    s.mount("dashboard");
    assert.equal(calls, 0);
    s.open("calendar");
    s.mount("calendar");
    assert.equal(calls, 1);
    off();
    s.open("agents");
    assert.equal(calls, 1);
  });
});

describe("overlayShowing", () => {
  const root = (els: Array<{ visible: boolean }>) => ({
    querySelectorAll: () => els.map((e) => ({ checkVisibility: () => e.visible })) as unknown as NodeListOf<HTMLElement>,
  });
  it("is false with no dialogs, or only hidden ones", () => {
    assert.equal(overlayShowing(null), false);
    assert.equal(overlayShowing(root([])), false);
    assert.equal(overlayShowing(root([{ visible: false }])), false);
  });
  it("is true with a dialog on screen", () => {
    assert.equal(overlayShowing(root([{ visible: false }, { visible: true }])), true);
  });
});
