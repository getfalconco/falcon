import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { BriefingNarrative, BriefingPorts, BriefingRequest } from "../../shared/briefing-types";
import { createBriefingBuilder, resolveClock, type BriefingClock } from "./briefing-build";
import { BriefingStore, MAX_GENERATIONS_PER_SESSION } from "./briefing-store";

const MINUTE = 60_000;
/** Monday 07:00 ET: inside the pre-open window of the 2026-09-21 session. */
const PRE_OPEN = new Date("2026-09-21T11:00:00.000Z");
/** Sunday 19:45 ET: the window for that same session opens in fifteen minutes. */
const BEFORE_WINDOW = new Date("2026-09-20T23:45:00.000Z");

const REQUEST: BriefingRequest = {
  holdings: [
    { symbol: "AAPL", shares: 10, cost_usd: 3000 },
    { symbol: "NVDA", shares: 5, cost_usd: 2500 },
  ],
  cash: 1000,
};

let dir = "";
let store: BriefingStore;
let clock: BriefingClock;
let realNow = 0;
let user = "user-1";
let configured = true;
let portCalls = 0;
let failChain = false;

const ports: BriefingPorts = {
  async marketSnapshot(symbol) {
    portCalls += 1;
    return { symbol, price: 101, previous_close: 100, market_time: "2026-09-21T10:55:00.000Z", in_regular_session: false };
  },
  async heldQuote(symbol) {
    return { symbol, price: 102, regular_price: 100, previous_close: 99, session: "pre", as_of: "2026-09-21T10:59:00.000Z" };
  },
  async quant() {
    return { daily_vol_30d: 2, beta: 1.1 };
  },
  async chainSlice(ticker) {
    if (failChain) throw new Error("not signed in yet");
    return { ticker, coverage: "tracked", news: [], filings: [], measurements: [], scheduled_earnings: [] };
  },
  async riskLatest() {
    return null;
  },
  async corporateCalendar(symbol) {
    return {
      symbol,
      available: true,
      ex_dividend_date: null,
      dividend_date: null,
      dividend_rate: null,
      earnings_dates: [],
      earnings_estimated: null,
      recent_dividends: [],
      recent_splits: [],
    };
  },
  async marketNews() {
    return [];
  },
};

function builder() {
  return createBriefingBuilder({
    store,
    ports: () => ports,
    clock: () => clock,
    realNowMs: () => realNow,
    userKey: () => user,
    modelConfigured: () => configured,
  });
}

function reportFiles(sub = ""): string[] {
  try {
    return fs.readdirSync(path.join(dir, sub)).filter((name) => name.startsWith("report."));
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-briefing-build-"));
  store = new BriefingStore(dir);
  clock = { now: PRE_OPEN, synthetic: false };
  realNow = PRE_OPEN.getTime();
  user = "user-1";
  configured = true;
  portCalls = 0;
  failChain = false;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveClock", () => {
  const real = new Date("2026-09-21T18:00:00.000Z");

  it("uses a pinned clock in a dev build and marks it", () => {
    assert.deepEqual(resolveClock(" 2026-07-03T12:00:00Z ", false, real), { now: new Date("2026-07-03T12:00:00.000Z"), synthetic: true });
  });

  it("never reads the pin in a packaged build", () => {
    assert.deepEqual(resolveClock("2026-07-03T12:00:00Z", true, real), { now: real, synthetic: false });
  });

  it("falls back to the machine's clock when the pin is absent or unreadable", () => {
    for (const pin of [undefined, "", "   ", "next tuesday"]) {
      assert.deepEqual(resolveClock(pin, false, real), { now: real, synthetic: false });
    }
  });
});

describe("briefing builder", () => {
  it("builds once, stores the report, and serves the reopening from disk", async () => {
    const b = builder();
    const first = await b.build(REQUEST);
    assert.equal(first.source, "fresh");
    assert.equal(first.report.window.target_session_ymd, "2026-09-21");
    assert.equal(first.report.book.position_count, 2);
    assert.equal(reportFiles().length, 1);

    const calls = portCalls;
    realNow += 9 * MINUTE;
    const second = await b.build({ ...REQUEST, holdings: [...REQUEST.holdings].reverse() });
    assert.equal(second.source, "cache");
    assert.equal(portCalls, calls);
    assert.equal(second.report.generated_at, first.report.generated_at);
  });

  it("rebuilds when the stored report has outlived its ten pre-open minutes", async () => {
    const b = builder();
    await b.build(REQUEST);
    realNow += 10 * MINUTE;
    assert.equal((await b.build(REQUEST)).source, "fresh");
  });

  it("holds a report with a failed chain section for one minute only", async () => {
    failChain = true;
    const b = builder();
    const first = await b.build(REQUEST);
    assert.ok(first.report.degraded.some((d) => d.section === "chain_news"));
    realNow += MINUTE;
    failChain = false;
    const second = await b.build(REQUEST);
    assert.equal(second.source, "fresh");
    assert.equal(second.report.degraded.some((d) => d.section === "chain_news"), false);
  });

  it("skips the cache on a manual refresh, and refreshes what is stored", async () => {
    const b = builder();
    await b.build(REQUEST);
    clock = { now: new Date(PRE_OPEN.getTime() + MINUTE), synthetic: false };
    realNow += MINUTE;
    const forced = await b.build({ ...REQUEST, force: true });
    assert.equal(forced.source, "fresh");
    assert.equal(store.readReport({ userKey: "user-1", targetYmd: "2026-09-21", bookHash: fileHash(), synthetic: false })?.report.generated_at, forced.report.generated_at);
  });

  it("does not serve a report stored in another phase of the same session", async () => {
    clock = { now: BEFORE_WINDOW, synthetic: false };
    realNow = BEFORE_WINDOW.getTime();
    const b = builder();
    const early = await b.build(REQUEST);
    assert.equal(early.report.window.phase, "between_sessions");
    assert.equal(early.report.window.target_session_ymd, "2026-09-21");

    // Twenty minutes on, the stored report is still inside its thirty, but
    // the window has opened in between: only the phase rule forces a rebuild.
    clock = { now: new Date(BEFORE_WINDOW.getTime() + 20 * MINUTE), synthetic: false };
    realNow += 20 * MINUTE;
    const later = await b.build(REQUEST);
    assert.equal(later.report.window.phase, "pre_open");
    assert.equal(later.source, "fresh");
  });

  it("shares one build between callers that arrive together", async () => {
    const b = builder();
    const [a, c] = await Promise.all([b.build(REQUEST), b.build(REQUEST)]);
    assert.equal(a.report, c.report);
    // Seventeen market rows, read once.
    assert.equal(portCalls, 17);
  });

  it("keeps each user's and each book's report apart", async () => {
    const b = builder();
    await b.build(REQUEST);
    user = "user-2";
    assert.equal((await b.build(REQUEST)).source, "fresh");
    assert.equal((await b.build({ ...REQUEST, holdings: [REQUEST.holdings[0]!] })).source, "fresh");
    assert.equal(reportFiles().length, 3);
  });

  it("rebuilds when the cash moved and the positions stood still", async () => {
    // What onboarding does: the card asks once with an empty account, then the
    // reader sets a starting balance, which writes cash and no position. Every
    // figure in the report is measured against the book's equity, so the
    // stored one must not answer for the funded book.
    const b = builder();
    const empty = await b.build({ holdings: [], cash: 0 });
    assert.equal(empty.report.book.cash_usd, 0);

    realNow += MINUTE;
    const funded = await b.build({ holdings: [], cash: 100_000 });
    assert.equal(funded.source, "fresh");
    assert.equal(funded.report.book.cash_usd, 100_000);
    assert.equal(funded.report.book.equity_usd, 100_000);
    assert.equal(reportFiles().length, 2);

    // And the funded book's own report still answers its reopening.
    realNow += MINUTE;
    assert.equal((await b.build({ holdings: [], cash: 100_000 })).source, "cache");
  });

  it("serves one report for a cash difference of less than a dollar", async () => {
    const b = builder();
    await b.build({ ...REQUEST, cash: 1000.004 });
    realNow += MINUTE;
    // Cash carries float residue after a fill; residue is not a new book.
    assert.equal((await b.build({ ...REQUEST, cash: 999.996 })).source, "cache");
  });

  it("never stores a demo book and never promises it a model narrative", async () => {
    const b = builder();
    const demo = await b.build({ ...REQUEST, demo: true });
    assert.equal(demo.report.demo, true);
    assert.equal(demo.report.narrative.pending, false);
    assert.equal((await b.build({ ...REQUEST, demo: true })).source, "fresh");
    assert.deepEqual(reportFiles(), []);

    // And a stored real report of the same book is not handed to the demo.
    await b.build(REQUEST);
    assert.equal((await b.build({ ...REQUEST, demo: true })).report.demo, true);
  });

  it("files a developer-clock report under _dev and promises it no model narrative", async () => {
    clock = { now: PRE_OPEN, synthetic: true };
    const b = builder();
    const built = await b.build(REQUEST);
    assert.equal(built.report.synthetic_now, true);
    assert.equal(built.report.narrative.pending, false);
    assert.deepEqual(reportFiles(), []);
    assert.equal(reportFiles("_dev").length, 1);
    assert.equal((await b.build(REQUEST)).source, "cache");
  });

  describe("narrative", () => {
    it("says a model version is pending only when one can be written", async () => {
      assert.equal((await builder().build(REQUEST)).report.narrative.pending, true);

      configured = false;
      assert.equal((await builder().build({ ...REQUEST, force: true })).report.narrative.pending, false);

      configured = true;
      for (let i = 0; i < MAX_GENERATIONS_PER_SESSION; i++) store.noteGeneration("user-1", "2026-09-21", realNow - 60 * MINUTE);
      assert.equal((await builder().build({ ...REQUEST, force: true })).report.narrative.pending, false);
    });

    it("splices in a model narrative written earlier for the same facts, fresh or cached", async () => {
      const b = builder();
      const first = await b.build(REQUEST);
      const model: BriefingNarrative = {
        text: "Futures were little changed. Nothing is scheduled for this session.",
        source: "model",
        model: "claude-test",
        generated_at: "2026-09-21T11:01:00.000Z",
        facts_hash: first.report.facts_hash,
        pending: false,
        reason: null,
      };
      store.putNarrative("user-1", "2026-09-21", first.report.facts_hash, model, realNow);

      const cached = await b.build(REQUEST);
      assert.equal(cached.source, "cache");
      assert.equal(cached.report.narrative.source, "model");
      assert.equal(cached.report.narrative.pending, false);

      const fresh = await b.build({ ...REQUEST, force: true });
      assert.equal(fresh.report.facts_hash, first.report.facts_hash);
      assert.equal(fresh.report.narrative.text, model.text);

      user = "user-2";
      assert.equal((await b.build(REQUEST)).report.narrative.source, "template");
    });
  });
});

/** The stored file's hash part, read back off the one file the test wrote. */
function fileHash(): string {
  const name = reportFiles()[0] ?? "";
  return name.split(".")[3] ?? "";
}
