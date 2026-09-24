import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GlossModelInput } from "../gloss/types.js";
import {
  BRIEFING_NARRATIVE_MODEL_DEFAULT,
  BRIEFING_NARRATIVE_SCHEMA,
  BRIEFING_NARRATIVE_SYSTEM,
  applyModelStories,
  buildNarrativeFacts,
  buildNarrativeUser,
  copyRuleFaults,
  generateNarrative,
  narrativeFactsHash,
  splitSentences,
  storiesFromFacts,
  templateNarrative,
  validateModelStories,
  validateNarrative,
  type ModelStory,
  type NarrativeCaller,
  type NarrativeFacts,
} from "./narrative.js";
import type {
  BriefingReport,
  CalendarItem,
  CorporateEvent,
  HeldMover,
  HeldNewsItem,
  Implication,
  MarketGroup,
  MarketHeadline,
  MarketRow,
  MarketState,
  MarketUnit,
  Story,
} from "./types.js";

type ReportInput = Omit<BriefingReport, "narrative" | "facts_hash">;

const NOW = "2026-09-22T11:30:00.000Z";

function row(
  symbol: string,
  label: string,
  group: MarketGroup,
  unit: MarketUnit,
  move: number | null,
  state: MarketState = "final",
  last: number | null = 100,
): MarketRow {
  return {
    symbol,
    label,
    group,
    last,
    prev_close: last,
    move,
    unit,
    basis: group === "us_futures" ? "prior_settle" : "prev_close",
    state,
    as_of: state === "unavailable" ? null : "2026-09-22T06:00:00.000Z",
  };
}

function markets(over: Record<string, Partial<MarketRow>> = {}): MarketRow[] {
  const rows = [
    row("^N225", "Nikkei 225", "asia", "pct", -1.12),
    row("^HSI", "Hang Seng", "asia", "pct", 0.35),
    row("^STOXX50E", "Euro Stoxx 50", "europe", "pct", 0.18, "live"),
    row("ES=F", "S&P 500 futures", "us_futures", "pct", 0.42, "live"),
    row("NQ=F", "Nasdaq-100 futures", "us_futures", "pct", 0.61, "live"),
    row("^VIX", "VIX", "macro", "pts", 0.8, "final", 17.2),
    row("^TNX", "US 10-year yield", "macro", "bp", 4, "final", 4.25),
  ];
  return rows.map((r) => ({ ...r, ...(over[r.symbol] ?? {}) }));
}

function mover(ticker: string, move_pct: number, move_z: number | null, flag: HeldMover["flag"] = null): HeldMover {
  return {
    ticker,
    last: 187.34,
    ref_close: 183.05,
    move_pct,
    move_z,
    pnl_usd: 4321.09,
    basis: "since_close",
    session: "pre",
    as_of: NOW,
    flag,
    beta: null,
    daily_vol_pct: null,
  };
}

function news(ticker: string, headline: string, band: HeldNewsItem["band"], published_at: string): HeldNewsItem {
  return {
    ticker,
    also: [],
    headline,
    source: "wire",
    url: "https://news.example.com/a",
    published_at,
    band,
    tags: [],
    incident_id: `inc-${ticker}-${published_at}`,
  };
}

function marketHeadline(id: string, title: string, published_at = "2026-09-22T07:00:00.000Z"): MarketHeadline {
  return { id, title, source: "wire", url: `https://news.example.com/${id}`, published_at, related: ["SPY"], via: "SPY" };
}

function calendarItem(id: string, title: string, time_et: string | null, importance: 1 | 2 | 3, kind: CalendarItem["kind"] = "data"): CalendarItem {
  return { id, kind, time_et, at: null, title, detail: null, importance, tickers: [], source: "curated" };
}

function corporate(id: string, title: string, sessions_until: number): CorporateEvent {
  return {
    id,
    kind: "dividend",
    date: "2026-09-23",
    sessions_until,
    ticker: "MSFT",
    index: null,
    title,
    detail: "0.83 per share",
    affects_held: ["MSFT"],
    certainty: "confirmed",
    source: "yahoo_calendar",
  };
}

function implication(id: string, kind: Implication["kind"], headline: string, because: string, book_pct: number | null, over: Partial<Implication> = {}): Implication {
  return { id, kind, headline, because, scenario: null, scenario_usd: null, book_pct, tickers: [], ...over };
}

const OPEN = implication(
  "open_indication:book",
  "open_indication",
  "Overnight futures point to a rise of about 0.55% for the book at the open.",
  "S&P 500 futures are up 0.42% since the close, and the book moves about 1.3% for each 1% the index moves.",
  0.55,
);
const EARNINGS = implication(
  "earnings_exposure:KO",
  "earnings_exposure",
  "KO reports today before the open and is 5% of the book.",
  "The report is due Tuesday, September 22, before the open; its normal daily move is 1.1%.",
  0.11,
  {
    scenario: "A move of twice its normal day (2.2%) either way is about 0.11% of the book.",
    scenario_usd: 275.01,
    tickers: ["KO"],
  },
);
const OWN = implication(
  "name_specific:TSLA",
  "name_specific",
  "TSLA's 3.9% drop is its own, not the market's.",
  "The market alone points to a rise of about 0.8% for it, and no headline on TSLA since the close accounts for it.",
  -0.47,
  { tickers: ["TSLA"] },
);

const STORY_NVDA: Story = {
  id: "story:name:NVDA",
  scope: "name",
  at: "2026-09-22T00:30:00.000Z",
  what: "NVDA reported results",
  reaction: "NVDA is up 2.34% since the close, 1.4 times its normal day",
  reactions: [{ label: "NVDA", symbol: "NVDA", move: 2.34, unit: "pct" }],
  meaning: null,
  tickers: ["NVDA"],
  evidence: ["https://www.sec.gov/nvda/8-k", "mover:NVDA"],
  source: "template",
};

const STORY_TAPE: Story = {
  id: "story:market:tape",
  scope: "market",
  at: null,
  what: "Overnight, the tape has 2 market headlines",
  reaction: "S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close; VIX up 0.8 pts at 17.2",
  reactions: [
    { label: "S&P 500 futures", symbol: "ES=F", move: 0.42, unit: "pct" },
    { label: "Nasdaq-100 futures", symbol: "NQ=F", move: 0.61, unit: "pct" },
    { label: "VIX", symbol: "^VIX", move: 0.8, unit: "pts" },
  ],
  meaning: OPEN.headline,
  tickers: [],
  evidence: ["ES=F", "NQ=F", "mh-1", "mh-2", "open_indication:book"],
  source: "template",
};

const MH_1 = marketHeadline("mh-1", "Equity futures edge higher before the bell as oil extends its climb");
const MH_2 = marketHeadline("mh-2", "Treasury yields hold near last week's highs into a busy data calendar", "2026-09-22T04:00:00.000Z");

function report(over: Partial<ReportInput> = {}): ReportInput {
  return {
    schema_version: 3,
    generated_at: NOW,
    demo: false,
    synthetic_now: false,
    window: {
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
    },
    overnight: {
      markets: markets(),
      held_movers: [
        mover("NVDA", 2.34, 1.4),
        mover("MSFT", -1.2, -0.9),
        mover("KO", 0.4, 1.6),
        mover("AAPL", 0.3, 0.2),
        mover("TSLA", -3.9, -1.1),
        mover("SPLT", -48.0, -9.0, "corporate_action_check"),
      ],
      held_news: [
        news("NVDA", "Nvidia wins $3B sovereign chip order", "P1", "2026-09-22T05:00:00.000Z"),
        news("MSFT", "Microsoft faces EU cloud inquiry", "P0", "2026-09-22T04:00:00.000Z"),
        news("AAPL", "Apple supplier note", "P2", "2026-09-22T03:00:00.000Z"),
      ],
      filings: [],
      measurements: [],
    },
    held_coverage: [],
    book: {
      position_count: 7,
      equity_usd: 250_000.55,
      cash_usd: 12_345.67,
      invested_usd: 237_654.88,
      net_exposure_pct: 95.06,
      gross_exposure_pct: 95.06,
      overnight_pnl_usd: 1_525.91,
      overnight_pnl_pct: 0.61,
      top_weights: [
        { ticker: "NVDA", weight: 0.34, side: "long" },
        { ticker: "MSFT", weight: 0.12, side: "long" },
        { ticker: "KO", weight: 0.05, side: "short" },
        { ticker: "AAPL", weight: 0.04, side: "long" },
      ],
      unpriced: [],
      priced_at: NOW,
    },
    risk: {
      score: 61,
      band: "elevated",
      driver_component: "concentration",
      driver_sentence: "34% of the portfolio sits in NVDA.",
      beta_eff: 1.3,
      beta_port: 1.2,
      port_vol_daily_pct: 1.8,
      computed_at: NOW,
      matches_book: true,
    },
    earnings_next: [
      { ticker: "KO", due_ymd: "2026-09-22", timing: "bmo", sessions_until: 0, fiscal_period: "Q3", confirmed: true, source: "tracker" },
      { ticker: "MSFT", due_ymd: "2026-10-27", timing: "amc_or_unspecified", sessions_until: 25, fiscal_period: null, confirmed: false, source: "yahoo" },
    ],
    corporate_events: [
      corporate("div-msft", "MSFT ex-dividend date", 1),
      corporate("reb-sp", "S&P quarterly rebalance takes effect", 2),
      corporate("div-ko", "KO ex-dividend date", 6),
    ],
    corporate_coverage: { dividends: "provider", splits: "provider", unknown_symbols: [] },
    calendar_today: [
      calendarItem("fomc-2026-09-22", "FOMC rate decision", "14:00", 3, "fomc"),
      calendarItem("cpi-2026-09-22", "CPI", "08:30", 3),
      calendarItem("claims-2026-09-22", "Initial jobless claims", "08:30", 2),
      calendarItem("opex-2026-09-22", "Monthly options expiry", null, 2, "opex"),
      calendarItem("ism-2026-09-22", "ISM manufacturing", "10:00", 2),
      calendarItem("minor-2026-09-22", "Wholesale inventories", "10:00", 1),
      calendarItem("earn-ko", "KO earnings", "07:00", 3, "earnings"),
    ],
    calendar_coverage: { from: "2026-01-01", until: "2026-12-31", compiled_at: "2026-09-01", covers_target: true, days_left: 100 },
    headlines: [],
    stories: [],
    implications: [],
    degraded: [],
    ...over,
  };
}

function withMarkets(over: Record<string, Partial<MarketRow>>): ReportInput {
  const base = report();
  return { ...base, overnight: { ...base.overnight, markets: markets(over) } };
}

/** The report with the two fixture stories and the two market headlines they rest on. */
function storied(over: Partial<ReportInput> = {}): ReportInput {
  return report({ stories: [STORY_NVDA, STORY_TAPE], headlines: [MH_1, MH_2], implications: [OPEN], ...over });
}

const FORBIDDEN_WORDS = [
  "buy", "sell", "enter", "exit", "long", "short", "add", "trim", "target", "stop", "take profit", "signal",
  "prediction", "recommend", "reduce", "consider", "should", "will", "expect", "forecast", "predict", "likely", "may",
];

/** The COPY RULES, checked without leaning on the module's own checker alone. */
function assertCopyClean(text: string): void {
  assert.ok(!/[\u2012-\u2015]/.test(text), `dash in: ${text}`);
  const monthless = text.replace(/\bMay (?=\d)/g, "Mmm ");
  for (const word of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${word}(?:s|es|d|ed|ing)?\\b`, "i");
    assert.ok(!re.test(monthless), `"${word}" in: ${text}`);
  }
  assert.deepEqual(copyRuleFaults(text), [], text);
}

const CALENDAR = "This session's calendar has earnings from KO, CPI at 08:30 ET and FOMC rate decision at 14:00 ET.";
const MARKET_LIST = "Overnight markets show S&P 500 futures up 0.4%, Nasdaq-100 futures up 0.6%, Nikkei 225 down 1.1%, Euro Stoxx 50 up 0.2% and VIX up 0.8 pts.";

describe("buildNarrativeFacts", () => {
  it("carries no dollars, prices or account figures out of a report full of them", () => {
    const facts = buildNarrativeFacts(storied());
    const json = JSON.stringify(facts);
    assert.ok(!json.includes("$"));
    for (const figure of ["250000", "12345", "237654", "1525", "4321", "187.34", "183.05", "0.83"]) {
      assert.ok(!json.includes(figure), `account or price figure ${figure} leaked`);
    }
    assert.ok(!/"(?:[a-z_]*usd|shares|cost[a-z_]*|cash[a-z_]*|equity[a-z_]*|last|ref_close|position_count|weight|side)"/.test(json), json);
    assert.ok(!buildNarrativeUser(facts).includes("$"));
  });

  it("spells out the dollar sign of a third-party headline instead of passing it on", () => {
    const facts = buildNarrativeFacts(report());
    assert.deepEqual(
      facts.held_headlines.map((h) => h.untrusted_headline),
      ["Microsoft faces EU cloud inquiry", "Nvidia wins USD 3B sovereign chip order"],
    );
  });

  it("carries the template stories with their ids, evidence and tickers, scrubbed, and never their chips", () => {
    const facts = buildNarrativeFacts(storied());
    assert.deepEqual(facts.template_stories, [
      {
        id: "story:name:NVDA",
        scope: "name",
        what: "NVDA reported results",
        reaction: "NVDA is up 2.34% since the close, 1.4 times its normal day",
        meaning: null,
        tickers: ["NVDA"],
        evidence: ["https://www.sec.gov/nvda/8-k", "mover:NVDA"],
      },
      {
        id: "story:market:tape",
        scope: "market",
        what: "Overnight, the tape has 2 market headlines",
        reaction: "S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close; VIX up 0.8 pts at 17.2",
        meaning: OPEN.headline,
        tickers: [],
        evidence: ["ES=F", "NQ=F", "mh-1", "mh-2", "open_indication:book"],
      },
    ]);
    assert.ok(!JSON.stringify(facts.template_stories).includes("reactions"));
    const dollar = buildNarrativeFacts(report({ stories: [{ ...STORY_NVDA, what: "NVDA won a $3B order", meaning: "  " }] }));
    assert.equal(dollar.template_stories[0]!.what, "NVDA won a USD 3B order");
    assert.equal(dollar.template_stories[0]!.meaning, null);
  });

  it("carries up to eight market headlines as untrusted titles, one per title", () => {
    const many = Array.from({ length: 10 }, (_, i) => marketHeadline(`m${i}`, i === 9 ? "Equity futures edge higher before the bell as oil extends its climb" : `Headline ${i} says $1B`));
    const facts = buildNarrativeFacts(report({ headlines: many }));
    assert.equal(facts.headlines.length, 8);
    assert.deepEqual(facts.headlines[0], { id: "m0", untrusted_title: "Headline 0 says USD 1B", published_at: "2026-09-22T07:00:00.000Z", related: ["SPY"] });
    const twice = buildNarrativeFacts(report({ headlines: [MH_1, { ...MH_1, id: "again", url: "https://other.example.com/x" }] }));
    assert.deepEqual(twice.headlines.map((h) => h.id), ["mh-1"]);
  });

  it("reads an older report, with no stories or headlines, as having none", () => {
    const older = { ...report() } as Partial<ReportInput>;
    delete older.stories;
    delete older.headlines;
    const facts = buildNarrativeFacts(older as ReportInput);
    assert.deepEqual(facts.template_stories, []);
    assert.deepEqual(facts.headlines, []);
  });

  it("keeps the handover kind, the early close and the lead rows only", () => {
    const base = report();
    const facts = buildNarrativeFacts({ ...base, window: { ...base.window, handover: "weekend", early_close: true } });
    assert.equal(facts.handover, "weekend");
    assert.equal(facts.early_close, true);
    assert.deepEqual(
      facts.markets.map((m) => [m.label, m.move, m.unit, m.state]),
      [
        ["S&P 500 futures", 0.42, "pct", "live"],
        ["Nasdaq-100 futures", 0.61, "pct", "live"],
        ["Nikkei 225", -1.12, "pct", "final"],
        ["Euro Stoxx 50", 0.18, "pct", "live"],
        ["VIX", 0.8, "pts", "final"],
      ],
    );
    assert.equal(facts.vix_level_band, "15_to_20");
  });

  it("withholds stale and unavailable rows and says which group is which", () => {
    const facts = buildNarrativeFacts(
      withMarkets({
        "^N225": { state: "stale", move: null },
        "^HSI": { state: "stale", move: null },
        "^STOXX50E": { state: "unavailable", move: null, last: null },
        "^VIX": { state: "stale", move: null },
        "^TNX": { state: "unavailable", move: null, last: null },
      }),
    );
    assert.deepEqual(facts.markets.map((m) => m.label), ["S&P 500 futures", "Nasdaq-100 futures"]);
    assert.deepEqual(facts.market_groups, { asia: "stale", europe: "unavailable", us_futures: "available", macro: "stale" });
    assert.equal(facts.vix_level_band, null);
  });

  it("bands the VIX level at 15, 20 and 30", () => {
    const band = (last: number) => buildNarrativeFacts(withMarkets({ "^VIX": { last } })).vix_level_band;
    assert.equal(band(14.99), "below_15");
    assert.equal(band(15), "15_to_20");
    assert.equal(band(20), "20_to_30");
    assert.equal(band(30), "above_30");
  });

  it("lists up to three movers that moved 1 pct or one sigma, never a flagged one", () => {
    const facts = buildNarrativeFacts(report());
    assert.deepEqual(facts.movers, [
      { ticker: "TSLA", move_pct: -3.9, move_z: -1.1 },
      { ticker: "NVDA", move_pct: 2.34, move_z: 1.4 },
      { ticker: "MSFT", move_pct: -1.2, move_z: -0.9 },
    ]);
    const base = report();
    const quiet = buildNarrativeFacts({
      ...base,
      overnight: { ...base.overnight, held_movers: [mover("KO", 0.4, 1.6), mover("AAPL", 0.3, 0.2), mover("PEP", 0.9, null)] },
    });
    assert.deepEqual(quiet.movers.map((m) => m.ticker), ["KO"]);
  });

  it("keeps P0/P1 held headlines only, P0 first, one per article, three at most", () => {
    const base = report();
    const facts = buildNarrativeFacts({
      ...base,
      overnight: {
        ...base.overnight,
        held_news: [
          news("NVDA", "Shared article", "P1", "2026-09-22T05:00:00.000Z"),
          news("AMD", "Shared article", "P1", "2026-09-22T05:00:00.000Z"),
          news("MSFT", "Older P1", "P1", "2026-09-22T01:00:00.000Z"),
          news("KO", "Newer P1", "P1", "2026-09-22T06:00:00.000Z"),
          news("TSLA", "The P0", "P0", "2026-09-22T00:30:00.000Z"),
          news("AAPL", "A P2", "P2", "2026-09-22T07:00:00.000Z"),
        ],
      },
    });
    assert.deepEqual(facts.held_headlines.map((h) => h.untrusted_headline), ["The P0", "Newer P1", "Shared article"]);
    assert.equal(facts.headline_names, 5);
  });

  it("carries the risk line only when the snapshot describes this book", () => {
    const base = report();
    assert.deepEqual(buildNarrativeFacts(base).risk, {
      band: "elevated",
      driver_component: "concentration",
      driver_sentence: "34% of the portfolio sits in NVDA.",
    });
    assert.equal(buildNarrativeFacts({ ...base, risk: { ...base.risk!, matches_book: false } }).risk, null);
    assert.equal(buildNarrativeFacts({ ...base, risk: null }).risk, null);
    assert.equal(buildNarrativeFacts({ ...base, risk: { ...base.risk!, band: null } }).risk, null);
  });

  it("takes four calendar items of importance 2 and up, in time order, earnings apart", () => {
    const facts = buildNarrativeFacts(report());
    assert.deepEqual(facts.calendar_today, [
      { id: "opex-2026-09-22", time_et: null, title: "Monthly options expiry", importance: 2 },
      { id: "claims-2026-09-22", time_et: "08:30", title: "Initial jobless claims", importance: 2 },
      { id: "cpi-2026-09-22", time_et: "08:30", title: "CPI", importance: 3 },
      { id: "fomc-2026-09-22", time_et: "14:00", title: "FOMC rate decision", importance: 3 },
    ]);
    assert.deepEqual(facts.earnings_today, [{ ticker: "KO", timing: "before_open" }]);
  });

  it("leaves session items out of the calendar facts, so the early close is said once", () => {
    const base = report();
    const facts = buildNarrativeFacts({
      ...base,
      window: { ...base.window, early_close: true },
      calendar_today: [
        calendarItem("session:early_close", "Early close at 13:00 ET", null, 2, "session"),
        calendarItem("opex-2026-09-22", "Monthly options expiry", null, 2, "opex"),
      ],
      earnings_next: [],
    });
    assert.deepEqual(facts.calendar_today.map((c) => c.id), ["opex-2026-09-22"]);
    const text = templateNarrative(facts, NOW, "h", null).text;
    assert.ok(text.endsWith("This session closes early at 13:00 ET, and its calendar has Monthly options expiry."), text);
    assert.equal(text.match(/13:00 ET/g)?.length, 1, text);
  });

  it("keeps corporate events within two sessions, coverage, and weight buckets without sides", () => {
    const facts = buildNarrativeFacts(report());
    assert.deepEqual(facts.corporate_events, [
      { id: "div-msft", title: "MSFT ex-dividend date" },
      { id: "reb-sp", title: "S&P quarterly rebalance takes effect" },
    ]);
    assert.equal(facts.calendar_covers_target, true);
    assert.equal(facts.calendar_until, "2026-12-31");
    assert.deepEqual(facts.top_weights, [
      { ticker: "NVDA", bucket: "large" },
      { ticker: "MSFT", bucket: "medium" },
      { ticker: "KO", bucket: "small" },
    ]);
    assert.equal(facts.book_move_pct, 0.61);
  });

  it("carries a conclusion's text, id, size and tickers, and never its dollar size", () => {
    const facts = buildNarrativeFacts(report({ implications: [EARNINGS, OPEN] }));
    assert.deepEqual(facts.implications[0], {
      kind: "earnings_exposure",
      headline: EARNINGS.headline,
      because: EARNINGS.because,
      scenario: EARNINGS.scenario,
      id: "earnings_exposure:KO",
      book_pct: 0.11,
      tickers: ["KO"],
    });
    assert.ok(!JSON.stringify(facts).includes("275"));
    assert.ok(!JSON.stringify(facts).includes("scenario_usd"));
    const dollar = implication("x:y", "concentration", "SPY is $26 of it.", "It is.", 0.2);
    assert.equal(buildNarrativeFacts(report({ implications: [dollar] })).implications[0]!.headline, "SPY is USD 26 of it.");
  });
});

describe("narrativeFactsHash", () => {
  const baseHash = narrativeFactsHash(buildNarrativeFacts(storied()));

  it("holds still under minute-to-minute price changes, and under a story's sentences ticking", () => {
    const base = storied();
    const jitter = buildNarrativeFacts({
      ...base,
      overnight: {
        ...base.overnight,
        markets: markets({
          "ES=F": { move: 0.47 },
          "NQ=F": { move: 0.58 },
          "^N225": { move: -1.3 },
          "^STOXX50E": { move: -0.05 },
          "^VIX": { move: 0.95, last: 17.9 },
        }),
        held_movers: base.overnight.held_movers.map((m) => ({ ...m, move_pct: m.move_pct * 1.02, last: m.last + 0.4 })),
      },
      book: { ...base.book, overnight_pnl_pct: 0.72, overnight_pnl_usd: 1_800, equity_usd: 250_300 },
      stories: [{ ...STORY_NVDA, reaction: "NVDA is up 2.39% since the close, 1.4 times its normal day" }, STORY_TAPE],
      headlines: [{ ...MH_1, title: "The same article, retitled" }, MH_2],
    });
    assert.equal(narrativeFactsHash(jitter), baseHash);
  });

  it("changes on a new story, a lost story, a new headline and a lost headline", () => {
    assert.notEqual(narrativeFactsHash(buildNarrativeFacts(storied({ stories: [STORY_NVDA] }))), baseHash);
    assert.notEqual(narrativeFactsHash(buildNarrativeFacts(storied({ stories: [STORY_NVDA, STORY_TAPE, { ...STORY_NVDA, id: "story:name:KO" }] }))), baseHash);
    assert.notEqual(narrativeFactsHash(buildNarrativeFacts(storied({ headlines: [MH_1] }))), baseHash);
    assert.notEqual(narrativeFactsHash(buildNarrativeFacts(storied({ headlines: [MH_1, MH_2, marketHeadline("mh-3", "A third")] }))), baseHash);
    // Order does not count: the lists are sorted before hashing.
    assert.equal(narrativeFactsHash(buildNarrativeFacts(storied({ stories: [STORY_TAPE, STORY_NVDA], headlines: [MH_2, MH_1] }))), baseHash);
  });

  it("changes on a sign flip", () => {
    assert.notEqual(narrativeFactsHash(buildNarrativeFacts(storied({ overnight: { ...storied().overnight, markets: markets({ "ES=F": { move: -0.42 } }) } }))), baseHash);
    const base = storied();
    const bookDown = buildNarrativeFacts({ ...base, book: { ...base.book, overnight_pnl_pct: -0.61 } });
    assert.notEqual(narrativeFactsHash(bookDown), baseHash);
  });

  it("changes when a move crosses into another band, per unit", () => {
    const withRows = (over: Record<string, Partial<MarketRow>>) => narrativeFactsHash(buildNarrativeFacts(storied({ overnight: { ...storied().overnight, markets: markets(over) } })));
    assert.notEqual(withRows({ "ES=F": { move: 1.05 } }), baseHash);
    assert.notEqual(withRows({ "ES=F": { move: 0.2 } }), baseHash);
    assert.notEqual(withRows({ "^VIX": { move: 2.4 } }), baseHash);
    assert.notEqual(withRows({ "^VIX": { last: 21 } }), baseHash);
    const base = storied();
    const bookBig = buildNarrativeFacts({ ...base, book: { ...base.book, overnight_pnl_pct: 1.4 } });
    assert.notEqual(narrativeFactsHash(bookBig), baseHash);
  });

  it("bands basis-point rows at 3 and 8", () => {
    const facts = buildNarrativeFacts(report());
    const withBp = (move: number): NarrativeFacts => ({
      ...facts,
      markets: [...facts.markets, { label: "US 10-year yield", group: "macro", move, unit: "bp", state: "final" }],
    });
    assert.equal(narrativeFactsHash(withBp(4)), narrativeFactsHash(withBp(7.5)));
    assert.notEqual(narrativeFactsHash(withBp(4)), narrativeFactsHash(withBp(2)));
    assert.notEqual(narrativeFactsHash(withBp(4)), narrativeFactsHash(withBp(9)));
    assert.notEqual(narrativeFactsHash(withBp(4)), narrativeFactsHash(withBp(-4)));
  });

  it("ignores the sign of a flat move", () => {
    const up = narrativeFactsHash(buildNarrativeFacts(withMarkets({ "^STOXX50E": { move: 0.02 } })));
    const down = narrativeFactsHash(buildNarrativeFacts(withMarkets({ "^STOXX50E": { move: -0.02 } })));
    assert.equal(up, down);
  });

  it("changes on a new held headline, a calendar change, a risk change and a lost group", () => {
    const base = storied();
    const newHeadline = buildNarrativeFacts({
      ...base,
      overnight: { ...base.overnight, held_news: [...base.overnight.held_news, news("KO", "Coca-Cola recalls a product line", "P1", "2026-09-22T08:00:00.000Z")] },
    });
    assert.notEqual(narrativeFactsHash(newHeadline), baseHash);

    const calendarChange = buildNarrativeFacts({ ...base, calendar_today: base.calendar_today.filter((c) => c.id !== "cpi-2026-09-22") });
    assert.notEqual(narrativeFactsHash(calendarChange), baseHash);

    const corporateChange = buildNarrativeFacts({ ...base, corporate_events: [] });
    assert.notEqual(narrativeFactsHash(corporateChange), baseHash);

    const uncovered = buildNarrativeFacts({ ...base, calendar_coverage: { ...base.calendar_coverage, covers_target: false } });
    assert.notEqual(narrativeFactsHash(uncovered), baseHash);

    const riskBand = buildNarrativeFacts({ ...base, risk: { ...base.risk!, band: "high" } });
    assert.notEqual(narrativeFactsHash(riskBand), baseHash);

    const asiaShut = buildNarrativeFacts({ ...base, overnight: { ...base.overnight, markets: markets({ "^N225": { state: "stale", move: null }, "^HSI": { state: "stale", move: null } }) } });
    assert.notEqual(narrativeFactsHash(asiaShut), baseHash);

    const moverFlip = buildNarrativeFacts({
      ...base,
      overnight: { ...base.overnight, held_movers: base.overnight.held_movers.map((m) => (m.ticker === "NVDA" ? { ...m, move_pct: -2.34 } : m)) },
    });
    assert.notEqual(narrativeFactsHash(moverFlip), baseHash);
  });

  it("changes when a top position is swapped for another of the same size", () => {
    const base = storied();
    const swapped = buildNarrativeFacts({
      ...base,
      book: { ...base.book, top_weights: base.book.top_weights.map((w) => (w.ticker === "NVDA" ? { ...w, ticker: "AVGO" } : w)) },
    });
    assert.notEqual(narrativeFactsHash(swapped), baseHash);
    const reweighted = (ticker: string, weight: number): ReportInput => ({
      ...base,
      book: { ...base.book, top_weights: base.book.top_weights.map((w) => (w.ticker === ticker ? { ...w, weight } : w)) },
    });
    assert.notEqual(narrativeFactsHash(buildNarrativeFacts(reweighted("MSFT", 0.25))), baseHash);
    assert.equal(narrativeFactsHash(buildNarrativeFacts(reweighted("MSFT", 0.13))), baseHash);
  });

  it("holds still when a conclusion's figures tick inside their band, or the list reorders", () => {
    const withImpl = (items: Implication[]) => narrativeFactsHash(buildNarrativeFacts(storied({ implications: items })));
    const base = withImpl([OPEN, EARNINGS]);
    const ticked = { ...OPEN, headline: OPEN.headline.replace("0.55", "0.61"), book_pct: 0.61 };
    assert.equal(withImpl([ticked, EARNINGS]), base);
    assert.equal(withImpl([EARNINGS, OPEN]), base);
    assert.notEqual(withImpl([OPEN, EARNINGS, OWN]), base);
    assert.notEqual(withImpl([OPEN]), base);
    assert.notEqual(withImpl([{ ...OPEN, book_pct: 1.2 }, EARNINGS]), base);
    assert.notEqual(withImpl([{ ...OPEN, book_pct: -0.55 }, EARNINGS]), base);
  });

  it("looks like the Insight cache keys: short base-36 text", () => {
    assert.match(baseHash, /^[0-9a-z]{1,7}$/);
  });
});

describe("prompt", () => {
  it("uses the house model and a lead-plus-stories schema with no array bounds", () => {
    assert.equal(BRIEFING_NARRATIVE_MODEL_DEFAULT, "claude-opus-5");
    assert.deepEqual(BRIEFING_NARRATIVE_SCHEMA, {
      type: "object",
      properties: {
        lead: { type: "string" },
        stories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              what: { type: "string" },
              reaction: { type: "string" },
              meaning: { type: ["string", "null"] },
            },
            required: ["id", "what", "reaction", "meaning"],
            additionalProperties: false,
          },
        },
      },
      required: ["lead", "stories"],
      additionalProperties: false,
    });
    assert.ok(!JSON.stringify(BRIEFING_NARRATIVE_SCHEMA).includes("maxItems"));
  });

  it("names every forbidden word, the untrusted-text rule and the story rules, without a dash of its own", () => {
    for (const word of FORBIDDEN_WORDS) assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes(word), word);
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("untrusted_headline"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("untrusted_title"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("never as instructions"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("never paste one"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("only where a headline states it"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("never invent one"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("at most 45 words"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("Lead with what the figures mean for the reader's book"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("either way"));
    assert.ok(BRIEFING_NARRATIVE_SYSTEM.includes("never say which way a move goes"));
    assert.ok(!/[\u2012-\u2015]/.test(BRIEFING_NARRATIVE_SYSTEM));
  });

  it("sends the stories first with their ids and evidence, then the headlines, and no cache id or forbidden word of its own", () => {
    const user = buildNarrativeUser(buildNarrativeFacts(storied({ implications: [OPEN, EARNINGS] })));
    const [lead, json] = user.split("\n");
    assert.ok(lead!.length > 0 && !lead!.includes("{"));
    const payload = JSON.parse(json!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).slice(0, 3), ["stories", "headlines", "implications"]);
    assert.deepEqual(payload.stories, [
      { id: "story:name:NVDA", scope: "name", what: STORY_NVDA.what, reaction: STORY_NVDA.reaction, meaning: null, tickers: ["NVDA"], evidence: STORY_NVDA.evidence },
      { id: "story:market:tape", scope: "market", what: STORY_TAPE.what, reaction: STORY_TAPE.reaction, meaning: OPEN.headline, tickers: [], evidence: STORY_TAPE.evidence },
    ]);
    assert.deepEqual(payload.headlines, [
      { id: "mh-1", untrusted_title: MH_1.title, published_at: MH_1.published_at, related: ["SPY"] },
      { id: "mh-2", untrusted_title: MH_2.title, published_at: MH_2.published_at, related: ["SPY"] },
    ]);
    assert.deepEqual(payload.implications, [
      { kind: "open_indication", headline: OPEN.headline, because: OPEN.because, scenario: null },
      { kind: "earnings_exposure", headline: EARNINGS.headline, because: EARNINGS.because, scenario: EARNINGS.scenario },
    ]);
    assert.equal(payload.calendar_covers_this_session, true);
    assert.ok(!user.includes("fomc-2026-09-22"));
    assert.ok(!user.includes("book_pct"));
    assert.ok(!/target/i.test(user));
    assert.ok(user.includes("untrusted_headline") && user.includes("untrusted_title"));
  });
});

describe("validateNarrative (the lead)", () => {
  const facts = buildNarrativeFacts(storied());
  const S1 = "S&P 500 futures rose 0.4% and Nasdaq-100 futures rose 0.6%, while the Nikkei 225 closed down 1.1%.";
  const S2 = "The book is up 0.61% since the last close, led by NVDA at 2.3%.";
  const S3 = "This session has CPI at 08:30 ET and the FOMC rate decision at 14:00 ET.";

  function kept(raw: string): string {
    const verdict = validateNarrative(raw, facts);
    assert.ok(verdict.ok, verdict.ok ? "" : verdict.reasons.join("; "));
    return verdict.text;
  }

  function rejected(raw: string): string[] {
    const verdict = validateNarrative(raw, facts);
    assert.ok(!verdict.ok);
    return verdict.reasons;
  }

  it("passes one or two grounded sentences through untouched", () => {
    assert.equal(kept(`${S1} ${S3}`), `${S1} ${S3}`);
    assert.equal(kept(S2), S2);
  });

  it("rejects three sentences, more than 55 words, and nothing at all", () => {
    assert.ok(rejected(`${S1} ${S2} ${S3}`).some((r) => r.includes("3 usable sentence")));
    const filler = "The session calendar is quiet and the overnight tape was calm across every region that traded since the last close of the US market";
    const two = Array.from({ length: 2 }, (_, i) => `${filler} in part ${i + 1} and then some more words to pass.`).join(" ");
    assert.ok(two.split(/\s+/).length > 55);
    assert.ok(rejected(two).some((r) => r.includes("words")));
    assert.ok(rejected("   ").some((r) => r.includes("empty")));
  });

  it("drops an advice sentence and keeps the rest", () => {
    assert.equal(kept(`${S1} Consider trimming NVDA before the open. ${S3}`), `${S1} ${S3}`);
    assert.equal(kept(`Buy NVDA now. ${S2}`), S2);
  });

  it("contains the advice check's false positives to their own sentence", () => {
    assert.equal(kept(`${S1} It is a short week for US markets. ${S3}`), `${S1} ${S3}`);
  });

  it("drops a sentence with a link, and rejects when nothing is left", () => {
    assert.equal(kept(`${S1} More at https://example.com/today. ${S3}`), `${S1} ${S3}`);
    assert.equal(kept(`${S1} Details are on falcon-notes.io for readers.`), S1);
    const reasons = rejected("Read https://example.com/today.");
    assert.ok(reasons.some((r) => r.includes("link")));
    assert.ok(reasons.some((r) => r.includes("0 usable sentence")));
  });

  it("drops a sentence with a dollar amount", () => {
    assert.equal(kept(`${S1} The book gained $1,525 overnight. ${S3}`), `${S1} ${S3}`);
    assert.equal(kept(`${S1} Nvidia won a USD 3B order.`), S1);
    assert.ok(rejected("The book gained $1,525 overnight.").some((r) => r.includes("dollar")));
  });

  it("drops a percentage that is not within 0.05 of one in the facts", () => {
    assert.equal(kept(`${S1} Gold rose 3.5%. ${S3}`), `${S1} ${S3}`);
    assert.ok(rejected("Gold rose 3.5 percent.").some((r) => r.includes("3.5")));
    assert.equal(kept(`S&P 500 futures rose 0.47%. ${S3}`), `S&P 500 futures rose 0.47%. ${S3}`);
    assert.equal(kept(`${S1} S&P 500 futures rose 0.48%.`), S1);
  });

  it("grounds a figure a template story states, and the tape story's level is not a figure", () => {
    assert.equal(kept("NVDA reported results and is up 2.34%, 1.4 times its normal day."), "NVDA reported results and is up 2.34%, 1.4 times its normal day.");
    assert.equal(kept(`${S1} VIX sits at 17.2 after a 0.8 point rise.`), `${S1} VIX sits at 17.2 after a 0.8 point rise.`);
  });

  it("does not let a points or basis-point move pass as a percentage", () => {
    assert.equal(kept(`${S1} VIX rose 0.8%. ${S3}`), `${S1} ${S3}`);
    assert.equal(kept(`${S1} VIX rose 0.8 pts.`), `${S1} VIX rose 0.8 pts.`);
    assert.equal(kept(`${S1} VIX rose 1.8 points.`), S1);
    assert.ok(rejected("VIX rose 1.8 pts.").some((r) => r.includes("points figure not in the facts (1.8)")));
  });

  it("drops a basis-point claim, which no lead row can ground", () => {
    assert.equal(kept(`${S1} The 10-year rose 12 basis points. ${S3}`), `${S1} ${S3}`);
    assert.ok(rejected("The 10-year rose 4 bp.").some((r) => r.includes("basis-point figure not in the facts (4)")));
    assert.ok(!rejected("The 10-year rose 12 basis points.").some((r) => r.includes("points figure not in the facts (12)")));
  });

  it("grounds a volatility multiple against the movers' own", () => {
    assert.equal(kept(`${S1} NVDA's move is 1.4 sigma.`), `${S1} NVDA's move is 1.4 sigma.`);
    assert.equal(kept(`${S1} NVDA's move is 4 sigma.`), S1);
  });

  it("accepts a percentage quoted from the risk driver sentence, a headline or a conclusion", () => {
    assert.equal(kept("Risk reads elevated, with 34% of the portfolio in NVDA."), "Risk reads elevated, with 34% of the portfolio in NVDA.");
    const text = "The book is set for a rise of about 0.55% at the open, since it moves about 1.3% for each 1% of the index.";
    assert.equal(kept(text), text);
  });

  it("replaces em and en dashes, including double-escaped ones", () => {
    const text = kept(`S&P 500 futures rose 0.4% \u2014 a calm start. CPI is at 08:30 ET\\u2014the main release in the 15\u201320 VIX band.`);
    assert.ok(!/[\u2012-\u2015]/.test(text));
    assert.equal(text, "S&P 500 futures rose 0.4%, a calm start. CPI is at 08:30 ET, the main release in the 15 to 20 VIX band.");
  });

  it("reads May before a day or a year as the month, and the modal as the modal", () => {
    assert.equal(kept(`${S1} CPI for April is set for May 12 at 08:30 ET.`), `${S1} CPI for April is set for May 12 at 08:30 ET.`);
    assert.equal(kept(`${S1} The file covers releases through May 2026.`), `${S1} The file covers releases through May 2026.`);
    assert.equal(kept(`${S1} Rates may fall.`), S1);
    assert.equal(kept(`${S1} May brings a rate cut.`), S1);
  });

  it("drops every predictive or imperative form", () => {
    for (const sentence of [
      "Futures will open higher.",
      "The Fed is likely on hold.",
      "Desks expect a quiet open.",
      "The book should hold up.",
      "Analysts forecast a cut.",
      "It'll be a busy session.",
      "Traders predicted a rally.",
      "Holders are reducing exposure.",
      "The Fed kept its target range.",
      "NVDA was added to the index.",
    ]) {
      assert.equal(kept(`${S1} ${sentence}`), S1, sentence);
    }
  });

  it("does not read a held ticker as a forbidden word", () => {
    const held: NarrativeFacts = { ...facts, movers: [{ ticker: "ADD", move_pct: 2.34, move_z: 1.4 }] };
    const verdict = validateNarrative(`${S1} ADD rose 2.3%. They add risk.`, held);
    assert.ok(verdict.ok);
    assert.equal(verdict.text, `${S1} ADD rose 2.3%.`);
    const own = implication("name_specific:STOP", "name_specific", "STOP's 4.1% rise is its own, not the market's.", "The market explains about 0.2% of it.", 0.3, { tickers: ["STOP"] });
    const f = buildNarrativeFacts(report({ implications: [own] }));
    assert.ok(validateNarrative(`${own.headline} ${S3}`, f).ok);
  });

  it("splits on sentence ends, not on decimals or abbreviations", () => {
    assert.deepEqual(splitSentences("U.S. futures rose 0.4%. CPI is at 8:30 a.m. ET on Sept. 22. Done!"), [
      "U.S. futures rose 0.4%.",
      "CPI is at 8:30 a.m. ET on Sept. 22.",
      "Done!",
    ]);
  });
});

describe("validateModelStories", () => {
  const facts = buildNarrativeFacts(storied());
  const GOOD_NVDA: ModelStory = {
    id: "story:name:NVDA",
    what: "NVDA put out its results after the close.",
    reaction: "The name is up 2.34% since the close, about 1.4 times its normal day.",
    meaning: null,
  };
  const GOOD_TAPE: ModelStory = {
    id: "story:market:tape",
    what: "Two overnight headlines, on futures drifting higher and on Treasury yields holding.",
    reaction: "S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close, with the VIX up 0.8 pts at 17.2.",
    meaning: "For the book that is a rise of about 0.55% at the open.",
  };

  it("keeps grounded rewrites under the ids given, meaning included where the draft had one", () => {
    const verdict = validateModelStories([GOOD_NVDA, GOOD_TAPE], facts);
    assert.deepEqual(verdict.reasons, []);
    assert.deepEqual(verdict.stories, [GOOD_NVDA, GOOD_TAPE]);
  });

  it("drops an id the input did not carry, and a repeat", () => {
    const verdict = validateModelStories([{ ...GOOD_NVDA, id: "story:name:KO" }, GOOD_NVDA, GOOD_NVDA, { what: "x" }], facts);
    assert.deepEqual(verdict.stories, [GOOD_NVDA]);
    assert.equal(verdict.reasons.length, 3);
    assert.ok(verdict.reasons[0]!.includes("story:name:KO") && verdict.reasons[0]!.includes("not one of the stories given"));
    assert.ok(verdict.reasons[1]!.includes("returned twice"));
    assert.ok(verdict.reasons[2]!.includes("no id"));
  });

  it("drops a story whole for a forbidden word, an ungrounded figure, a dollar, a link or a length in any field", () => {
    const cases: Array<[Partial<ModelStory>, string]> = [
      [{ what: "NVDA should rally on its results." }, "forbidden wording"],
      [{ reaction: "The name is up 3.7% since the close." }, "a percentage not in the facts (3.7)"],
      [{ reaction: "The name gained $4,321 for the book." }, "a dollar amount"],
      [{ what: "Details at https://example.com/nvda." }, "advice or a link"],
      [{ what: Array.from({ length: 61 }, () => "word").join(" ") }, "more than 60 words"],
    ];
    for (const [over, reason] of cases) {
      const verdict = validateModelStories([{ ...GOOD_NVDA, ...over }, GOOD_TAPE], facts);
      assert.deepEqual(verdict.stories, [GOOD_TAPE], reason);
      assert.equal(verdict.reasons.length, 1, reason);
      assert.ok(verdict.reasons[0]!.startsWith("story story:name:NVDA was dropped for"), verdict.reasons[0]);
      assert.ok(verdict.reasons[0]!.includes(reason), `${reason} :: ${verdict.reasons[0]}`);
    }
  });

  it("allows a meaning only where the draft had one", () => {
    const verdict = validateModelStories([{ ...GOOD_NVDA, meaning: "That is good news for the book." }, { ...GOOD_TAPE, meaning: null }], facts);
    assert.deepEqual(verdict.stories, [{ ...GOOD_TAPE, meaning: null }]);
    assert.ok(verdict.reasons[0]!.includes("a meaning where the draft has none"));
  });

  it("refuses a headline pasted whole, while a summary in other words passes", () => {
    const pasted = validateModelStories([{ ...GOOD_TAPE, what: `The wire says: ${MH_1.title}.` }], facts);
    assert.deepEqual(pasted.stories, []);
    assert.ok(pasted.reasons[0]!.includes("a headline pasted whole"));
    const summarised = validateModelStories([{ ...GOOD_TAPE, what: "Futures drifted higher before the bell as oil kept climbing, per the overnight wires." }], facts);
    assert.deepEqual(summarised.reasons, []);
  });

  it("replaces dashes and decodes escapes before judging a field", () => {
    const verdict = validateModelStories([{ ...GOOD_NVDA, what: "NVDA reported \u2014 results are out.", reaction: "Up 2.34%\\u2013 a strong night." }], facts);
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.stories[0]!.what, "NVDA reported, results are out.");
    assert.equal(verdict.stories[0]!.reaction, "Up 2.34%, a strong night.");
  });

  it("drops an empty field, and reads a missing or non-list stories value as no rewrites", () => {
    const empty = validateModelStories([{ ...GOOD_NVDA, what: "   " }, { ...GOOD_TAPE, reaction: 7 as unknown as string }], facts);
    assert.deepEqual(empty.stories, []);
    assert.ok(empty.reasons[0]!.includes("an empty what"));
    assert.ok(empty.reasons[1]!.includes("an empty reaction"));
    assert.deepEqual(validateModelStories(undefined, facts), { stories: [], reasons: [] });
    assert.deepEqual(validateModelStories(null, facts), { stories: [], reasons: [] });
    assert.deepEqual(validateModelStories("two stories", facts), { stories: [], reasons: ["stories was not a list"] });
  });

  it("does not read a story's own ticker as a forbidden word", () => {
    const f = buildNarrativeFacts(report({ stories: [{ ...STORY_NVDA, id: "story:name:ADD", what: "ADD reported results", reaction: "ADD is up 2.34% since the close", tickers: ["ADD"] }] }));
    const verdict = validateModelStories([{ id: "story:name:ADD", what: "ADD put out its results.", reaction: "ADD is up 2.34% since the close.", meaning: null }], f);
    assert.deepEqual(verdict.reasons, []);
  });
});

describe("templateNarrative (the lead)", () => {
  const HASH = "abc123";

  /** Every template must clear the copy rules and the model's own validator. */
  function text(facts: NarrativeFacts): string {
    const narrative = templateNarrative(facts, NOW, HASH, "model call failed");
    assert.equal(narrative.source, "template");
    assert.equal(narrative.model, null);
    assert.equal(narrative.pending, false);
    assert.equal(narrative.generated_at, NOW);
    assert.equal(narrative.facts_hash, HASH);
    assert.equal(narrative.reason, "model call failed");
    assertCopyClean(narrative.text);
    assert.ok(!narrative.text.includes("$"));
    assert.ok(splitSentences(narrative.text).length <= 2, narrative.text);
    const verdict = validateNarrative(narrative.text, facts);
    assert.ok(verdict.ok, verdict.ok ? "" : `${narrative.text} :: ${verdict.reasons.join("; ")}`);
    assert.equal(verdict.text, narrative.text);
    return narrative.text;
  }

  const allUnavailable: NarrativeFacts["market_groups"] = { asia: "unavailable", europe: "unavailable", us_futures: "unavailable", macro: "unavailable" };

  it("leads with the first story, joined on its ticker, and closes on the calendar", () => {
    assert.equal(text(buildNarrativeFacts(storied())), `NVDA reported results and is up 2.34% since the close, 1.4 times its normal day. ${CALENDAR}`);
    assert.equal(templateNarrative(buildNarrativeFacts(storied()), NOW, HASH, null).reason, null);
  });

  it("says 'since the close' once when the event already says it", () => {
    const inNews = { ...STORY_NVDA, what: "NVDA is in the news since the close (2 headlines)" };
    assert.ok(text(buildNarrativeFacts(storied({ stories: [inNews] }))).startsWith("NVDA is in the news since the close (2 headlines) and is up 2.34%, 1.4 times its normal day. "));
  });

  it("takes a market or release story after a colon", () => {
    assert.equal(
      text(buildNarrativeFacts(storied({ stories: [STORY_TAPE, STORY_NVDA] }))),
      `Overnight, the tape has 2 market headlines: S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close; VIX up 0.8 pts at 17.2. ${CALENDAR}`,
    );
    const release: Story = { ...STORY_TAPE, id: "story:release:cpi", scope: "release", what: "CPI printed at 08:30 ET", reaction: "S&P 500 futures are up 0.42% since the close" };
    assert.ok(text(buildNarrativeFacts(storied({ stories: [release] }))).startsWith("CPI printed at 08:30 ET: S&P 500 futures are up 0.42% since the close. "));
    // In session the tape story opens on "since the close", so the reaction does not say it again.
    const inSession: Story = { ...STORY_TAPE, what: "Since the close, the tape has 2 market headlines" };
    assert.ok(
      text(buildNarrativeFacts(storied({ stories: [inSession] }))).startsWith(
        "Since the close, the tape has 2 market headlines: S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61%; VIX up 0.8 pts at 17.2. ",
      ),
    );
    const noReaction: Story = { ...STORY_NVDA, reaction: "" };
    assert.ok(text(buildNarrativeFacts(storied({ stories: [noReaction] }))).startsWith("NVDA reported results. "));
    const unusual: Story = { ...STORY_NVDA, reaction: "NVDA's move since the close is withheld while a split or other corporate action is checked" };
    assert.ok(text(buildNarrativeFacts(storied({ stories: [unusual] }))).startsWith("NVDA reported results: NVDA's move since the close is withheld"));
  });

  it("falls back to the open indication, then to the market list, when there is no story", () => {
    assert.equal(text(buildNarrativeFacts(report({ implications: [EARNINGS, OPEN] }))), `${OPEN.headline} ${CALENDAR}`);
    assert.equal(text(buildNarrativeFacts(report({ implications: [EARNINGS, OWN] }))), `${MARKET_LIST} ${CALENDAR}`);
    assert.equal(text(buildNarrativeFacts(report())), `${MARKET_LIST} ${CALENDAR}`);
  });

  it("market list: weekend and holiday openers, flat and basis-point wording, feed states", () => {
    const base = buildNarrativeFacts(report());
    assert.ok(text({ ...base, handover: "weekend" }).startsWith("After the weekend, markets show S&P 500 futures up 0.4%"));
    assert.ok(text({ ...base, handover: "holiday" }).startsWith("After the holiday break, markets show S&P 500 futures up 0.4%"));
    const one = text({ ...base, markets: [{ label: "S&P 500 futures", group: "us_futures", move: 0.04, unit: "pct", state: "live" }] });
    assert.ok(one.startsWith("Overnight markets show S&P 500 futures flat."));
    const two = text({
      ...base,
      markets: [
        { label: "S&P 500 futures", group: "us_futures", move: -0.31, unit: "pct", state: "live" },
        { label: "US 10-year yield", group: "macro", move: -6, unit: "bp", state: "final" },
      ],
    });
    assert.ok(two.startsWith("Overnight markets show S&P 500 futures down 0.3% and US 10-year yield down 6 bp."));
    assert.ok(text({ ...base, markets: [], market_groups: allUnavailable, vix_level_band: null }).startsWith("The overnight market feed is unavailable, so index moves are not listed."));
    assert.ok(text({ ...base, markets: [], market_groups: { ...allUnavailable, asia: "stale", macro: "available" } }).startsWith("The lead indices have no fresh print since the last US close."));
  });

  it("keeps the calendar inside the word limit by cutting it to its top item, then giving it up", () => {
    const words = (n: number, first: string): string => [first, ...Array.from({ length: n - 1 }, () => "word")].join(" ");
    const long = (whatWords: number, reactionWords: number): Story => ({
      ...STORY_TAPE,
      what: words(whatWords, "Alpha"),
      reaction: words(reactionWords, "beta"),
      meaning: null,
    });
    // 30 + 9 words is a 39-word sentence: with the 17-word calendar it passes 55, so the calendar keeps its top item only.
    const cut = text(buildNarrativeFacts(storied({ stories: [long(30, 9)] })));
    assert.ok(cut.startsWith("Alpha word") && cut.endsWith(" This session's calendar has earnings from KO."), cut);
    // The same sentence with a calendar file that has run out: the shortest calendar sentence is still too long, so the lead stands alone.
    const alone = text(buildNarrativeFacts(storied({ stories: [long(30, 9)], calendar_coverage: { from: "2026-01-01", until: "2026-05-31", compiled_at: "2026-05-01", covers_target: false, days_left: -100 } })));
    assert.equal(splitSentences(alone).length, 1, alone);
    assert.ok(alone.startsWith("Alpha word"), alone);
    // A story sentence past 40 words leaves no room at all, so the open indication leads instead.
    const skipped = text(buildNarrativeFacts(storied({ stories: [long(32, 9)] })));
    assert.equal(skipped, `${OPEN.headline} ${CALENDAR}`);
  });

  it("calendar: items with and without an early close, nothing scheduled, and a file that has run out", () => {
    const base = buildNarrativeFacts(storied());
    const items = { ...base, earnings_today: [] };
    assert.ok(text(items).endsWith("This session's calendar has Monthly options expiry, CPI at 08:30 ET and FOMC rate decision at 14:00 ET."));
    assert.ok(text({ ...items, early_close: true }).endsWith("This session closes early at 13:00 ET, and its calendar has Monthly options expiry, CPI at 08:30 ET and FOMC rate decision at 14:00 ET."));
    const empty = { ...base, earnings_today: [], calendar_today: [] };
    assert.ok(text(empty).endsWith("Nothing is scheduled in the calendar file for this session."));
    assert.ok(text({ ...empty, early_close: true }).endsWith("This session closes early at 13:00 ET, with nothing else scheduled in the calendar file."));
    const ended = { ...empty, calendar_covers_target: false, calendar_until: "2026-05-31" };
    assert.ok(text(ended).endsWith("The macro calendar file ends on May 31, 2026, so releases for this session are not listed."));
    assert.ok(text({ ...ended, early_close: true }).endsWith("so releases for this session are not listed; the session closes early at 13:00 ET."));
    assert.ok(text({ ...ended, calendar_today: [{ id: "opex", time_et: null, title: "Monthly options expiry", importance: 2 }] }).endsWith("the calendar still has Monthly options expiry."));
    assert.ok(text({ ...ended, calendar_until: "not-a-date" }).includes("ends on not-a-date,"));
  });

  it("calendar: held earnings from one name to more than three, and a title that breaks the copy rules", () => {
    const base = buildNarrativeFacts(storied());
    const earnings = (tickers: string[]): NarrativeFacts => ({
      ...base,
      calendar_today: [],
      earnings_today: tickers.map((ticker) => ({ ticker, timing: "after_close_or_unannounced" as const })),
    });
    assert.ok(text(earnings(["KO"])).endsWith("This session's calendar has earnings from KO."));
    assert.ok(text(earnings(["KO", "PEP", "MSFT", "NVDA"])).endsWith("has earnings from KO, PEP, MSFT and 1 more held name."));
    assert.ok(text(earnings(["KO", "PEP", "MSFT", "NVDA", "TSLA"])).endsWith("has earnings from KO, PEP, MSFT and 2 more held names."));
    const out = text({
      ...base,
      earnings_today: [],
      calendar_today: [
        { id: "a", time_et: "14:00", title: "FOMC target range decision", importance: 3 },
        { id: "b", time_et: "08:30", title: "CPI", importance: 3 },
      ],
    });
    assert.ok(out.endsWith("This session's calendar has CPI at 08:30 ET."));
  });

  it("the barest facts still make a two-sentence lead", () => {
    const bare: NarrativeFacts = {
      ...buildNarrativeFacts(report()),
      markets: [],
      market_groups: allUnavailable,
      vix_level_band: null,
      book_move_pct: null,
      movers: [],
      headlines: [],
      held_headlines: [],
      headline_names: 0,
      risk: null,
      calendar_today: [],
      earnings_today: [],
      corporate_events: [],
      top_weights: [],
    };
    assert.equal(
      text(bare),
      "The overnight market feed is unavailable, so index moves are not listed. Nothing is scheduled in the calendar file for this session.",
    );
  });
});

describe("applyModelStories and storiesFromFacts", () => {
  const rewrite: ModelStory = { id: "story:name:NVDA", what: "NVDA put out its results.", reaction: "Up 2.34% since the close.", meaning: null };

  it("splices rewrites by id, keeps the template order and count, and marks the source", () => {
    const out = applyModelStories([STORY_NVDA, STORY_TAPE], [rewrite, { ...rewrite, id: "story:name:KO" }]);
    assert.deepEqual(out.map((s) => [s.id, s.source]), [["story:name:NVDA", "model"], ["story:market:tape", "template"]]);
    assert.equal(out[0]!.what, rewrite.what);
    assert.equal(out[0]!.reaction, rewrite.reaction);
    assert.deepEqual(out[0]!.reactions, STORY_NVDA.reactions);
    assert.equal(out[0]!.at, STORY_NVDA.at);
    assert.deepEqual(out[1], STORY_TAPE);
  });

  it("is idempotent over its own output and ignores a template-sourced story passed back", () => {
    const once = applyModelStories([STORY_NVDA, STORY_TAPE], [rewrite]);
    assert.deepEqual(applyModelStories([STORY_NVDA, STORY_TAPE], once), once);
    assert.deepEqual(applyModelStories([STORY_NVDA, STORY_TAPE], [STORY_NVDA]), [STORY_NVDA, STORY_TAPE]);
    assert.deepEqual(applyModelStories([STORY_NVDA], []), [STORY_NVDA]);
    assert.deepEqual(applyModelStories([], [rewrite]), []);
  });

  it("rebuilds chipless, undated stories from the facts", () => {
    const facts = buildNarrativeFacts(storied());
    assert.deepEqual(storiesFromFacts(facts), [
      { ...STORY_NVDA, at: null, reactions: [] },
      { ...STORY_TAPE, at: null, reactions: [] },
    ]);
  });
});

describe("generateNarrative", () => {
  const facts = buildNarrativeFacts(storied());
  const factsHash = narrativeFactsHash(facts);
  const opts = { model: BRIEFING_NARRATIVE_MODEL_DEFAULT, now: NOW, factsHash, templateStories: [STORY_NVDA, STORY_TAPE] };
  const GOOD = "NVDA reported results and is up 2.34% since the close, about 1.4 times its normal day. Futures point to a rise of about 0.55% for the book at the open.";
  const REWRITE: ModelStory = {
    id: "story:name:NVDA",
    what: "NVDA put out its results after the close.",
    reaction: "The name is up 2.34% since the close, about 1.4 times its normal day.",
    meaning: null,
  };

  /** Answers from a script, one entry per call, and records what it was asked. */
  function scripted(...answers: Array<string | Error>): NarrativeCaller & { calls: GlossModelInput[] } {
    const calls: GlossModelInput[] = [];
    const fn: NarrativeCaller = async (input) => {
      calls.push(input);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return { text: answer, input_tokens: 100, output_tokens: 50 };
    };
    return Object.assign(fn, { calls });
  }

  const asJson = (lead: string, stories: unknown[] = []): string => JSON.stringify({ lead, stories });

  it("returns the model's lead and its rewrites spliced over the templates, asked for once and without a temperature", async () => {
    const caller = scripted(asJson(GOOD, [REWRITE]));
    const result = await generateNarrative(facts, caller, opts);
    assert.deepEqual(result.narrative, {
      text: GOOD,
      source: "model",
      model: "claude-opus-5",
      generated_at: NOW,
      facts_hash: factsHash,
      pending: false,
      reason: null,
    });
    assert.deepEqual(result.stories.map((s) => [s.id, s.source]), [["story:name:NVDA", "model"], ["story:market:tape", "template"]]);
    assert.equal(result.stories[0]!.what, REWRITE.what);
    assert.deepEqual(result.stories[0]!.reactions, STORY_NVDA.reactions);
    assert.deepEqual(result.stories[1], STORY_TAPE);
    assert.equal(caller.calls.length, 1);
    const input = caller.calls[0]!;
    assert.equal(input.effort, "low");
    assert.equal(input.max_tokens, 2400);
    assert.equal(input.timeout_ms, 25_000);
    assert.equal(input.system, BRIEFING_NARRATIVE_SYSTEM);
    assert.equal(input.user, buildNarrativeUser(facts));
    assert.deepEqual(input.output_schema, BRIEFING_NARRATIVE_SCHEMA);
    assert.ok(!("temperature" in input));
  });

  it("keeps a story's template when its rewrite fails a check, without a second call", async () => {
    const bad = { ...REWRITE, what: "NVDA should rally 5% on this." };
    const caller = scripted(asJson(GOOD, [bad, { id: "story:name:KO", what: "x", reaction: "y", meaning: null }]));
    const result = await generateNarrative(facts, caller, opts);
    assert.equal(result.narrative.source, "model");
    assert.deepEqual(result.stories, [STORY_NVDA, STORY_TAPE]);
    assert.equal(caller.calls.length, 1);
  });

  it("rebuilds the stories from the facts when the caller passes none", async () => {
    const { templateStories: _omitted, ...bare } = opts;
    const result = await generateNarrative(facts, scripted(asJson(GOOD, [REWRITE])), bare);
    assert.deepEqual(result.stories.map((s) => [s.id, s.source, s.reactions.length]), [["story:name:NVDA", "model", 0], ["story:market:tape", "template", 0]]);
  });

  it("passes the caller's own limits through", async () => {
    const caller = scripted(asJson(GOOD));
    await generateNarrative(facts, caller, { ...opts, timeoutMs: 9_000, maxTokens: 800 });
    assert.equal(caller.calls[0]!.timeout_ms, 9_000);
    assert.equal(caller.calls[0]!.max_tokens, 800);
  });

  it("retries once with the reasons, story reasons included, when the lead fails validation", async () => {
    const caller = scripted(asJson("You should buy NVDA now. Futures will rally 5%.", [{ ...REWRITE, reaction: "Up 9.9% since the close." }]), asJson(GOOD, [REWRITE]));
    const result = await generateNarrative(facts, caller, opts);
    assert.equal(result.narrative.source, "model");
    assert.equal(result.narrative.text, GOOD);
    assert.equal(result.stories[0]!.source, "model");
    assert.equal(caller.calls.length, 2);
    const retry = caller.calls[1]!.user;
    assert.ok(retry.startsWith(buildNarrativeUser(facts)));
    assert.ok(retry.includes("rejected"));
    assert.ok(retry.includes("sentence 1 was dropped"));
    assert.ok(retry.includes("a percentage not in the facts (5)"));
    assert.ok(retry.includes("story story:name:NVDA was dropped for"));
    assert.ok(retry.includes("(9.9)"));
  });

  it("gives up after the second failed validation, and everything is the template", async () => {
    const caller = scripted(asJson("You should buy NVDA now.", [REWRITE]));
    const result = await generateNarrative(facts, caller, opts);
    assert.equal(caller.calls.length, 2);
    assert.equal(result.narrative.source, "template");
    assert.equal(result.narrative.reason, "model text failed validation twice");
    assert.equal(result.narrative.text, templateNarrative(facts, NOW, factsHash, null).text);
    assert.deepEqual(result.stories, [STORY_NVDA, STORY_TAPE]);
  });

  it("falls back to the template with a fixed reason when the caller throws", async () => {
    const caller = scripted(new Error("401 invalid x-api-key sk-ant-secret-123 (request req_abc)"));
    const result = await generateNarrative(facts, caller, opts);
    assert.equal(caller.calls.length, 1);
    assert.equal(result.narrative.source, "template");
    assert.equal(result.narrative.model, null);
    assert.equal(result.narrative.reason, "model call failed");
    assert.equal(result.narrative.facts_hash, factsHash);
    assert.equal(result.narrative.generated_at, NOW);
    assert.ok(result.narrative.text.length > 0);
    assert.deepEqual(result.stories, [STORY_NVDA, STORY_TAPE]);
    assert.ok(!JSON.stringify(result).includes("sk-ant"));
  });

  it("names a timeout, a refusal and a missing key without quoting the provider", async () => {
    const reason = async (error: Error) => (await generateNarrative(facts, scripted(error), opts)).narrative.reason;
    assert.equal(await reason(new Error("Request timed out.")), "model call timed out");
    assert.equal(await reason(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), "model call timed out");
    assert.equal(await reason(new Error("the model declined to explain this selection")), "model declined the request");
    assert.equal(await reason(new Error("ANTHROPIC_API_KEY is not configured")), "model is not configured");
  });

  it("does not retry malformed JSON, a missing lead, or the old one-field shape", async () => {
    for (const answer of [
      "Here is your narrative: markets rose.",
      "[]",
      "null",
      JSON.stringify({ lead: 7, stories: [] }),
      JSON.stringify({ lead: "  ", stories: [] }),
      JSON.stringify({ narrative: GOOD }),
    ]) {
      const caller = scripted(answer);
      const result = await generateNarrative(facts, caller, opts);
      assert.equal(caller.calls.length, 1, answer);
      assert.equal(result.narrative.source, "template");
      assert.equal(result.narrative.reason, "model returned no usable JSON");
      assert.deepEqual(result.stories, [STORY_NVDA, STORY_TAPE]);
    }
  });

  it("accepts a lead with a missing story list", async () => {
    const result = await generateNarrative(facts, scripted(JSON.stringify({ lead: GOOD })), opts);
    assert.equal(result.narrative.source, "model");
    assert.deepEqual(result.stories, [STORY_NVDA, STORY_TAPE]);
  });

  it("never throws, whatever the caller does", async () => {
    const callers: NarrativeCaller[] = [
      async () => {
        throw "a bare string";
      },
      async () => undefined as never,
      async () => ({ text: undefined as never, input_tokens: 0, output_tokens: 0 }),
      () => {
        throw new Error("synchronous");
      },
      () => Promise.reject(null),
    ];
    for (const caller of callers) {
      const result = await generateNarrative(facts, caller, opts);
      assert.equal(result.narrative.source, "template");
      assert.ok(result.narrative.reason);
      assert.ok(result.narrative.text.length > 0);
      assert.deepEqual(result.stories, [STORY_NVDA, STORY_TAPE]);
    }
  });
});
