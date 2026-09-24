import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type {
  BriefingReport,
  CalendarItem,
  CorporateEvent,
  HeldMover,
  HeldNewsItem,
  Implication,
  MarketRow,
  Story,
  StoryReaction,
  StoryScope,
} from "./briefing-types";
import {
  MASKED_USD,
  MONTH_ABBR,
  NOT_AVAILABLE,
  RISK_UNAVAILABLE_NOTE,
  TIMES_NOTE,
  bookView,
  calendarView,
  cardSummary,
  corporateRows,
  degradedNotes,
  effectivePhase,
  formatCountdown,
  heldRows,
  implicationsView,
  marketGroups,
  maskDollarAmounts,
  mastheadDate,
  narrativeView,
  phaseChip,
  phaseTitle,
  sinceLine,
  spokenImplicationIds,
  storiesView,
  titleLine,
  viewNow,
} from "./briefing-view";

const MINUS = String.fromCharCode(0x2212);

// Monday 2026-09-21, New York on daylight time (UTC-4): the window opens Sunday
// 20:00 ET, the session runs 09:30 to 16:00 ET.
const at = (iso: string) => new Date(iso);
const OPEN = "2026-09-21T13:30:00.000Z";
const CLOSE = "2026-09-21T20:00:00.000Z";
const MORNING = at("2026-09-21T11:16:00.000Z"); // 07:16 ET

function market(overrides: Partial<MarketRow> & Pick<MarketRow, "symbol" | "group">): MarketRow {
  return {
    label: overrides.symbol,
    last: 100,
    prev_close: 99,
    move: 1.01,
    unit: "pct",
    basis: "prev_close",
    state: "final",
    as_of: "2026-09-21T06:00:00.000Z",
    ...overrides,
  };
}

function mover(ticker: string, overrides: Partial<HeldMover> = {}): HeldMover {
  return {
    ticker,
    last: 101,
    ref_close: 100,
    move_pct: 0.2,
    move_z: 0.1,
    pnl_usd: 20,
    basis: "since_close",
    session: "pre",
    as_of: "2026-09-21T11:00:00.000Z",
    flag: null,
    beta: null,
    daily_vol_pct: null,
    ...overrides,
  };
}

function news(ticker: string, overrides: Partial<HeldNewsItem> = {}): HeldNewsItem {
  return {
    ticker,
    also: [],
    headline: `${ticker} supplier reports a fire at its main plant`,
    source: "Newswire",
    url: `https://example.test/${ticker}`,
    published_at: "2026-09-21T10:05:00.000Z",
    band: "P2",
    tags: [],
    incident_id: `inc-${ticker}`,
    ...overrides,
  };
}

function calendarItem(id: string, overrides: Partial<CalendarItem> = {}): CalendarItem {
  return { id, kind: "data", time_et: null, at: null, title: id, detail: null, importance: 2, tickers: [], source: "bls", ...overrides };
}

function corporate(id: string, overrides: Partial<CorporateEvent> = {}): CorporateEvent {
  return {
    id,
    kind: "dividend",
    date: "2026-09-24",
    sessions_until: 3,
    ticker: "MSFT",
    index: null,
    title: "MSFT ex-dividend",
    detail: "0.83 per share",
    affects_held: ["MSFT"],
    certainty: "confirmed",
    source: "yahoo_calendar",
    ...overrides,
  };
}

function implication(id: string, overrides: Partial<Implication> = {}): Implication {
  return {
    id,
    kind: "open_indication",
    headline: "Futures point to a book about 0.5% higher at the open.",
    because: "S&P 500 futures are up 0.42% and the book's beta is 1.2.",
    scenario: "A 1% index move either way is about 1.2% of the book.",
    scenario_usd: 1498.4,
    book_pct: 1.2,
    tickers: [],
    ...overrides,
  };
}

/** Listed in the engine's order, which is NOT the order of `book_pct`: the view must not sort them again. */
const IMPLICATIONS: Implication[] = [
  implication("open_indication:book"),
  implication("name_specific:NVDA", {
    kind: "name_specific",
    headline: "NVDA moved well beyond what the market explains.",
    because: "It is down 3.4% against 0.6% for its beta, a 2.1 sigma day.",
    scenario: null,
    scenario_usd: null,
    book_pct: 0.9,
    tickers: ["NVDA"],
  }),
  implication("earnings_exposure:AAPL", {
    kind: "earnings_exposure",
    headline: "AAPL reports after the close, and it is 18% of the book.",
    because: "Its own daily volatility is 1.6%.",
    scenario: "A 5% move in AAPL either way is about 0.9% of the book.",
    scenario_usd: 1130,
    book_pct: 18,
    tickers: ["AAPL", "AAPL"],
  }),
];

/** Every scope, an instant on the session day, one from the Saturday before, and one that is the session itself. */
const STORIES: Story[] = [
  {
    id: "market:futures",
    scope: "market",
    at: "2026-09-21T10:42:00.000Z",
    what: "US equity futures are lower into the open; the overnight headline names renewed Middle East tensions.",
    reaction: "S&P 500 futures are down 0.42% against the prior settle and the 10-year yield is up 6 bp.",
    reactions: [
      { label: "S&P fut", symbol: "ES=F", move: 0.42, unit: "pct" },
      { label: "10y", symbol: "^TNX", move: 6, unit: "bp" },
      { label: "VIX", symbol: "^VIX", move: 1.2, unit: "pts" },
      { label: "Nikkei", symbol: "^N225", move: null, unit: "pct" },
    ],
    meaning: "Futures point to a book about 0.5% higher at the open, which is $1,498 of it.",
    tickers: [],
    evidence: ["hl-1", "open_indication:book"],
    source: "template",
  },
  {
    id: "name:NVDA",
    scope: "name",
    at: "2026-09-19T10:42:00.000Z",
    what: "A supplier reported a fire at its main plant, and NVDA carried the headline through the weekend.",
    reaction: "NVDA is down 3.4% in the pre-market, 2.1 of its daily volatility.",
    reactions: [{ label: "NVDA", symbol: "NVDA", move: -3.4, unit: "pct" }],
    meaning: null,
    tickers: ["NVDA", "NVDA"],
    evidence: ["inc-NVDA", "name_specific:NVDA"],
    source: "model",
  },
  {
    id: "release:session",
    scope: "release",
    at: null,
    what: "The Bank of Japan left its policy rate unchanged at this morning's meeting.",
    reaction: "",
    reactions: [],
    meaning: null,
    tickers: [],
    evidence: [],
    source: "template",
  },
];

function makeReport(overrides: Partial<BriefingReport> = {}): BriefingReport {
  return {
    schema_version: 3,
    generated_at: "2026-09-21T11:00:00.000Z",
    demo: false,
    synthetic_now: false,
    window: {
      target_session_ymd: "2026-09-21",
      prev_session_ymd: "2026-09-18",
      overnight_since: "2026-09-18T20:00:00.000Z",
      window_opens_at: "2026-09-21T00:00:00.000Z",
      target_open_at: OPEN,
      target_close_at: CLOSE,
      phase: "pre_open",
      auto_show: true,
      handover: "weekend",
      early_close: false,
    },
    overnight: { markets: [], held_movers: [], held_news: [], filings: [], measurements: [] },
    held_coverage: [],
    book: {
      position_count: 0,
      equity_usd: 0,
      cash_usd: 0,
      invested_usd: 0,
      net_exposure_pct: 0,
      gross_exposure_pct: 0,
      overnight_pnl_usd: null,
      overnight_pnl_pct: null,
      top_weights: [],
      unpriced: [],
      priced_at: "2026-09-21T11:00:00.000Z",
    },
    risk: null,
    earnings_next: [],
    corporate_events: [],
    corporate_coverage: { dividends: "", splits: "", unknown_symbols: [] },
    calendar_today: [],
    calendar_coverage: { from: "2026-01-01", until: "2026-10-31", compiled_at: "2026-09-01T00:00:00.000Z", covers_target: true, days_left: 40 },
    headlines: [],
    stories: [],
    implications: [],
    narrative: {
      text: "",
      source: "template",
      model: null,
      generated_at: "2026-09-21T11:00:00.000Z",
      facts_hash: "h",
      pending: false,
      reason: null,
    },
    facts_hash: "h",
    degraded: [],
    ...overrides,
  };
}

const MARKETS: MarketRow[] = [
  market({ symbol: "^TNX", label: "US 10-year yield", group: "macro", unit: "bp", last: 4.31, prev_close: 4.25, move: 6 }),
  market({ symbol: "^VIX", label: "VIX", group: "macro", unit: "pts", last: 17.4, prev_close: 16.2, move: 1.2 }),
  market({ symbol: "ES=F", label: "S&P 500 futures", group: "us_futures", basis: "prior_settle", state: "live", last: 6712.25, move: 0.42 }),
  market({ symbol: "NQ=F", label: "Nasdaq-100 futures", group: "us_futures", basis: "prior_settle", state: "live", move: -0.31 }),
  market({ symbol: "^GDAXI", label: "DAX", group: "europe", state: "live", move: 0.004 }),
  market({ symbol: "^STOXX50E", label: "Euro Stoxx 50", group: "europe", state: "live", move: 0.18 }),
  market({ symbol: "^N225", label: "Nikkei 225", group: "asia", state: "stale", last: 38412.1, move: null, as_of: "2026-09-18T06:00:00.000Z" }),
  market({ symbol: "^HSI", label: "Hang Seng", group: "asia", state: "unavailable", last: null, prev_close: null, move: null, as_of: null }),
  market({ symbol: "^AXJO", label: "ASX 200", group: "asia", move: -1.2 }),
];

describe("phase, flipped locally", () => {
  const report = makeReport();

  it("turns to in-session at the open and to between-sessions at the close, with the report unchanged", () => {
    assert.equal(effectivePhase(report, at("2026-09-21T13:29:59.999Z")), "pre_open");
    assert.equal(effectivePhase(report, at(OPEN)), "in_session");
    assert.equal(effectivePhase(report, at("2026-09-21T19:59:59.999Z")), "in_session");
    assert.equal(effectivePhase(report, at(CLOSE)), "between_sessions");
    assert.equal(report.window.phase, "pre_open");
  });

  it("is between sessions before the window opens, and pre-open once it has", () => {
    const early = makeReport({ window: { ...report.window, phase: "between_sessions", auto_show: false } });
    assert.equal(effectivePhase(early, at("2026-09-20T18:00:00.000Z")), "between_sessions");
    assert.equal(effectivePhase(early, at("2026-09-21T00:00:00.000Z")), "pre_open");
  });

  it("keeps the report's word when a bound or the clock cannot be read", () => {
    const broken = makeReport({ window: { ...report.window, target_open_at: "soon", phase: "in_session" } });
    assert.equal(effectivePhase(broken, MORNING), "in_session");
    assert.equal(effectivePhase(report, at("not a date")), "pre_open");
    assert.deepEqual(phaseChip(makeReport({ window: { ...report.window, target_open_at: "soon" } }), MORNING), {
      tone: "pre",
      label: "Pre-market",
      detail: "before the open",
    });
  });

  it("trusts a report that already said pre-open over a local clock that lags the window", () => {
    assert.equal(effectivePhase(report, at("2026-09-20T23:50:00.000Z")), "pre_open");
  });

  it("labels each phase", () => {
    assert.deepEqual(phaseChip(report, MORNING), { tone: "pre", label: "Pre-market", detail: "opens in 2h 14m" });
    assert.deepEqual(phaseChip(report, at("2026-09-21T16:58:00.000Z")), { tone: "open", label: "Market open", detail: "closes in 3h 02m" });
    assert.deepEqual(phaseChip(report, at("2026-09-21T21:00:00.000Z")), { tone: "closed", label: "Closed", detail: "Mon Sep 21 session ended" });
  });

  it("names the coming session while it is still ahead, and says when a close is early", () => {
    const w = report.window;
    const nextWeek = makeReport({
      window: {
        ...w,
        target_session_ymd: "2026-09-28",
        window_opens_at: "2026-09-28T00:00:00.000Z",
        target_open_at: "2026-09-28T13:30:00.000Z",
        target_close_at: "2026-09-28T20:00:00.000Z",
        phase: "between_sessions",
      },
    });
    assert.equal(phaseChip(nextWeek, at("2026-09-26T15:00:00.000Z")).detail, "next session Mon Sep 28");
    const early = makeReport({ window: { ...w, early_close: true, target_close_at: "2026-09-21T17:00:00.000Z" } });
    assert.equal(phaseChip(early, at("2026-09-21T16:15:00.000Z")).detail, "closes early in 45m");
  });
});

describe("countdown", () => {
  it("formats minutes, hours and days", () => {
    assert.equal(formatCountdown(14 * 60_000), "14m");
    assert.equal(formatCountdown(60 * 60_000), "1h 00m");
    assert.equal(formatCountdown(2 * 3_600_000 + 14 * 60_000 + 59_000), "2h 14m");
    assert.equal(formatCountdown(3 * 3_600_000 + 2 * 60_000), "3h 02m");
    assert.equal(formatCountdown(2 * 86_400_000 + 13 * 3_600_000 + 5 * 60_000), "2d 13h");
  });

  it("never prints zero minutes, a negative or NaN", () => {
    assert.equal(formatCountdown(59_999), "under 1m");
    assert.equal(formatCountdown(0), "under 1m");
    assert.equal(formatCountdown(-5000), "under 1m");
    assert.equal(formatCountdown(Number.NaN), "under 1m");
  });
});

describe("masthead and title", () => {
  it("formats the target session from its calendar date", () => {
    const report = makeReport();
    assert.equal(mastheadDate(report), "MON SEP 21");
    assert.equal(titleLine(report), "Handover for Monday, Sep 21");
    assert.equal(sinceLine(report), "Since the close on Fri Sep 18");
  });

  it("does not roll an impossible date forward, and shows an unreadable one as it came", () => {
    const w = makeReport().window;
    assert.equal(mastheadDate(makeReport({ window: { ...w, target_session_ymd: "2026-02-30" } })), "2026-02-30");
    assert.equal(titleLine(makeReport({ window: { ...w, target_session_ymd: "" } })), "Handover for ");
  });

  it("handles a January 1 target without slipping into the old year", () => {
    const w = makeReport().window;
    assert.equal(mastheadDate(makeReport({ window: { ...w, target_session_ymd: "2027-01-01" } })), "FRI JAN 1");
  });
});

describe("demo clock", () => {
  it("views a demo report from the moment it was generated, and a real one from the real clock", () => {
    const real = at("2026-11-03T18:00:00.000Z");
    const demo = makeReport({ demo: true });
    assert.equal(viewNow(demo, real).toISOString(), demo.generated_at);
    assert.equal(viewNow(makeReport(), real), real);
    assert.equal(phaseChip(demo, viewNow(demo, real)).label, "Pre-market");
  });
});

describe("narrative", () => {
  const text =
    "US futures point higher, with S&P 500 futures up 0.42%. U.S. Treasury yields rose 6.0 bp. The book is up $1,234.50 (+0.82%) since Friday. NVDA vs. AMD is the widest gap.";

  it("splits into sentences without cutting at initials, abbreviations or decimals", () => {
    const view = narrativeView(makeReport({ narrative: { ...makeReport().narrative, text, source: "model", pending: true } }), false);
    assert.deepEqual(view.sentences, [
      "US futures point higher, with S&P 500 futures up 0.42%.",
      "U.S. Treasury yields rose 6.0 bp.",
      "The book is up $1,234.50 (+0.82%) since Friday.",
      "NVDA vs. AMD is the widest gap.",
    ]);
    assert.equal(view.source, "model");
    assert.equal(view.pending, true);
  });

  it("masks dollar amounts as a backstop and leaves percentages alone", () => {
    const view = narrativeView(makeReport({ narrative: { ...makeReport().narrative, text } }), true);
    assert.equal(view.sentences[2], `The book is up ${MASKED_USD} (+0.82%) since Friday.`);
    assert.equal(view.sentences[0], "US futures point higher, with S&P 500 futures up 0.42%.");
  });

  it("masks the shapes a model writes money in, sign included", () => {
    assert.equal(maskDollarAmounts("down -$2,500 overnight"), `down ${MASKED_USD} overnight`);
    assert.equal(maskDollarAmounts(`a swing of ${MINUS}$310.20.`), `a swing of ${MASKED_USD}.`);
    assert.equal(maskDollarAmounts("equity of $1.2M and cash of $ 40k"), `equity of ${MASKED_USD} and cash of ${MASKED_USD}`);
    assert.equal(maskDollarAmounts("about 12,000 USD, or USD 12,000"), `about ${MASKED_USD}, or ${MASKED_USD}`);
    assert.equal(maskDollarAmounts("up 3.2% on 1.4x volume at 08:30"), "up 3.2% on 1.4x volume at 08:30");
    assert.equal(maskDollarAmounts("$5 before the bell"), `${MASKED_USD} before the bell`);
  });

  it("yields no sentences for an empty narrative", () => {
    assert.deepEqual(narrativeView(makeReport(), false), { sentences: [], source: "template", pending: false });
  });
});

describe("overnight markets", () => {
  const groups = marketGroups(makeReport({ overnight: { ...makeReport().overnight, markets: MARKETS } }));
  const row = (symbol: string) => groups.flatMap((g) => g.rows).find((r) => r.symbol === symbol)!;

  it("groups east to west whatever order the rows came in, and keeps row order inside a group", () => {
    assert.deepEqual(groups.map((g) => g.key), ["asia", "europe", "us_futures", "macro"]);
    assert.deepEqual(groups.map((g) => g.label), ["Asia", "Europe", "US futures", "Macro"]);
    assert.deepEqual(groups[0].rows.map((r) => r.symbol), ["^N225", "^HSI", "^AXJO"]);
    assert.deepEqual(groups[3].rows.map((r) => r.symbol), ["^TNX", "^VIX"]);
  });

  it("drops a group with no rows", () => {
    const only = marketGroups(makeReport({ overnight: { ...makeReport().overnight, markets: MARKETS.filter((m) => m.group === "europe") } }));
    assert.deepEqual(only.map((g) => g.key), ["europe"]);
  });

  it("formats each unit", () => {
    assert.deepEqual([row("ES=F").last, row("ES=F").move, row("ES=F").tone], ["6,712.25", "+0.42%", "up"]);
    assert.deepEqual([row("NQ=F").move, row("NQ=F").tone], [`${MINUS}0.31%`, "down"]);
    assert.deepEqual([row("^TNX").last, row("^TNX").move], ["4.31%", "+6.0 bp"]);
    assert.deepEqual([row("^VIX").last, row("^VIX").move], ["17.40", "+1.20"]);
  });

  it("shows a move that rounds to zero as flat and unsigned", () => {
    assert.deepEqual([row("^GDAXI").move, row("^GDAXI").tone], ["0.00%", "flat"]);
  });

  it("withholds a stale move and says which session the level is from", () => {
    const stale = row("^N225");
    assert.equal(stale.last, "38,412.10");
    assert.equal(stale.move, "");
    assert.equal(stale.tone, "none");
    assert.equal(stale.stateNote, "Closed, last session Fri Sep 18");
  });

  it("marks an unavailable row, and leaves fresh rows without a note", () => {
    const missing = row("^HSI");
    assert.deepEqual([missing.last, missing.move, missing.tone, missing.stateNote], [NOT_AVAILABLE, "", "none", "Unavailable"]);
    assert.equal(row("ES=F").stateNote, null);
    assert.equal(row("ES=F").state, "live");
  });

  it("copes with a stale row that has no timestamp", () => {
    const [g] = marketGroups(makeReport({ overnight: { ...makeReport().overnight, markets: [market({ symbol: "^N225", group: "asia", state: "stale", move: null, as_of: null })] } }));
    assert.equal(g.rows[0].stateNote, "Closed, no fresh print");
  });

  it("notes the settlement basis on the futures group only", () => {
    assert.equal(groups.find((g) => g.key === "us_futures")?.basisNote, "Measured from the prior settle");
    assert.equal(groups.find((g) => g.key === "asia")?.basisNote, null);
    assert.equal(row("ES=F").basis, "prior_settle");
    assert.equal(row("^VIX").basis, "prev_close");
  });
});

describe("held names", () => {
  const report = makeReport({
    overnight: {
      markets: [],
      held_movers: [
        mover("AAPL", { move_pct: 0.2, move_z: 0.1, pnl_usd: 40 }),
        mover("NVDA", { move_pct: -3.4, move_z: -2.1, pnl_usd: -812.4 }),
        mover("TSLA", { move_pct: 48, move_z: 9, pnl_usd: 5000, flag: "corporate_action_check" }),
        mover("MSFT", { move_pct: 0.6, move_z: 0.4, pnl_usd: 66 }),
        mover("KO", { move_pct: -0.1, move_z: -0.1, pnl_usd: -3 }),
        mover("NEWCO", { move_pct: 2.6, move_z: null, pnl_usd: 12, basis: "today" }),
      ],
      held_news: [
        news("MSFT", { band: "P3", published_at: "2026-09-21T09:00:00.000Z", headline: "MSFT third item" }),
        news("MSFT", { band: "P1", published_at: "2026-09-19T14:30:00.000Z", headline: "MSFT first item", also: ["NVDA"] }),
        news("MSFT", { band: "P3", published_at: "2026-09-21T10:30:00.000Z", headline: "MSFT second-tier, newest" }),
        news("MSFT", { band: "P3", published_at: "2026-09-08T10:30:00.000Z", headline: "MSFT oldest" }),
      ],
      filings: [{ ticker: "MSFT", kind: "filing", label: "8-K item 2.02", filed_at: "2026-09-18T20:30:00.000Z", url: "https://example.test/8k" }],
      measurements: [{ ticker: "SPY", type: "volume_anomaly", detail: "Volume 3.1x its 20-day average", at: "2026-09-18T21:00:00.000Z" }],
    },
    held_coverage: [
      { ticker: "AAPL", coverage: "tracked" },
      { ticker: "NEWCO", coverage: "pending" },
      { ticker: "SPY", coverage: "price_only" },
    ],
    book: { ...makeReport().book, top_weights: [{ ticker: "NVDA", weight: 0.412, side: "long" }], unpriced: ["SPY"] },
  });

  it("orders by what needs attention: a flagged print, then priority and size of move, then the quiet names", () => {
    const view = heldRows(report, { limit: 10, masked: false });
    assert.deepEqual(view.rows.map((r) => r.ticker), ["TSLA", "NVDA", "MSFT", "NEWCO", "SPY", "AAPL", "KO"]);
    assert.equal(view.quietCount, 0);
    assert.equal(view.hiddenCount, 0);
  });

  it("counts what fell below the limit, split by whether it had anything to say", () => {
    const three = heldRows(report, { limit: 3, masked: false });
    assert.deepEqual(three.rows.map((r) => r.ticker), ["TSLA", "NVDA", "MSFT"]);
    assert.equal(three.hiddenCount, 2);
    assert.equal(three.quietCount, 2);
    const none = heldRows(report, { limit: 0, masked: false });
    assert.deepEqual([none.rows.length, none.hiddenCount, none.quietCount], [0, 5, 2]);
  });

  it("formats a row", () => {
    const rows = heldRows(report, { limit: 10, masked: false }).rows;
    const nvda = rows.find((r) => r.ticker === "NVDA")!;
    assert.deepEqual(
      { move: nvda.move, tone: nvda.tone, z: nvda.z, pnl: nvda.pnl, weight: nvda.weight, basisNote: nvda.basisNote },
      { move: `${MINUS}3.40%`, tone: "down", z: `${MINUS}2.1σ`, pnl: `${MINUS}$812.40`, weight: "41.2%", basisNote: "since last close" },
    );
    const newco = rows.find((r) => r.ticker === "NEWCO")!;
    assert.deepEqual([newco.z, newco.coverageNote, newco.basisNote, newco.weight], [null, "No tracker coverage yet", "today", null]);
    const tsla = rows.find((r) => r.ticker === "TSLA")!;
    assert.equal(tsla.flagNote, "Check for a corporate action");
    assert.equal(rows.find((r) => r.ticker === "AAPL")!.flagNote, null);
  });

  it("gives an unpriced name a row that says so instead of a zero", () => {
    const spy = heldRows(report, { limit: 10, masked: false }).rows.find((r) => r.ticker === "SPY")!;
    assert.deepEqual([spy.move, spy.tone, spy.pnl, spy.coverageNote], [NOT_AVAILABLE, "none", NOT_AVAILABLE, "Prices and filings only"]);
    assert.deepEqual(spy.items.map((i) => [i.kind, i.label, i.time]), [["measure", "Volume anomaly", "Fri 17:00"]]);
  });

  it("lists a row's items by priority, newest first within one, and counts the overflow", () => {
    const msft = heldRows(report, { limit: 10, masked: false }).rows.find((r) => r.ticker === "MSFT")!;
    assert.deepEqual(msft.items.map((i) => i.text), ["MSFT first item", "8-K item 2.02", "MSFT second-tier, newest"]);
    assert.equal(msft.moreCount, 2);
    assert.deepEqual(msft.items.map((i) => i.time), ["Sat 10:30", "Fri 16:30", "06:30"]);
    assert.deepEqual([msft.items[0].band, msft.items[0].also, msft.items[0].url], ["P1", ["NVDA"], "https://example.test/MSFT"]);
    assert.equal(msft.items[1].label, "Filing");
    assert.equal(msft.items[1].band, undefined);
  });

  it("dates an item older than a week", () => {
    const only = makeReport({ overnight: { ...makeReport().overnight, held_news: [news("MSFT", { published_at: "2026-09-08T10:30:00.000Z" })] } });
    assert.equal(heldRows(only, { limit: 5, masked: false }).rows[0].items[0].time, "Sep 8 06:30");
  });

  it("masks every dollar figure and nothing else", () => {
    const rows = heldRows(report, { limit: 10, masked: true }).rows;
    for (const r of rows.filter((x) => x.ticker !== "SPY")) assert.equal(r.pnl, MASKED_USD, r.ticker);
    const nvda = rows.find((r) => r.ticker === "NVDA")!;
    assert.deepEqual([nvda.move, nvda.z, nvda.weight], [`${MINUS}3.40%`, `${MINUS}2.1σ`, "41.2%"]);
    assert.doesNotMatch(JSON.stringify(rows), /\$\d/);
  });
});

describe("book and risk", () => {
  const book = {
    position_count: 5,
    equity_usd: 152340.5,
    cash_usd: 12000,
    invested_usd: 140340.5,
    net_exposure_pct: 82.44,
    gross_exposure_pct: 96.02,
    overnight_pnl_usd: -1234.56,
    overnight_pnl_pct: -0.81,
    top_weights: [
      { ticker: "NVDA", weight: 0.4, side: "long" as const },
      { ticker: "MSFT", weight: 0.3, side: "long" as const },
      { ticker: "TSLA", weight: -0.1, side: "short" as const },
    ],
    unpriced: ["XYZ"],
    priced_at: "2026-09-21T11:00:00.000Z",
  };
  const risk = {
    score: 63.4,
    band: "elevated",
    driver_component: "network",
    driver_sentence: "NVDA and TSM share a critical supply-chain link worth $4,000 of the book.",
    beta_eff: 1.18,
    beta_port: 1.31,
    port_vol_daily_pct: 1.62,
    computed_at: "2026-09-21T10:59:00.000Z",
    matches_book: true,
  };
  const report = makeReport({ book, risk });

  it("builds the four tiles", () => {
    const tiles = bookView(report, false).tiles;
    assert.deepEqual(tiles.map((t) => t.key), ["equity", "since_close", "net_exposure", "positions"]);
    assert.deepEqual(tiles.map((t) => t.label), ["Equity", "Since last close", "Net exposure", "Positions"]);
    assert.deepEqual(tiles.map((t) => t.value), ["$152,340.50", `${MINUS}$1,234.56`, "82.4%", "5"]);
    assert.deepEqual(tiles.map((t) => t.sub), ["Cash $12,000.00", `${MINUS}0.81%`, "Gross 96.0%", "1 without a price"]);
    assert.equal(tiles[1].tone, "down");
  });

  it("masks dollars and leaves percentages and counts visible", () => {
    const view = bookView(report, true);
    assert.deepEqual(view.tiles.map((t) => t.value), [MASKED_USD, MASKED_USD, "82.4%", "5"]);
    assert.deepEqual(view.tiles.map((t) => t.sub), [`Cash ${MASKED_USD}`, `${MINUS}0.81%`, "Gross 96.0%", "1 without a price"]);
    assert.equal(view.risk?.sentence, `NVDA and TSM share a critical supply-chain link worth ${MASKED_USD} of the book.`);
    assert.doesNotMatch(JSON.stringify(view), /\$\d/);
  });

  it("says n/a for an overnight figure that does not exist", () => {
    const view = bookView(makeReport({ book: { ...book, overnight_pnl_usd: null, overnight_pnl_pct: null } }), false);
    assert.deepEqual([view.tiles[1].value, view.tiles[1].sub, view.tiles[1].tone], [NOT_AVAILABLE, null, "none"]);
  });

  it("draws the weights bar to a whole, with one segment for the rest of the book", () => {
    const segments = bookView(report, false).weights;
    assert.deepEqual(segments.map((s) => s.label), ["NVDA", "MSFT", "TSLA", "Rest of book"]);
    assert.deepEqual(segments.map((s) => s.weight), ["40.0%", "30.0%", "10.0%", "20.0%"]);
    assert.deepEqual(segments.map((s) => s.sideNote), [null, null, "borrowed", null]);
    assert.ok(Math.abs(segments.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
    const whole = bookView(makeReport({ book: { ...book, position_count: 3 } }), false).weights;
    assert.deepEqual(whole.map((s) => s.label), ["NVDA", "MSFT", "TSLA"]);
    assert.ok(Math.abs(whole.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
    assert.deepEqual(bookView(makeReport(), false).weights, []);
  });

  it("shows the risk block when the snapshot describes this book", () => {
    const view = bookView(report, false);
    assert.equal(view.riskNote, null);
    assert.deepEqual(view.risk, {
      score: "63",
      band: "Elevated",
      sentence: risk.driver_sentence,
      stats: [
        { label: "Portfolio beta", value: "1.31" },
        { label: "Effective beta", value: "1.18" },
        { label: "Daily volatility", value: "1.62%" },
      ],
    });
  });

  it("hides the risk block when the snapshot belongs to another book, is missing, or has no score", () => {
    for (const r of [{ ...risk, matches_book: false }, null, { ...risk, score: null }]) {
      const view = bookView(makeReport({ book, risk: r }), false);
      assert.equal(view.risk, null);
      assert.equal(view.riskNote, RISK_UNAVAILABLE_NOTE);
      assert.equal(view.riskNote, "Risk figures are not available for this book.");
    }
  });

  it("labels a band it has no entry for rather than dropping it", () => {
    assert.equal(bookView(makeReport({ book, risk: { ...risk, band: "severe" } }), false).risk?.band, "Severe");
  });

  it("names the unpriced holdings", () => {
    assert.equal(bookView(report, false).unpricedNote, "No price found for XYZ.");
    assert.equal(bookView(makeReport(), false).unpricedNote, null);
  });
});

describe("corporate events", () => {
  const report = makeReport({
    corporate_events: [
      corporate("reb", {
        kind: "rebalance",
        date: "2026-09-25",
        sessions_until: 4,
        ticker: null,
        index: "sp",
        title: "S&P quarterly rebalance takes effect",
        detail: "After the close",
        affects_held: ["SPY", "VOO", "SPY"],
        certainty: "rule",
        source: "rule",
      }),
      corporate("div"),
      corporate("earn", { kind: "earnings", date: "2026-09-22", sessions_until: 1, ticker: "KO", title: "KO earnings", affects_held: ["KO"], certainty: "estimated" }),
      corporate("split", { kind: "split", date: "2026-09-21", sessions_until: 0, ticker: "NVDA", title: "NVDA 10-for-1 split", affects_held: ["NVDA"] }),
    ],
    corporate_coverage: { dividends: "Ex-dates come from the issuer calendar.", splits: "Splits are read from price history.", unknown_symbols: ["SPY", "VOO"] },
  });

  it("sorts by date and labels each row", () => {
    const { rows } = corporateRows(report, MORNING);
    assert.deepEqual(rows.map((r) => r.id), ["split", "earn", "div", "reb"]);
    assert.deepEqual(rows.map((r) => r.dateLabel), ["Sep 21", "Sep 22", "Sep 24", "Sep 25"]);
    assert.deepEqual(rows.map((r) => r.whenLabel), ["today", "in 1 session", "in 3 sessions", "in 4 sessions"]);
    assert.deepEqual(rows.map((r) => r.kindLabel), ["Split", "Earnings", "Dividend", "Index rebalance"]);
    assert.deepEqual(rows.map((r) => r.certaintyNote), [null, "estimated date", null, "scheduled, per index methodology"]);
  });

  it("lists the held funds a rebalance concerns, and not a name against itself", () => {
    const { rows } = corporateRows(report, MORNING);
    assert.deepEqual(rows.find((r) => r.id === "reb")?.concerns, ["SPY", "VOO"]);
    assert.deepEqual(rows.find((r) => r.id === "div")?.concerns, []);
  });

  it("does not call Monday's event today on Sunday evening, nor a past one upcoming", () => {
    const sundayEvening = at("2026-09-21T01:00:00.000Z"); // 21:00 ET on the 20th
    assert.equal(corporateRows(report, sundayEvening).rows[0].whenLabel, "Monday");
    const tuesday = at("2026-09-22T14:00:00.000Z");
    assert.deepEqual(corporateRows(report, tuesday).rows.map((r) => r.whenLabel).slice(0, 2), ["passed", "today"]);
  });

  it("passes the coverage notes through and names the symbols with no data", () => {
    assert.deepEqual(corporateRows(report, MORNING).coverageNotes, [
      "Ex-dates come from the issuer calendar.",
      "Splits are read from price history.",
      "No corporate calendar data for SPY, VOO.",
    ]);
    assert.deepEqual(corporateRows(makeReport(), MORNING), { rows: [], coverageNotes: [] });
  });
});

describe("today's calendar", () => {
  const items: CalendarItem[] = [
    calendarItem("fomc", { kind: "fomc", time_et: "14:00", at: "2026-09-21T18:00:00.000Z", title: "FOMC rate decision", importance: 3 }),
    calendarItem("opex", { kind: "opex", title: "Monthly options expiry", importance: 2 }),
    calendarItem("claims", { time_et: "08:30", at: "2026-09-21T12:30:00.000Z", title: "Initial jobless claims", importance: 2 }),
    calendarItem("cpi", { time_et: "08:30", at: "2026-09-21T12:30:00.000Z", title: "Consumer price index", importance: 3 }),
    calendarItem("session", { kind: "session", title: "Regular session, 09:30 to 16:00", importance: 1 }),
    calendarItem("ism", { time_et: "10:00", at: null, title: "ISM manufacturing", importance: 2 }),
    calendarItem("earn", { kind: "earnings", title: "KO reports before the open", importance: 3, tickers: ["KO"] }),
  ];
  const report = makeReport({ calendar_today: items });

  it("splits all-day from timed and sorts each", () => {
    const view = calendarView(report, MORNING);
    assert.deepEqual(view.timed.map((t) => [t.id, t.timeLabel]), [["cpi", "08:30"], ["claims", "08:30"], ["ism", "10:00"], ["fomc", "14:00"]]);
    assert.deepEqual(view.allDay.map((a) => a.id), ["earn", "opex", "session"]);
    assert.deepEqual(view.allDay.map((a) => a.kindLabel), ["Earnings", "Options", "Session"]);
    assert.equal(view.allDay[0].timeLabel, null);
    assert.deepEqual(view.allDay[0].tickers, ["KO"]);
  });

  it("marks what is behind a fixed now and places the now line", () => {
    const before = calendarView(report, MORNING);
    assert.deepEqual(before.timed.map((t) => t.past), [false, false, false, false]);
    assert.equal(before.nowIndex, 0);

    const midMorning = calendarView(report, at("2026-09-21T13:00:00.000Z")); // 09:00 ET
    assert.deepEqual(midMorning.timed.map((t) => t.past), [true, true, false, false]);
    assert.equal(midMorning.nowIndex, 2);

    const onTheDot = calendarView(report, at("2026-09-21T12:30:00.000Z"));
    assert.equal(onTheDot.nowIndex, 2);

    const evening = calendarView(report, at("2026-09-21T21:00:00.000Z"));
    assert.deepEqual(evening.timed.map((t) => t.past), [true, true, true, true]);
    assert.equal(evening.nowIndex, 4);
    assert.deepEqual(evening.allDay.map((a) => a.past), [true, true, true]);
    assert.deepEqual(before.allDay.map((a) => a.past), [false, false, false]);
  });

  // The panel is open from 20:00 ET the evening before, where every item of the
  // target session is still ahead and the marker sits at the top of the list.
  // A wall-clock time on it would print "21:00" above "08:30" on a rail that is
  // otherwise strictly in order, so the view says which side of midnight it is on.
  it("says the reader is not yet on the day it lists, on the evening before", () => {
    const nightBefore = calendarView(report, at("2026-09-21T01:00:00.000Z")); // 21:00 ET, Sunday
    assert.deepEqual(nightBefore.timed.map((t) => t.past), [false, false, false, false]);
    assert.equal(nightBefore.nowIndex, 0);
    assert.equal(nightBefore.nowOnTargetDay, false);

    assert.equal(calendarView(report, MORNING).nowOnTargetDay, true);
    assert.equal(calendarView(report, at("2026-09-21T21:00:00.000Z")).nowOnTargetDay, true); // 17:00 ET, same day
    assert.equal(calendarView(report, at("not a date")).nowOnTargetDay, false);
  });

  it("falls back to the New York wall clock for an item with no instant", () => {
    const ismAt = (iso: string) => calendarView(report, at(iso)).timed.find((t) => t.id === "ism")!.past;
    assert.equal(ismAt("2026-09-21T13:59:00.000Z"), false); // 09:59 ET
    assert.equal(ismAt("2026-09-21T14:00:00.000Z"), true); // 10:00 ET
    assert.equal(ismAt("2026-09-21T01:00:00.000Z"), false); // Sunday evening in New York
    assert.equal(ismAt("2026-09-22T05:00:00.000Z"), true); // Tuesday 01:00 ET
  });

  it("puts the now line at zero on an empty day", () => {
    const view = calendarView(makeReport(), MORNING);
    assert.deepEqual([view.timed, view.allDay, view.nowIndex], [[], [], 0]);
  });

  it("writes a quiet footnote while the target is covered and a warning once it is not", () => {
    assert.deepEqual(calendarView(report, MORNING).footnote, { text: "Calendar covers until Oct 31, 2026.", tone: "quiet" });
    const lapsed = makeReport({ calendar_coverage: { ...report.calendar_coverage, until: "2026-09-18", covers_target: false, days_left: 0 } });
    assert.deepEqual(calendarView(lapsed, MORNING).footnote, {
      text: "Calendar data ends Sep 18, 2026. This session is not covered.",
      tone: "warn",
    });
  });
});

describe("degraded sections", () => {
  it("gives one quiet line per failed section", () => {
    const notes = degradedNotes(
      makeReport({
        degraded: [
          { section: "markets", detail: "ECONNRESET 10.0.0.4" },
          { section: "held_quotes", detail: "two symbols failed", symbols: ["AAPL", "MSFT"] },
          { section: "held_quotes", detail: "one more", symbols: ["NVDA", "AAPL"] },
          { section: "narrative", detail: "model timeout" },
        ],
      }),
    );
    assert.deepEqual(notes, {
      markets: "Overnight prints are unavailable right now.",
      held_quotes: "No fresh price for AAPL, MSFT, NVDA.",
      narrative: "The written summary is using the standard template.",
    });
    assert.doesNotMatch(JSON.stringify(notes), /ECONNRESET|timeout/);
  });

  it("lets a whole-section failure outrank a per-symbol one, and shortens a list that runs on", () => {
    const whole = degradedNotes(makeReport({ degraded: [{ section: "chain_news", detail: "x", symbols: ["AAPL"] }, { section: "chain_news", detail: "y" }, { section: "chain_news", detail: "z", symbols: ["KO"] }] }));
    assert.equal(whole.chain_news, "News and filings on held names are unavailable right now.");
    const many = degradedNotes(makeReport({ degraded: [{ section: "corporate_actions", detail: "x", symbols: ["A", "B", "C", "D", "E", "F"] }] }));
    assert.equal(many.corporate_actions, "Corporate events are unavailable for A, B, C, D and 2 more.");
  });

  it("has a line for every section, and none when nothing failed", () => {
    const sections = ["markets", "held_quotes", "chain_news", "market_news", "quant", "risk", "corporate_actions", "macro_calendar", "narrative"] as const;
    const notes = degradedNotes(makeReport({ degraded: sections.map((section) => ({ section, detail: "x" })) }));
    for (const section of sections) assert.ok(notes[section], section);
    assert.deepEqual(degradedNotes(makeReport()), {});
  });

  it("renders an almost-empty, fully degraded report without throwing", () => {
    const sections = ["markets", "held_quotes", "chain_news", "market_news", "quant", "risk", "corporate_actions", "macro_calendar", "narrative"] as const;
    const report = makeReport({ degraded: sections.map((section) => ({ section, detail: "down" })) });
    assert.equal(Object.keys(degradedNotes(report)).length, sections.length);
    assert.deepEqual(marketGroups(report), []);
    assert.deepEqual(heldRows(report, { limit: 8, masked: false }), { rows: [], quietCount: 0, hiddenCount: 0 });
    assert.equal(bookView(report, false).risk, null);
    assert.deepEqual(corporateRows(report, MORNING).rows, []);
    assert.equal(calendarView(report, MORNING).timed.length, 0);
    const card = cardSummary(report, MORNING, false);
    assert.deepEqual(
      [card.headline, card.sub, card.meaning, card.reactions, card.more, card.nextItem],
      ["Handover for Monday, Sep 21", null, null, [], [], null],
    );
    assert.deepEqual(implicationsView(report, false), []);
    assert.deepEqual(storiesView(report, false), []);
  });

  it("survives a cached report from an older build that lacks whole sections", () => {
    const full = makeReport();
    const partial = { schema_version: 0, generated_at: full.generated_at, demo: false, synthetic_now: false, window: full.window } as unknown as BriefingReport;
    assert.doesNotThrow(() => {
      narrativeView(partial, true);
      marketGroups(partial);
      heldRows(partial, { limit: 8, masked: true });
      bookView(partial, true);
      corporateRows(partial, MORNING);
      calendarView(partial, MORNING);
      degradedNotes(partial);
      implicationsView(partial, true);
      cardSummary(partial, MORNING, true);
    });
    assert.equal(calendarView(partial, MORNING).footnote.tone, "warn");
    assert.deepEqual(bookView(partial, false).tiles.map((t) => t.value), [NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE]);
  });
});

describe("implications", () => {
  const report = makeReport({ implications: IMPLICATIONS });

  it("numbers the conclusions in the engine's order, without ranking them again", () => {
    const view = implicationsView(report, false);
    assert.deepEqual(view.map((v) => v.id), ["open_indication:book", "name_specific:NVDA", "earnings_exposure:AAPL"]);
    assert.deepEqual(view.map((v) => v.index), [1, 2, 3]);
    assert.deepEqual(view.map((v) => v.kind), ["open_indication", "name_specific", "earnings_exposure"]);
    assert.equal(view[1].headline, "NVDA moved well beyond what the market explains.");
    assert.equal(view[1].because, "It is down 3.4% against 0.6% for its beta, a 2.1 sigma day.");
    assert.deepEqual(view[2].tickers, ["AAPL"]);
  });

  it("sizes a scenario in whole unsigned dollars, and masks the size with the book's other dollars", () => {
    const plain = implicationsView(report, false);
    assert.deepEqual(plain.map((v) => v.scenarioUsd), ["$1,498", null, "$1,130"]);
    assert.equal(plain[0].scenario, "A 1% index move either way is about 1.2% of the book.");

    const masked = implicationsView(report, true);
    assert.deepEqual(masked.map((v) => v.scenarioUsd), [MASKED_USD, null, MASKED_USD]);
    // Percentages give away no account size and stay.
    assert.equal(masked[0].scenario, plain[0].scenario);
    assert.equal(masked[2].headline, plain[2].headline);

    const negative = implicationsView(makeReport({ implications: [implication("x", { scenario_usd: -2500.6 })] }), false);
    assert.equal(negative[0].scenarioUsd, "$2,501");
  });

  it("drops a dollar figure that has no scenario sentence to belong to", () => {
    const orphan = implicationsView(makeReport({ implications: [implication("x", { scenario: null, scenario_usd: 900 })] }), false);
    assert.equal(orphan[0].scenario, null);
    assert.equal(orphan[0].scenarioUsd, null);
    const blank = implicationsView(makeReport({ implications: [implication("x", { scenario: "   ", scenario_usd: 900 })] }), false);
    assert.equal(blank[0].scenarioUsd, null);
  });

  it("keeps dollars out of every sentence, masked or not", () => {
    for (const masked of [false, true]) {
      for (const v of implicationsView(report, masked)) {
        for (const text of [v.headline, v.because, v.scenario ?? ""]) assert.doesNotMatch(text, /\$/, text);
      }
    }
    // The contract forbids them; a sentence that carries one anyway is masked like the narrative.
    const leak = makeReport({
      implications: [
        implication("leak", {
          headline: "The book is up $1,234.50 since Friday.",
          because: `NVDA gave back ${MINUS}$310.20 of it.`,
          scenario: "About $1.2M either way.",
        }),
      ],
    });
    const [masked] = implicationsView(leak, true);
    assert.equal(masked.headline, `The book is up ${MASKED_USD} since Friday.`);
    assert.equal(masked.because, `NVDA gave back ${MASKED_USD} of it.`);
    assert.equal(masked.scenario, `About ${MASKED_USD} either way.`);
  });

  it("reads a missing or malformed list as no conclusions", () => {
    const full = makeReport();
    const partial = { schema_version: 1, generated_at: full.generated_at, demo: false, synthetic_now: false, window: full.window } as unknown as BriefingReport;
    assert.deepEqual(implicationsView(partial, false), []);
    for (const implications of [null, "none", { 0: IMPLICATIONS[0] }, 3]) {
      assert.deepEqual(implicationsView({ ...full, implications } as unknown as BriefingReport, true), []);
    }
  });

  it("skips entries it cannot print, closes up the numbering, and keeps row keys apart", () => {
    const junk = [
      null,
      3,
      "a sentence on its own",
      { id: "empty", headline: "" },
      { id: "number", headline: 7 },
      { id: "a", kind: "concentration", headline: "  One   position carries a quarter of the book. ", tickers: "NVDA" },
      { id: "a", kind: "data_gap", headline: "Volatility is missing for two names.", scenario: 5, scenario_usd: "12" },
      { kind: "data_gap", headline: "No id on this one.", because: null, tickers: ["MSFT", 4, ""] },
    ];
    const view = implicationsView({ ...makeReport(), implications: junk } as unknown as BriefingReport, false);
    assert.deepEqual(
      view.map((v) => [v.index, v.id, v.headline]),
      [
        [1, "a", "One position carries a quarter of the book."],
        [2, "a-2", "Volatility is missing for two names."],
        [3, "implication-3", "No id on this one."],
      ],
    );
    assert.deepEqual(view[0].tickers, []);
    assert.deepEqual([view[1].scenario, view[1].scenarioUsd, view[1].because], [null, null, ""]);
    assert.deepEqual(view[2].tickers, ["MSFT"]);
  });
});

describe("stories", () => {
  // The fixture's window is a weekend handover, so the session-itself story is labelled by the gap it covers.
  const report = makeReport({ stories: STORIES });

  it("numbers the stories in the engine's order and formats each figure in its unit", () => {
    const views = storiesView(report, false);
    assert.deepEqual(
      views.map((v) => [v.index, v.id, v.scope, v.source]),
      [
        [1, "market:futures", "market", "template"],
        [2, "name:NVDA", "name", "model"],
        [3, "release:session", "release", "template"],
      ],
    );
    assert.deepEqual(views[0].reactions, [
      { label: "S&P fut", move: "+0.42%", tone: "up" },
      { label: "10y", move: "+6.0 bp", tone: "up" },
      { label: "VIX", move: "+1.20", tone: "up" },
      { label: "Nikkei", move: NOT_AVAILABLE, tone: "none" },
    ]);
    assert.deepEqual(views[1].reactions, [{ label: "NVDA", move: `${MINUS}3.40%`, tone: "down" }]);
    assert.deepEqual(views[1].tickers, ["NVDA"]);
    assert.deepEqual(views[1].evidence, ["inc-NVDA", "name_specific:NVDA"]);
    assert.equal(views[2].reaction, "");
  });

  it("labels when: a bare time on the session day, the weekday within the week, the gap's name for the session itself", () => {
    assert.deepEqual(storiesView(report, false).map((v) => v.at), ["06:42", "Sat 06:42", "Weekend"]);
    const overnight = makeReport({ stories: [STORIES[2]], window: { ...report.window, handover: "overnight" } });
    assert.equal(storiesView(overnight, false)[0].at, "Overnight");
    const holiday = makeReport({ stories: [STORIES[2]], window: { ...report.window, handover: "holiday" } });
    assert.equal(storiesView(holiday, false)[0].at, "Holiday");
    const inSession = makeReport({ stories: [STORIES[2]], window: { ...report.window, phase: "in_session" } });
    assert.equal(storiesView(inSession, false)[0].at, "Session");
    const unreadable = makeReport({ stories: [{ ...STORIES[0], at: "not a date" }] });
    assert.equal(storiesView(unreadable, false)[0].at, null);
  });

  it("masks dollars in every sentence and leaves percentages alone", () => {
    const views = storiesView(report, true);
    assert.equal(views[0].meaning, `Futures point to a book about 0.5% higher at the open, which is ${MASKED_USD} of it.`);
    assert.equal(views[0].reaction, STORIES[0].reaction);
    assert.equal(views[1].reaction, "NVDA is down 3.4% in the pre-market, 2.1 of its daily volatility.");
    assert.equal(storiesView(report, false)[0].meaning, STORIES[0].meaning);
  });

  it("reads a missing or malformed list as no stories", () => {
    assert.deepEqual(storiesView(makeReport(), false), []);
    assert.deepEqual(storiesView({ ...makeReport(), stories: undefined as unknown as Story[] }, false), []);
    assert.deepEqual(storiesView({ ...makeReport(), stories: "nope" as unknown as Story[] }, false), []);
  });

  it("skips a story with nothing that happened, closes up the numbering, and keeps block keys apart", () => {
    const views = storiesView(
      makeReport({
        stories: [
          { ...STORIES[0], id: "dup" },
          { ...STORIES[1], what: "   " },
          { ...STORIES[2], id: "dup" },
          {
            ...STORIES[2],
            id: "",
            scope: "weird" as StoryScope,
            reactions: undefined as unknown as StoryReaction[],
            tickers: undefined as unknown as string[],
            evidence: undefined as unknown as string[],
          },
        ],
      }),
      false,
    );
    assert.deepEqual(
      views.map((v) => [v.index, v.id, v.scope]),
      [
        [1, "dup", "market"],
        [2, "dup-2", "release"],
        [3, "story-3", "market"],
      ],
    );
    assert.deepEqual(views[2].reactions, []);
    assert.deepEqual(views[2].tickers, []);
    assert.deepEqual(views[2].evidence, []);
  });

  it("lends only a story with a meaning its evidence to the conclusions list", () => {
    const ids = spokenImplicationIds(storiesView(report, false));
    assert.deepEqual([...ids], ["hl-1", "open_indication:book"]);
    assert.equal(ids.has("name_specific:NVDA"), false);
    assert.equal(spokenImplicationIds([]).size, 0);
  });
});

describe("phase title", () => {
  const report = makeReport();

  it("names the phase and the session: the handover before the open, the session so far in it, after the close once it is over", () => {
    assert.equal(phaseTitle(report), "Handover for Monday, Sep 21");
    assert.equal(phaseTitle(report, MORNING), "Handover for Monday, Sep 21");
    assert.equal(phaseTitle(report, at("2026-09-21T15:00:00.000Z")), "Session so far, Monday, Sep 21");
    assert.equal(phaseTitle(report, at("2026-09-21T21:00:00.000Z")), "After the close, Monday, Sep 21");
  });

  // From 16:00 to 20:00 ET the report already hands over to the next session,
  // so "after the close" has to name the one that actually closed.
  it("names the session that closed, not the one ahead, on the evening before the window opens", () => {
    const evening = makeReport({ window: { ...report.window, phase: "between_sessions" }, generated_at: "2026-09-20T22:00:00.000Z" });
    assert.equal(phaseTitle(evening, at("2026-09-20T22:00:00.000Z")), "After the close, Friday, Sep 18");
    assert.equal(phaseTitle(evening), "After the close, Friday, Sep 18");
  });

  it("shows an unreadable date as it came", () => {
    assert.equal(phaseTitle(makeReport({ window: { ...report.window, target_session_ymd: "soon" } })), "Handover for soon");
  });
});

describe("dashboard card", () => {
  const base = makeReport();
  const report = makeReport({
    overnight: { ...base.overnight, markets: MARKETS },
    narrative: { ...base.narrative, text: "Futures are firmer and the book is up $900.10 since Friday. Europe is mixed." },
    corporate_events: [corporate("a"), corporate("b")],
    calendar_today: [
      calendarItem("cpi", { title: "CPI", time_et: "08:30", at: "2026-09-21T12:30:00.000Z", importance: 3 }),
      calendarItem("ism", { time_et: "10:00", at: "2026-09-21T14:00:00.000Z" }),
      calendarItem("fomc", { kind: "fomc", time_et: "14:00", at: "2026-09-21T18:00:00.000Z", importance: 3 }),
      calendarItem("auction", { time_et: "13:00", at: "2026-09-21T17:00:00.000Z", importance: 1 }),
      calendarItem("opex", { kind: "opex", title: "Options expiry" }),
    ],
  });
  const told = makeReport({ ...report, stories: STORIES, implications: IMPLICATIONS });

  it("leads with the top story: what happened, its figures as chips, and what it means for the book", () => {
    const card = cardSummary(told, MORNING, false);
    assert.equal(card.headline, STORIES[0].what);
    assert.equal(card.sub, STORIES[0].reaction);
    assert.equal(card.meaning, STORIES[0].meaning);
    // Three chips at most, whatever the story carries.
    assert.deepEqual(card.reactions.map((r) => r.move), ["+0.42%", "+6.0 bp", "+1.20"]);
    assert.deepEqual(card.reactions.map((r) => r.tone), ["up", "up", "up"]);
  });

  it("masks a dollar figure in the lead story's sentences", () => {
    const card = cardSummary(told, MORNING, true);
    assert.equal(card.meaning, `Futures point to a book about 0.5% higher at the open, which is ${MASKED_USD} of it.`);
    assert.equal(card.headline, STORIES[0].what);
  });

  it("lists the next two stories with the first figure each carries a print for", () => {
    assert.deepEqual(cardSummary(told, MORNING, false).more, [
      { id: "name:NVDA", scope: "name", what: STORIES[1].what, primaryMove: `${MINUS}3.40%`, tone: "down" },
      { id: "release:session", scope: "release", what: STORIES[2].what, primaryMove: null, tone: "none" },
    ]);
    const withheld = makeReport({ ...told, stories: [STORIES[0], { ...STORIES[1], reactions: [{ label: "NVDA", symbol: "NVDA", move: null, unit: "pct" }] }] });
    assert.deepEqual(cardSummary(withheld, MORNING, false).more.map((m) => m.primaryMove), [null]);
  });

  it("names the next calendar item still ahead, an all-day one by its title, and nothing once the day is over", () => {
    assert.equal(cardSummary(report, MORNING, false).nextItem, "08:30 CPI");
    assert.equal(cardSummary(report, at("2026-09-21T16:00:00.000Z"), false).nextItem, "13:00 auction");
    assert.equal(cardSummary(report, at("2026-09-21T19:00:00.000Z"), false).nextItem, "Options expiry");
    assert.equal(cardSummary(report, at("2026-09-21T21:00:00.000Z"), false).nextItem, null);
  });

  it("with no stories, falls back to the lead conclusion and its evidence line", () => {
    const concluded = makeReport({ ...report, implications: IMPLICATIONS });
    for (const masked of [false, true]) {
      const card = cardSummary(concluded, MORNING, masked);
      assert.equal(card.headline, "Futures point to a book about 0.5% higher at the open.");
      assert.equal(card.sub, "S&P 500 futures are up 0.42% and the book's beta is 1.2.");
      assert.equal(card.meaning, null);
      assert.deepEqual(card.reactions, []);
      assert.deepEqual(card.more, []);
    }
    const bare = makeReport({ ...report, implications: [implication("x", { because: " " })] });
    assert.equal(cardSummary(bare, MORNING, false).sub, null);
  });

  it("with neither, uses the first narrative sentence as the headline, masked when asked", () => {
    assert.equal(cardSummary(report, MORNING, false).headline, "Futures are firmer and the book is up $900.10 since Friday.");
    assert.equal(cardSummary(report, MORNING, true).headline, `Futures are firmer and the book is up ${MASKED_USD} since Friday.`);
    assert.equal(cardSummary(report, MORNING, false).sub, null);
  });

  it("carries the phase chip", () => {
    assert.equal(cardSummary(report, MORNING, false).phase.detail, "opens in 2h 14m");
  });
});

// ---------------------------------------------------------------------------
// Wording rules
// ---------------------------------------------------------------------------

const BANNED_STEMS = [
  "buy", "sell", "enter", "exit", "long", "short", "add", "trim", "target", "stop", "take profit", "signal", "prediction",
  "recommend", "reduce", "consider", "should", "will", "expect", "forecast", "predict", "likely", "may",
];
// No "-er": "longer" and "shorter" are ordinary comparatives, and the engine-side matcher lets them through too.
const SUFFIX = "(?:s|es|d|ed|ing|ning|ped|ping|med|ming|ted|ting|ation|ations|ion|ions)?";
const IRREGULAR = ["bought", "sold", "buyers?", "sellers?", "entry", "entries", "reducing", "reduction", "unlikely", "took profit", "taking profit"];
const BANNED = new RegExp(`\\b(?:${[...BANNED_STEMS.map((w) => `${w}${SUFFIX}`), ...IRREGULAR].join("|")})\\b`, "i");
const LONG_DASH = /[\u2013\u2014]/;

/** "May 21" (and the masthead's "MAY 21") is a date, not the modal verb; every other use of the word is caught. */
const withoutMayDates = (text: string) => text.replace(/\bMay \d{1,2}\b/gi, "");

function offences(text: string): string[] {
  const found: string[] = [];
  const hit = BANNED.exec(withoutMayDates(text));
  if (hit) found.push(`"${hit[0]}" in: ${text}`);
  if (LONG_DASH.test(text)) found.push(`long dash in: ${text}`);
  return found;
}

/**
 * Fields that carry an identifier or an enum value for the component to branch
 * on (a weight segment's side is "long" or "short"), never text it prints.
 */
const IDENTIFIER_KEYS = new Set(["id", "key", "kind", "side", "state", "tone", "source", "symbol", "ticker", "band", "basis", "url", "scope", "evidence"]);

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!IDENTIFIER_KEYS.has(k)) stringsIn(v, out);
  }
  return out;
}

describe("wording rules", () => {
  it("the checker itself catches inflections and ignores look-alikes and May dates", () => {
    assert.equal(offences("insiders buying into a decline").length, 1);
    assert.equal(offences("stopped out").length, 1);
    assert.equal(offences("this may move").length, 1);
    assert.equal(offences("Take Profit here").length, 1);
    assert.equal(offences("a range \u2013 of sorts").length, 1);
    assert.deepEqual(offences("a longer address; shortly; additional; maybe not"), []);
    assert.deepEqual(offences("Calendar covers until May 31, 2027."), []);
  });

  it("nothing a reader can see breaks them, in any phase, masked or not, in May included", () => {
    const base = makeReport();
    const variants: BriefingReport[] = [];
    for (const ymd of ["2026-09-21", "2026-05-21"]) {
      const day = (time: string) => `${ymd}T${time}.000Z`;
      variants.push(
        makeReport({
          window: {
            ...base.window,
            target_session_ymd: ymd,
            window_opens_at: day("00:00:00"),
            target_open_at: day("13:30:00"),
            target_close_at: day("17:00:00"),
            early_close: true,
          },
          overnight: {
            markets: MARKETS.map((m) => (m.state === "stale" ? { ...m, as_of: "2026-05-15T06:00:00.000Z" } : m)),
            held_movers: [mover("NVDA", { move_pct: -3.4, move_z: -2.1, flag: "corporate_action_check" }), mover("NEWCO", { move_z: null, basis: "today" })],
            held_news: [news("NVDA", { published_at: "2026-05-08T10:30:00.000Z" })],
            filings: [{ ticker: "NVDA", kind: "insider", label: "Form 4", filed_at: day("10:00:00"), url: "" }],
            measurements: (["unexplained_move", "volume_anomaly", "drift_event", "gap_event", "news_burst", "insider_cluster"] as const).map((type) => ({
              ticker: "MSFT",
              type,
              detail: "Measured against its own history",
              at: day("09:00:00"),
            })),
          },
          held_coverage: [{ ticker: "NEWCO", coverage: "pending" }, { ticker: "SPY", coverage: "price_only" }],
          book: {
            ...base.book,
            position_count: 6,
            equity_usd: 1000,
            overnight_pnl_usd: 5,
            overnight_pnl_pct: 0.5,
            top_weights: [{ ticker: "NVDA", weight: 0.5, side: "long" }, { ticker: "TSLA", weight: -0.2, side: "short" }],
            unpriced: ["A", "B", "C", "D", "E"],
          },
          risk: { score: 40, band: "moderate", driver_component: null, driver_sentence: null, beta_eff: 1, beta_port: 1, port_vol_daily_pct: 1, computed_at: day("10:00:00"), matches_book: true },
          corporate_events: [
            corporate("d", { date: ymd, sessions_until: 0 }),
            corporate("e", { kind: "earnings", certainty: "estimated", date: "2026-05-22", sessions_until: 1 }),
            corporate("r", { kind: "rebalance", certainty: "rule", ticker: null, affects_held: ["SPY"], date: "2026-05-29", sessions_until: 5 }),
            corporate("s", { kind: "split", date: "2026-01-02", sessions_until: 0 }),
          ],
          corporate_coverage: { dividends: "", splits: "", unknown_symbols: ["SPY"] },
          calendar_today: (["fomc", "data", "opex", "earnings", "session", "rebalance"] as const).map((kind, i) =>
            calendarItem(`c${i}`, { kind, title: "Scheduled item", time_et: i % 2 ? "08:30" : null, at: i % 2 ? day("12:30:00") : null }),
          ),
          calendar_coverage: { ...base.calendar_coverage, until: "2027-05-31" },
          implications: IMPLICATIONS,
          stories: STORIES,
          degraded: (["markets", "held_quotes", "chain_news", "quant", "risk", "corporate_actions", "macro_calendar", "narrative"] as const).flatMap((section) => [
            { section, detail: "x" },
          ]),
        }),
      );
    }
    variants.push(makeReport({ calendar_coverage: { ...base.calendar_coverage, until: "2026-05-15", covers_target: false } }));
    variants.push(makeReport({ degraded: [{ section: "quant", detail: "x", symbols: ["A", "B", "C", "D", "E"] }, { section: "chain_news", detail: "x", symbols: ["A"] }, { section: "corporate_actions", detail: "x", symbols: ["A"] }] }));
    variants.push(makeReport({ window: { ...base.window, target_open_at: "unreadable", phase: "in_session" } }));
    variants.push({ window: base.window } as unknown as BriefingReport);

    const seen: string[] = [TIMES_NOTE, RISK_UNAVAILABLE_NOTE, NOT_AVAILABLE];
    for (const report of variants) {
      const ymd = report.window.target_session_ymd;
      const moments = [`${ymd}T01:00:00.000Z`, `${ymd}T11:16:00.000Z`, `${ymd}T13:29:30.000Z`, `${ymd}T15:00:00.000Z`, `${ymd}T22:00:00.000Z`, "2026-01-01T12:00:00.000Z"];
      for (const moment of moments) {
        const now = at(moment);
        for (const masked of [false, true]) {
          stringsIn(
            [
              phaseChip(report, now),
              mastheadDate(report),
              titleLine(report),
              sinceLine(report),
              marketGroups(report),
              heldRows(report, { limit: 20, masked }),
              bookView(report, masked),
              corporateRows(report, now),
              calendarView(report, now),
              degradedNotes(report),
              implicationsView(report, masked),
              storiesView(report, masked),
              phaseTitle(report, now),
              phaseTitle(report),
              cardSummary(report, now, masked),
            ],
            seen,
          );
        }
      }
    }
    const unique = [...new Set(seen)];
    assert.ok(unique.some((s) => s.includes("May 21")), "the fixture is meant to exercise a May date");
    assert.ok(unique.length > 80, `only ${unique.length} distinct strings were checked`);
    assert.deepEqual(unique.flatMap(offences), []);
  });

  it("no prose literal in the source breaks them either", () => {
    const source = readFileSync(new URL("./briefing-view.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    const literals = [...source.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)]
      .map((m) => m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " x "))
      // A single token is an identifier, an enum value or a month name, not prose.
      .filter((text) => /\S\s+\S/.test(text));
    assert.ok(literals.length > 40, `only ${literals.length} prose literals were found`);
    assert.ok(literals.includes("Check for a corporate action"));
    assert.deepEqual(literals.flatMap(offences), []);
    assert.ok(MONTH_ABBR.includes("May"));
  });
});
