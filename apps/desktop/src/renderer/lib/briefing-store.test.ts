import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildDemoBriefing } from "../../shared/briefing-demo";
import type {
  BriefingGetResult,
  BriefingNarrativeResult,
  BriefingReport,
  BriefingRequest,
  BriefingWindow,
  Story,
} from "../../shared/briefing-types";
import {
  MANUAL_REFRESH_THROTTLE_MS,
  OPEN_REFETCH_DELAY_MS,
  cadenceMs,
  getBriefingState,
  holdingsKey,
  isFullyDegraded,
  isStale,
  manualRefreshAvailableAt,
  nextPollDelayMs,
  refreshBriefing,
  requestFromAccount,
  resetBriefingStore,
  retainBriefing,
  subscribeBriefing,
  toErrorCode,
} from "./briefing-store";
import { isDemoMode, mulberry32, toggleDemoMode } from "./demo-mode";

const MIN = 60_000;

/** Tuesday 2026-09-22, seen from 07:16 ET. */
const WINDOW: BriefingWindow = {
  target_session_ymd: "2026-09-22",
  prev_session_ymd: "2026-09-21",
  overnight_since: "2026-09-21T20:00:00.000Z",
  window_opens_at: "2026-09-22T00:00:00.000Z",
  target_open_at: "2026-09-22T13:30:00.000Z",
  target_close_at: "2026-09-22T20:00:00.000Z",
  phase: "pre_open",
  auto_show: true,
  handover: "overnight",
  early_close: false,
};

/** A complete report, as the main process would send it: not a demo, template narrative, model version pending. */
function liveReport(factsHash = "facts-1"): BriefingReport {
  const base = buildDemoBriefing(mulberry32(11), WINDOW, [{ symbol: "NVDA", shares: 10, cost_usd: 1500 }], 2500);
  return {
    ...base,
    demo: false,
    facts_hash: factsHash,
    narrative: { ...base.narrative, text: "Template text.", source: "template", facts_hash: factsHash, pending: true },
  };
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("holdingsKey", () => {
  it("does not depend on the order or the casing of the holdings", () => {
    const a = holdingsKey(
      [
        { symbol: "nvda", shares: 10, cost_usd: 1 },
        { symbol: "AAPL", shares: 2.5, cost_usd: 1 },
      ],
      1000,
    );
    const b = holdingsKey(
      [
        { symbol: "AAPL", shares: 2.5, cost_usd: 99 },
        { symbol: "NVDA ", shares: 10, cost_usd: 99 },
      ],
      1000,
    );
    assert.equal(a, b);
    assert.equal(a, "AAPL:2.5000,NVDA:10.0000|1000");
  });

  it("ignores float residue in shares and cash, and sees a real change", () => {
    const base = holdingsKey([{ symbol: "NVDA", shares: 10, cost_usd: 1 }], 1000);
    assert.equal(holdingsKey([{ symbol: "NVDA", shares: 10.00000001, cost_usd: 1 }], 1000.004), base);
    assert.notEqual(holdingsKey([{ symbol: "NVDA", shares: 10.001, cost_usd: 1 }], 1000), base);
    assert.notEqual(holdingsKey([{ symbol: "NVDA", shares: 10, cost_usd: 1 }], 1002), base);
    assert.notEqual(holdingsKey([{ symbol: "NVDA", shares: -10, cost_usd: 1 }], 1000), base);
  });

  it("never prints a negative zero or a non-number", () => {
    assert.equal(holdingsKey([{ symbol: "X", shares: -0.00001, cost_usd: 0 }], Number.NaN), "X:0.0000|0");
    assert.equal(holdingsKey([{ symbol: "X", shares: Number.NaN, cost_usd: 0 }], 0), "X:0.0000|0");
    assert.equal(holdingsKey([], 0), "|0");
  });
});

describe("cadenceMs / isStale", () => {
  it("polls fastest before the open and slowest between sessions", () => {
    assert.equal(cadenceMs("pre_open"), 5 * MIN);
    assert.equal(cadenceMs("in_session"), 30 * MIN);
    assert.equal(cadenceMs("between_sessions"), 60 * MIN);
    assert.equal(cadenceMs("something_new" as never), 60 * MIN);
  });

  it("calls a report stale once it is one cadence old, and always when there is none", () => {
    const t = 1_000_000_000;
    assert.equal(isStale(null, "pre_open", t), true);
    assert.equal(isStale(Number.NaN, "pre_open", t), true);
    assert.equal(isStale(t - 5 * MIN + 1, "pre_open", t), false);
    assert.equal(isStale(t - 5 * MIN, "pre_open", t), true);
    assert.equal(isStale(t - 6 * MIN, "in_session", t), false);
  });
});

describe("nextPollDelayMs", () => {
  const open = Date.parse(WINDOW.target_open_at);

  it("waits one cadence from the last attempt", () => {
    const last = open - 3 * 60 * MIN;
    assert.equal(nextPollDelayMs({ lastAttemptAt: last, phase: "pre_open", targetOpenAt: WINDOW.target_open_at, nowMs: last + MIN }), 4 * MIN);
  });

  it("comes forward to just after the open when that is sooner", () => {
    const last = open - 2 * MIN;
    const delay = nextPollDelayMs({ lastAttemptAt: last, phase: "pre_open", targetOpenAt: WINDOW.target_open_at, nowMs: last });
    assert.equal(delay, 2 * MIN + OPEN_REFETCH_DELAY_MS);
  });

  it("does not keep firing once an attempt has seen the open", () => {
    const last = open + OPEN_REFETCH_DELAY_MS + 1;
    const delay = nextPollDelayMs({ lastAttemptAt: last, phase: "in_session", targetOpenAt: WINDOW.target_open_at, nowMs: last });
    assert.equal(delay, 30 * MIN);
  });

  it("is zero when the machine slept through the moment, and survives an unreadable open", () => {
    const last = open - 2 * MIN;
    assert.equal(nextPollDelayMs({ lastAttemptAt: last, phase: "pre_open", targetOpenAt: WINDOW.target_open_at, nowMs: open + 60 * MIN }), 0);
    assert.equal(nextPollDelayMs({ lastAttemptAt: last, phase: "pre_open", targetOpenAt: "not a date", nowMs: last }), 5 * MIN);
    assert.equal(nextPollDelayMs({ lastAttemptAt: last, phase: "pre_open", targetOpenAt: null, nowMs: last }), 5 * MIN);
  });
});

describe("requestFromAccount", () => {
  it("keeps real positions, upper-cases them and drops dust", () => {
    const request = requestFromAccount({
      cash: 1234.5,
      positions: {
        nvda: { symbol: "nvda", shares: 3, costUsd: 450 },
        TSLA: { symbol: "TSLA", shares: -2, costUsd: -660 },
        DUST: { symbol: "DUST", shares: 1e-12, costUsd: 0 },
        BAD: { symbol: "BAD", shares: Number.NaN, costUsd: 1 },
      },
    });
    assert.deepEqual(request, {
      holdings: [
        { symbol: "NVDA", shares: 3, cost_usd: 450 },
        { symbol: "TSLA", shares: -2, cost_usd: -660 },
      ],
      cash: 1234.5,
    });
  });

  it("reads an unreadable cash balance as zero", () => {
    assert.deepEqual(requestFromAccount({ cash: Number.NaN, positions: {} }), { holdings: [], cash: 0 });
  });
});

describe("isFullyDegraded", () => {
  it("is false for a report with anything overnight in it", () => {
    assert.equal(isFullyDegraded(liveReport()), false);
  });

  it("is true when no market row carries a move and the held names are silent", () => {
    const report = liveReport();
    const empty: BriefingReport = {
      ...report,
      overnight: {
        markets: report.overnight.markets.map((r) => ({ ...r, state: "unavailable" as const, move: null })),
        held_movers: [],
        held_news: [],
        filings: [],
        measurements: [],
      },
    };
    assert.equal(isFullyDegraded(empty), true);
    assert.equal(isFullyDegraded({ ...empty, overnight: { ...empty.overnight, held_movers: report.overnight.held_movers } }), false);
  });

  it("reads a section missing from an older cached report as empty", () => {
    const report = liveReport();
    assert.equal(isFullyDegraded({ ...report, overnight: {} as BriefingReport["overnight"] }), true);
  });
});

describe("toErrorCode", () => {
  it("lets the fixed codes through and nothing else", () => {
    assert.equal(toErrorCode("not_found"), "not_found");
    assert.equal(toErrorCode("build_failed"), "build_failed");
    assert.equal(toErrorCode("401 Unauthorized: Bearer sk-live-abc"), "unavailable");
    assert.equal(toErrorCode(new Error("boom")), "unavailable");
    assert.equal(toErrorCode(undefined), "unavailable");
  });
});

// ---------------------------------------------------------------------------
// The store, against a stand-in for the preload bridge
// ---------------------------------------------------------------------------

type Bridge = {
  getBriefing?: (request: BriefingRequest) => Promise<BriefingGetResult>;
  getBriefingNarrative?: (request: { target_session_ymd: string; facts_hash: string }) => Promise<BriefingNarrativeResult>;
};

const globals = globalThis as unknown as { window?: unknown; document?: unknown; localStorage?: unknown };

function installWindow(bridge: Bridge | undefined): void {
  globals.window = Object.assign(new EventTarget(), { meridian: bridge });
  globals.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
}

/** The paper account reads the legacy keys while no user is signed in, which is the case in a test. */
function installBook(cash: number, positions: Record<string, { symbol: string; shares: number; costUsd: number }>): void {
  const data = new Map<string, string>([
    ["falcon.paperBalance", String(cash)],
    ["falcon.paperPositions", JSON.stringify(positions)],
  ]);
  globals.localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-resolved promise chain in the store run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("briefing store", () => {
  beforeEach(() => {
    if (isDemoMode()) toggleDemoMode();
    resetBriefingStore();
    installBook(2500, { NVDA: { symbol: "NVDA", shares: 10, costUsd: 1500 } });
  });

  afterEach(() => {
    if (globals.window && isDemoMode()) toggleDemoMode();
    resetBriefingStore();
    delete globals.window;
    delete globals.document;
    delete globals.localStorage;
  });

  it("reports an older main process as unsupported, without throwing", async () => {
    installWindow({});
    await refreshBriefing();
    assert.equal(getBriefingState().status, "unsupported");
    assert.equal(getBriefingState().report, null);

    installWindow(undefined);
    resetBriefingStore();
    await refreshBriefing();
    assert.equal(getBriefingState().status, "unsupported");
  });

  it("sends the paper book, and shares one request between callers", async () => {
    const gate = deferred<BriefingGetResult>();
    const seen: BriefingRequest[] = [];
    installWindow({
      getBriefing: (request) => {
        seen.push(request);
        return gate.promise;
      },
    });

    const notified: string[] = [];
    const off = subscribeBriefing(() => notified.push(getBriefingState().status));

    const first = refreshBriefing();
    const second = refreshBriefing();
    assert.equal(first, second);
    await settle();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { holdings: [{ symbol: "NVDA", shares: 10, cost_usd: 1500 }], cash: 2500, demo: false });
    assert.equal(getBriefingState().status, "loading");

    gate.resolve({ ok: true, report: liveReport(), source: "fresh" });
    await first;
    off();

    const state = getBriefingState();
    assert.equal(state.status, "ready");
    assert.equal(state.report?.facts_hash, "facts-1");
    assert.equal(state.refreshing, false);
    assert.equal(typeof state.fetchedAt, "number");
    assert.deepEqual(notified, ["loading", "ready"]);
  });

  it("asks once more when the book changed while a request was out", async () => {
    const gates = [deferred<BriefingGetResult>(), deferred<BriefingGetResult>()];
    const seen: BriefingRequest[] = [];
    installWindow({ getBriefing: (request) => gates[seen.push(request) - 1].promise });

    const first = refreshBriefing();
    await settle();
    installBook(900, { NVDA: { symbol: "NVDA", shares: 12, costUsd: 1800 } });
    void refreshBriefing();
    gates[0].resolve({ ok: true, report: liveReport("facts-1"), source: "fresh" });
    await first;
    await settle();

    assert.equal(seen.length, 2);
    assert.equal(seen[1].holdings[0].shares, 12);
    assert.equal(getBriefingState().refreshing, true);

    gates[1].resolve({ ok: true, report: liveReport("facts-2"), source: "fresh" });
    await settle();
    assert.equal(getBriefingState().report?.facts_hash, "facts-2");
    assert.equal(getBriefingState().refreshing, false);
  });

  it("keeps only a fixed code from a failure, whatever the main process said", async () => {
    installWindow({ getBriefing: () => Promise.reject(new Error("401 from provider: Bearer sk-live-abc")) });
    await refreshBriefing();
    assert.deepEqual(
      { status: getBriefingState().status, error: getBriefingState().error },
      { status: "error", error: "unavailable" },
    );
    assert.equal(JSON.stringify(getBriefingState()).includes("sk-live"), false);

    resetBriefingStore();
    installWindow({ getBriefing: async () => ({ ok: false, error: "key=abc123 rejected" as never }) });
    await refreshBriefing();
    assert.equal(getBriefingState().error, "unavailable");

    resetBriefingStore();
    installWindow({ getBriefing: async () => ({ ok: false, error: "build_failed" }) });
    await refreshBriefing();
    assert.equal(getBriefingState().error, "build_failed");

    resetBriefingStore();
    installWindow({ getBriefing: async () => ({ ok: true, report: { nonsense: true } as never, source: "cache" }) });
    await refreshBriefing();
    assert.deepEqual(
      { status: getBriefingState().status, error: getBriefingState().error },
      { status: "error", error: "build_failed" },
    );
  });

  it("keeps the report on screen when a later request fails", async () => {
    let fail = false;
    installWindow({
      getBriefing: async () => (fail ? { ok: false, error: "unavailable" } : { ok: true, report: liveReport(), source: "fresh" }),
    });
    await refreshBriefing();
    fail = true;
    await refreshBriefing();
    const state = getBriefingState();
    assert.equal(state.status, "ready");
    assert.equal(state.report?.facts_hash, "facts-1");
    assert.equal(state.error, "unavailable");
    assert.equal(state.refreshing, false);
  });

  it("splices the model narrative in, once per set of facts", async () => {
    const asked: string[] = [];
    installWindow({
      getBriefing: async () => ({ ok: true, report: liveReport("facts-1"), source: "fresh" }),
      getBriefingNarrative: async (request) => {
        asked.push(request.facts_hash);
        return {
          ok: true,
          narrative: {
            text: "Model text.",
            source: "model",
            model: "m",
            generated_at: "2026-09-22T11:17:00.000Z",
            facts_hash: request.facts_hash,
            pending: false,
            reason: null,
          },
          stories: [],
        };
      },
    });

    await refreshBriefing();
    await settle();
    assert.deepEqual(asked, ["facts-1"]);
    assert.equal(getBriefingState().report?.narrative.text, "Model text.");
    assert.equal(getBriefingState().report?.narrative.pending, false);

    // The next poll still carries the template for the same facts: the model
    // text stays, and nobody is asked again.
    await refreshBriefing();
    await settle();
    assert.deepEqual(asked, ["facts-1"]);
    assert.equal(getBriefingState().report?.narrative.text, "Model text.");
  });

  it("splices the stories that ride along with the model narrative, and keeps them across the next poll", async () => {
    const story: Story = {
      id: "market:futures",
      scope: "market",
      at: "2026-09-22T10:42:00.000Z",
      what: "Futures are lower into the open.",
      reaction: "S&P 500 futures are down 0.4%.",
      reactions: [{ label: "S&P fut", symbol: "ES=F", move: -0.4, unit: "pct" }],
      meaning: null,
      tickers: [],
      evidence: ["hl-1"],
      source: "model",
    };
    installWindow({
      getBriefing: async () => ({ ok: true, report: liveReport("facts-1"), source: "fresh" }),
      getBriefingNarrative: async (request) => ({
        ok: true,
        narrative: { text: "Model text.", source: "model", model: "m", generated_at: "x", facts_hash: request.facts_hash, pending: false, reason: null },
        stories: [story],
      }),
    });

    await refreshBriefing();
    await settle();
    assert.deepEqual(getBriefingState().report?.stories, [story]);

    // The next poll carries the template again, and from this stub no
    // stories at all: the model's stay, as its narrative does.
    await refreshBriefing();
    await settle();
    assert.equal(getBriefingState().report?.narrative.text, "Model text.");
    assert.deepEqual(getBriefingState().report?.stories, [story]);
  });

  it("drops a narrative written for facts that are no longer on screen", async () => {
    const gate = deferred<BriefingNarrativeResult>();
    let hash = "facts-1";
    installWindow({
      getBriefing: async () => ({ ok: true, report: liveReport(hash), source: "fresh" }),
      getBriefingNarrative: (request) => (request.facts_hash === "facts-1" ? gate.promise : new Promise(() => undefined)),
    });

    await refreshBriefing();
    hash = "facts-2";
    await refreshBriefing();
    gate.resolve({
      ok: true,
      narrative: { text: "About the old figures.", source: "model", model: "m", generated_at: "x", facts_hash: "facts-1", pending: false, reason: null },
      stories: [],
    });
    await settle();
    assert.equal(getBriefingState().report?.facts_hash, "facts-2");
    assert.equal(getBriefingState().report?.narrative.text, "Template text.");
  });

  it("asks for the narrative again on a later report when the first call failed", async () => {
    let calls = 0;
    installWindow({
      getBriefing: async () => ({ ok: true, report: liveReport(), source: "fresh" }),
      getBriefingNarrative: async () => {
        calls += 1;
        return { ok: false, error: "not_found" };
      },
    });
    await refreshBriefing();
    await settle();
    await refreshBriefing();
    await settle();
    assert.equal(calls, 2);
    assert.equal(getBriefingState().report?.narrative.text, "Template text.");
  });

  it("throttles the manual refresh and marks it as one that skips the cache", async () => {
    const seen: BriefingRequest[] = [];
    installWindow({
      getBriefing: async (request) => {
        seen.push(request);
        return { ok: true, report: liveReport(), source: "fresh" };
      },
    });
    assert.equal(manualRefreshAvailableAt(), 0);

    const before = Date.now();
    await refreshBriefing({ force: true });
    await refreshBriefing({ force: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].force, true);
    assert.ok(manualRefreshAvailableAt() >= before + MANUAL_REFRESH_THROTTLE_MS);

    // The throttle is on the button, not on the store: a plain request still goes.
    await refreshBriefing();
    assert.equal(seen.length, 2);
    assert.equal(seen[1].force, undefined);
  });

  it("builds a demo report locally and never calls the main process", async () => {
    let calls = 0;
    installWindow({
      getBriefing: async () => {
        calls += 1;
        return { ok: true, report: liveReport(), source: "fresh" };
      },
    });
    toggleDemoMode();
    await refreshBriefing();
    const state = getBriefingState();
    assert.equal(calls, 0);
    assert.equal(state.status, "ready");
    assert.equal(state.report?.demo, true);
    assert.ok((state.report?.held_coverage.length ?? 0) > 0);

    // Same seed, same report: the card and the panel can both ask.
    const first = JSON.stringify(state.report?.overnight);
    await refreshBriefing();
    assert.equal(JSON.stringify(getBriefingState().report?.overnight), first);
  });

  it("fetches on the first hold, swaps reports with the demo toggle, and stops when released", async () => {
    let calls = 0;
    installWindow({
      getBriefing: async () => {
        calls += 1;
        return { ok: true, report: liveReport(), source: "fresh" };
      },
    });

    const release = retainBriefing();
    const releaseSecond = retainBriefing();
    await settle();
    assert.equal(calls, 1);
    assert.equal(getBriefingState().report?.demo, false);

    toggleDemoMode();
    assert.equal(getBriefingState().report?.demo, true);
    assert.equal(calls, 1);

    toggleDemoMode();
    assert.equal(getBriefingState().status, "loading");
    await settle();
    assert.equal(calls, 2);
    assert.equal(getBriefingState().report?.demo, false);

    releaseSecond();
    releaseSecond();
    release();

    // With nobody holding the store the toggle is no longer heard, and no
    // timer is left behind to keep the process alive.
    toggleDemoMode();
    assert.equal(getBriefingState().report?.demo, false);
    toggleDemoMode();
  });

  it("drops a reply that lands after the mode changed", async () => {
    const gate = deferred<BriefingGetResult>();
    installWindow({ getBriefing: () => gate.promise });
    const release = retainBriefing();
    await settle();
    assert.equal(getBriefingState().status, "loading");

    toggleDemoMode();
    gate.resolve({ ok: true, report: liveReport(), source: "fresh" });
    await settle();
    assert.equal(getBriefingState().report?.demo, true);
    release();
  });
});
