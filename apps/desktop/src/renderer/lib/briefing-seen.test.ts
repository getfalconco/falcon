import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_OPEN_DEADLINE_MS,
  AUTO_OPEN_MIN_MS,
  BRIEFING_SHOWN_LAUNCH_KEY,
  GATHER_DEADLINE_MS,
  RESIZE_SETTLE_MS,
  RETURN_AFTER_MS,
  decideAutoOpen,
  markShownThisLaunch,
  readShownThisLaunch,
  shownThisLaunchFor,
  type AutoOpenInput,
  type SeenStore,
} from "./briefing-seen";

function memoryStore(initial: Record<string, string> = {}): SeenStore & { data: Record<string, string>; writes: number } {
  const data = { ...initial };
  const store = {
    data,
    writes: 0,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      store.writes += 1;
      data[k] = v;
    },
  };
  return store;
}

const throwingStore: SeenStore = {
  getItem: () => {
    throw new Error("storage is blocked");
  },
  setItem: () => {
    throw new Error("storage is full");
  },
};

describe("shown once per launch", () => {
  it("reads null from an empty store and round-trips a mark under the launch key", () => {
    const store = memoryStore();
    assert.equal(readShownThisLaunch(store), null);
    markShownThisLaunch(store, "2026-09-21", "2026-09-21T11:02:00.000Z");
    assert.deepEqual(readShownThisLaunch(store), { ymd: "2026-09-21", at: "2026-09-21T11:02:00.000Z" });
    assert.deepEqual(Object.keys(store.data), [BRIEFING_SHOWN_LAUNCH_KEY]);
  });

  it("is idempotent: a second mark for the same session keeps the first timestamp and writes nothing", () => {
    const store = memoryStore();
    markShownThisLaunch(store, "2026-09-21", "2026-09-21T11:02:00.000Z");
    markShownThisLaunch(store, "2026-09-21", "2026-09-21T12:40:00.000Z");
    assert.equal(store.writes, 1);
    assert.equal(readShownThisLaunch(store)?.at, "2026-09-21T11:02:00.000Z");
  });

  // One window, two sessions: the evening's mark must give way to the morning's.
  it("moves on to the next session within the same launch", () => {
    const store = memoryStore();
    markShownThisLaunch(store, "2026-09-21", "2026-09-21T11:02:00.000Z");
    assert.equal(shownThisLaunchFor(store, "2026-09-21"), true);
    assert.equal(shownThisLaunchFor(store, "2026-09-22"), false);
    markShownThisLaunch(store, "2026-09-22", "2026-09-22T00:15:00.000Z");
    assert.deepEqual(readShownThisLaunch(store), { ymd: "2026-09-22", at: "2026-09-22T00:15:00.000Z" });
    assert.equal(shownThisLaunchFor(store, "2026-09-21"), false);
  });

  it("treats corrupt or mis-shaped JSON as not shown", () => {
    for (const raw of ["{not json", "null", "42", '"2026-09-21"', "[]", '{"ymd":20260921,"at":"x"}', '{"ymd":"21/09/2026","at":"x"}', '{"ymd":"2026-09-21"}']) {
      assert.equal(readShownThisLaunch(memoryStore({ [BRIEFING_SHOWN_LAUNCH_KEY]: raw })), null, raw);
    }
  });

  it("overwrites a corrupt value instead of being stuck behind it", () => {
    const store = memoryStore({ [BRIEFING_SHOWN_LAUNCH_KEY]: "{not json" });
    markShownThisLaunch(store, "2026-09-21", "2026-09-21T11:02:00.000Z");
    assert.equal(readShownThisLaunch(store)?.ymd, "2026-09-21");
  });

  it("refuses to record something that is not a session date", () => {
    const store = memoryStore();
    markShownThisLaunch(store, "", "2026-09-21T11:02:00.000Z");
    markShownThisLaunch(store, "today", "2026-09-21T11:02:00.000Z");
    assert.equal(store.writes, 0);
  });

  it("survives a store that throws on read and on write, and reads a missing store as not shown", () => {
    assert.equal(readShownThisLaunch(throwingStore), null);
    assert.doesNotThrow(() => markShownThisLaunch(throwingStore, "2026-09-21", "2026-09-21T11:02:00.000Z"));
    assert.equal(shownThisLaunchFor(throwingStore, "2026-09-21"), false);
    assert.equal(shownThisLaunchFor(null, "2026-09-21"), false);
  });
});

const READY: AutoOpenInput = {
  enabled: true,
  demo: false,
  hasAccount: true,
  shownThisLaunch: false,
  reportReady: true,
  fullyDegraded: false,
  engaged: false,
  view: "dashboard",
  msSinceArrival: 1500,
  msSinceResize: 800,
  otherDialogOpen: false,
};

const decide = (overrides: Partial<AutoOpenInput>) => decideAutoOpen({ ...READY, ...overrides });

describe("automatic opening", () => {
  it("opens when everything lines up", () => {
    assert.equal(decide({}), "open");
  });

  // The old rule opened only in the pre-open window; the panel now has a
  // title for every phase, and the input carries no phase to test.
  it("has no phase test: the input does not even carry one", () => {
    assert.equal("phase" in READY, false);
    assert.equal("autoShow" in READY, false);
    assert.equal(decide({}), "open");
  });

  it("never: flag off, demo book, no account", () => {
    assert.equal(decide({ enabled: false }), "never");
    assert.equal(decide({ demo: true }), "never");
    assert.equal(decide({ hasAccount: false }), "never");
  });

  it("never: the reader is already doing something, or is not on the dashboard", () => {
    assert.equal(decide({ engaged: true }), "never");
    assert.equal(decide({ view: "stock" }), "never");
  });

  it("never: past the deadline, even while the report is still loading", () => {
    assert.equal(decide({ msSinceArrival: AUTO_OPEN_DEADLINE_MS + 1 }), "never");
    assert.equal(decide({ msSinceArrival: AUTO_OPEN_DEADLINE_MS + 1, reportReady: false }), "never");
    assert.equal(decide({ msSinceArrival: AUTO_OPEN_DEADLINE_MS }), "open");
  });

  it("never: already shown this launch for this session, or the report has nothing in it", () => {
    assert.equal(decide({ shownThisLaunch: true }), "never");
    assert.equal(decide({ fullyDegraded: true }), "never");
  });

  // Whether the panel was shown is judged against the report's own target
  // session, so a flag computed before the report landed is not a verdict.
  it("wait: the report has not arrived, whatever the report-side inputs say so far", () => {
    assert.equal(decide({ reportReady: false }), "wait");
    assert.equal(decide({ reportReady: false, shownThisLaunch: true, fullyDegraded: true }), "wait");
  });

  it("wait: the dashboard has not painted, the window is still growing, or a dialog is up", () => {
    assert.equal(decide({ msSinceArrival: AUTO_OPEN_MIN_MS - 1 }), "wait");
    assert.equal(decide({ msSinceArrival: AUTO_OPEN_MIN_MS }), "open");
    assert.equal(decide({ msSinceResize: RESIZE_SETTLE_MS - 1 }), "wait");
    assert.equal(decide({ msSinceResize: RESIZE_SETTLE_MS }), "open");
    assert.equal(decide({ otherDialogOpen: true }), "wait");
  });

  it("a final answer wins over a reason to wait", () => {
    assert.equal(decide({ otherDialogOpen: true, shownThisLaunch: true }), "never");
    assert.equal(decide({ msSinceResize: 0, engaged: true }), "never");
  });

  // A return from the background after RETURN_AFTER_MS is a new arrival that
  // runs this same decision. The mark, read for the report's target session,
  // is what keeps it from opening twice in one launch, and what lets it open
  // once the target has moved on to the next session.
  it("on a return, opens again only once the report hands over to a new session", () => {
    const store = memoryStore();
    markShownThisLaunch(store, "2026-09-21", "2026-09-21T11:02:00.000Z");
    assert.equal(decide({ shownThisLaunch: shownThisLaunchFor(store, "2026-09-21") }), "never");
    assert.equal(decide({ shownThisLaunch: shownThisLaunchFor(store, "2026-09-22") }), "open");
  });

  it("keeps the timing constants in the order the rules assume", () => {
    assert.ok(AUTO_OPEN_MIN_MS < AUTO_OPEN_DEADLINE_MS);
    assert.ok(RESIZE_SETTLE_MS < AUTO_OPEN_DEADLINE_MS - AUTO_OPEN_MIN_MS);
    assert.equal(RETURN_AFTER_MS, 30 * 60_000);
  });

  // The first report of a launch is usually a cold build, and the engine gives
  // itself GATHER_DEADLINE_MS for one. A deadline under that would give up
  // before the report it is waiting for could arrive, on every launch where the
  // providers take their full budget.
  it("waits out a cold build rather than giving up inside the engine's own budget", () => {
    assert.ok(
      AUTO_OPEN_DEADLINE_MS > GATHER_DEADLINE_MS,
      `the auto-open deadline (${AUTO_OPEN_DEADLINE_MS}ms) must outlast gather.ts (${GATHER_DEADLINE_MS}ms)`,
    );
    assert.equal(decide({ reportReady: false, msSinceArrival: GATHER_DEADLINE_MS }), "wait");
    assert.equal(decide({ msSinceArrival: GATHER_DEADLINE_MS }), "open");
  });
});
