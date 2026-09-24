import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyRuleFaults } from "./narrative.js";
import { MAX_STORIES, deriveStories, type StoryInput } from "./stories.js";
import type {
  BriefingReport,
  CalendarItem,
  HeldFiling,
  HeldMover,
  HeldNewsItem,
  Implication,
  MarketGroup,
  MarketHeadline,
  MarketRow,
  MarketState,
  MarketUnit,
} from "./types.js";

const NOW = "2026-09-22T12:00:00.000Z";
const SINCE = "2026-09-21T20:00:00.000Z";

/** En and em dash, built from code points so the file stays ASCII whatever writes it. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2012, 0x2013, 0x2014, 0x2015)}]`);

function row(symbol: string, label: string, group: MarketGroup, unit: MarketUnit, move: number | null, state: MarketState = "final", last: number | null = 100): MarketRow {
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
    row("000001.SS", "Shanghai Composite", "asia", "pct", -0.2),
    row("^AXJO", "ASX 200", "asia", "pct", -0.9),
    row("^STOXX50E", "Euro Stoxx 50", "europe", "pct", 0.18, "live"),
    row("^GDAXI", "DAX", "europe", "pct", 0.22, "live"),
    row("^FTSE", "FTSE 100", "europe", "pct", -0.1, "live"),
    row("^FCHI", "CAC 40", "europe", "pct", 0.3, "live"),
    row("ES=F", "S&P 500 futures", "us_futures", "pct", 0.42, "live"),
    row("NQ=F", "Nasdaq-100 futures", "us_futures", "pct", 0.61, "live"),
    row("YM=F", "Dow futures", "us_futures", "pct", 0.3, "live"),
    row("RTY=F", "Russell 2000 futures", "us_futures", "pct", -0.2, "live"),
    row("^VIX", "VIX", "macro", "pts", -0.55, "live", 16.85),
    row("^TNX", "US 10-year yield", "macro", "bp", 4, "final", 4.25),
  ];
  return rows.map((r) => ({ ...r, ...(over[r.symbol] ?? {}) }));
}

function mover(ticker: string, move_pct: number, move_z: number | null, over: Partial<HeldMover> = {}): HeldMover {
  return {
    ticker,
    last: 120.5,
    ref_close: 118.1,
    move_pct,
    move_z,
    pnl_usd: 96.4,
    basis: "since_close",
    session: "pre",
    as_of: NOW,
    flag: null,
    beta: 1.2,
    daily_vol_pct: 2.1,
    ...over,
  };
}

function news(ticker: string, band: HeldNewsItem["band"], headline = `${ticker} moves on a headline the wire wrote about it`, over: Partial<HeldNewsItem> = {}): HeldNewsItem {
  return {
    ticker,
    also: [],
    headline,
    source: "wire",
    url: `https://news.example.com/${ticker.toLowerCase()}-${band}`,
    published_at: "2026-09-22T05:00:00.000Z",
    band,
    tags: [],
    incident_id: `inc-${ticker}-${band}`,
    ...over,
  };
}

function filing(ticker: string, label: string, kind: HeldFiling["kind"] = "filing", filed_at = "2026-09-22T00:30:00.000Z"): HeldFiling {
  return { ticker, kind, label, filed_at, url: `https://www.sec.gov/${ticker.toLowerCase()}/${label.replace(/\W+/g, "-").toLowerCase()}` };
}

function headline(id: string, title: string, published_at = "2026-09-22T07:00:00.000Z"): MarketHeadline {
  return { id, title, source: "wire", url: `https://news.example.com/${id}`, published_at, related: ["SPY"], via: "SPY" };
}

function calendarItem(id: string, title: string, time_et: string, at: string, importance: 1 | 2 | 3, kind: CalendarItem["kind"] = "data"): CalendarItem {
  return { id, kind, time_et, at, title, detail: null, importance, tickers: [], source: "curated" };
}

function implication(id: string, kind: Implication["kind"], headline: string, because: string, tickers: string[] = []): Implication {
  return { id, kind, headline, because, scenario: null, scenario_usd: null, book_pct: 0.3, tickers };
}

const OPEN = implication(
  "open_indication:book",
  "open_indication",
  "Overnight futures point to a rise of about 0.38% for the book at the open.",
  "S&P 500 futures are up 0.42% since the close, and the book moves about 0.91% for each 1% the index moves.",
);

const OWN = implication(
  "name_specific:NVDA",
  "name_specific",
  "NVDA's 2.34% rise is its own, not the market's.",
  "The market explains about 0.71% of it, and the report lists 1 headline on NVDA since the close.",
  ["NVDA"],
);

type Over = Omit<Partial<StoryInput>, "overnight"> & { overnight?: Partial<BriefingReport["overnight"]> };

function input(over: Over = {}): StoryInput {
  const { overnight = {}, ...rest } = over;
  return {
    generated_at: NOW,
    window: {
      target_session_ymd: "2026-09-22",
      prev_session_ymd: "2026-09-21",
      overnight_since: SINCE,
      window_opens_at: "2026-09-22T00:00:00.000Z",
      target_open_at: "2026-09-22T13:30:00.000Z",
      target_close_at: "2026-09-22T20:00:00.000Z",
      phase: "pre_open",
      auto_show: true,
      handover: "overnight",
      early_close: false,
    },
    overnight: { markets: markets(), held_movers: [], held_news: [], filings: [], measurements: [], ...overnight },
    held_coverage: [{ ticker: "NVDA", coverage: "tracked" }],
    book: {
      position_count: 1,
      equity_usd: 10_000,
      cash_usd: 1000,
      invested_usd: 9000,
      net_exposure_pct: 90,
      gross_exposure_pct: 90,
      overnight_pnl_usd: 12,
      overnight_pnl_pct: 0.12,
      top_weights: [{ ticker: "NVDA", weight: 1, side: "long" }],
      unpriced: [],
      priced_at: NOW,
    },
    headlines: [headline("h1", "Equity futures edge higher before the bell as oil extends its climb"), headline("h2", "Treasury yields hold near last week's highs into a busy data calendar"), headline("h3", "Gold steadies after a record run as the dollar firms")],
    implications: [],
    calendar_today: [],
    earnings_next: [],
    ...rest,
  };
}

const FORBIDDEN_WORDS = [
  "buy", "sell", "enter", "exit", "long", "short", "add", "trim", "target", "stop", "take profit", "signal",
  "prediction", "recommend", "reduce", "consider", "should", "will", "expect", "forecast", "predict", "likely", "may",
];

/** The COPY RULES, checked without leaning on the module's own checker alone. */
function assertCopyClean(text: string): void {
  assert.ok(!DASHES.test(text), `dash in: ${text}`);
  assert.ok(!text.includes("$"), `dollar in: ${text}`);
  for (const word of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${word}(?:s|es|d|ed|ing)?\\b`, "i");
    assert.ok(!re.test(text), `"${word}" in: ${text}`);
  }
  assert.deepEqual(copyRuleFaults(text), [], text);
  // Percentages carry a % sign and at most two decimals.
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|percent|pct)/gi)) {
    assert.equal(m[2], "%", text);
    assert.ok(!/\.\d{3,}/.test(m[1]!), `too many decimals in: ${text}`);
  }
}

function sentences(input: StoryInput): string[] {
  return deriveStories(input).flatMap((s) => [s.what, s.reaction, s.meaning ?? ""]).filter((t) => t !== "");
}

describe("deriveStories: scope name", () => {
  it("tells a results filing as 'reported results', with the move as the reaction", () => {
    const stories = deriveStories(
      input({
        overnight: {
          held_movers: [mover("NVDA", 2.34, 1.4)],
          filings: [filing("NVDA", "8-K, items 2.02, 9.01 (results of operations)")],
        },
        implications: [OWN],
      }),
    );
    const own = stories.find((s) => s.id === "story:name:NVDA")!;
    assert.equal(own.scope, "name");
    assert.equal(own.what, "NVDA reported results");
    assert.equal(own.reaction, "NVDA is up 2.34% since the close, 1.4 times its normal day and the market explains about 0.71% of it");
    assert.equal(own.meaning, OWN.headline);
    assert.equal(own.at, "2026-09-22T00:30:00.000Z");
    assert.deepEqual(own.tickers, ["NVDA"]);
    assert.deepEqual(own.reactions, [{ label: "NVDA", symbol: "NVDA", move: 2.34, unit: "pct" }]);
    assert.deepEqual(own.evidence, ["https://www.sec.gov/nvda/8-k-items-2-02-9-01-results-of-operations-", "mover:NVDA", "name_specific:NVDA"]);
    assert.equal(own.source, "template");
    // Results lead the list, ahead of the tape.
    assert.equal(stories[0]!.id, "story:name:NVDA");
  });

  it("reads a label that mentions results, and a Form 4 as an insider filing", () => {
    const results = deriveStories(input({ overnight: { filings: [filing("KO", "Quarterly results release")] } }));
    assert.equal(results.find((s) => s.id === "story:name:KO")?.what, "KO reported results");
    const insider = deriveStories(input({ overnight: { filings: [filing("KO", "Insider filing (Form 4)", "insider")] } }));
    const story = insider.find((s) => s.id === "story:name:KO")!;
    assert.equal(story.what, "KO has an insider filing");
    assert.equal(story.reaction, "KO has no usable quote since the close");
    assert.deepEqual(story.reactions, []);
    assert.equal(story.meaning, null);
  });

  it("counts headlines instead of quoting them, and only a P0/P1 headline earns a story by itself", () => {
    const loud = deriveStories(
      input({
        overnight: {
          held_movers: [mover("NVDA", 0.4, 0.2)],
          held_news: [news("NVDA", "P1"), news("NVDA", "P3", "A second, quieter item", { url: "https://news.example.com/nvda-2", incident_id: "inc-2" })],
        },
      }),
    );
    const story = loud.find((s) => s.id === "story:name:NVDA")!;
    assert.equal(story.what, "NVDA is in the news since the close (2 headlines)");
    assert.equal(story.reaction, "NVDA is up 0.4% since the close, 0.2 times its normal day");
    assert.deepEqual(story.evidence, ["inc-NVDA-P1", "inc-2", "mover:NVDA"]);
    assert.equal(story.at, "2026-09-22T05:00:00.000Z");

    const quiet = deriveStories(input({ overnight: { held_movers: [mover("NVDA", 0.4, 0.2)], held_news: [news("NVDA", "P2")] } }));
    assert.ok(!quiet.some((s) => s.scope === "name"));
  });

  it("reaches every held name a shared article names, and ignores a headline from before the close", () => {
    const stories = deriveStories(
      input({
        overnight: {
          held_news: [
            news("NVDA", "P1", "Chip export rules widen", { also: ["AAPL"] }),
            news("KO", "P0", "Old news", { published_at: "2026-09-21T15:00:00.000Z" }),
          ],
        },
      }),
    );
    assert.deepEqual(stories.filter((s) => s.scope === "name").map((s) => s.id), ["story:name:AAPL", "story:name:NVDA"]);
    assert.equal(stories[0]!.what, "AAPL is in the news since the close (1 headline)");
  });

  it("tells a filing whose item says nothing by name as a new filing, without its item text", () => {
    const stories = deriveStories(input({ overnight: { filings: [filing("NVDA", "8-K, items 7.01, 9.01 (Regulation FD disclosure)")] } }));
    assert.equal(stories.find((s) => s.id === "story:name:NVDA")?.what, "NVDA filed a new 8-K since the close");
  });

  it("gives a move its own story at 1% or 1.5 normal days, and stays quiet under both", () => {
    const own = (move_pct: number, move_z: number | null) =>
      deriveStories(input({ overnight: { held_movers: [mover("NVDA", move_pct, move_z)] } })).find((s) => s.id === "story:name:NVDA");
    assert.equal(own(1, 0.3)?.what, "NVDA moved on its own since the close");
    assert.equal(own(-1, null)?.reaction, "NVDA is down 1% since the close");
    assert.equal(own(0.4, 1.5)?.reaction, "NVDA is up 0.4% since the close, 1.5 times its normal day");
    assert.equal(own(0.99, 1.49), undefined);
    assert.equal(own(0.99, null), undefined);
    assert.equal(own(0.02, 0.01), undefined);
  });

  it("never draws a story from a flagged move, and withholds its reaction when a headline names it", () => {
    const flagged = mover("NVDA", -48, -9, { flag: "corporate_action_check" });
    assert.ok(!deriveStories(input({ overnight: { held_movers: [flagged] } })).some((s) => s.scope === "name"));
    const named = deriveStories(input({ overnight: { held_movers: [flagged], held_news: [news("NVDA", "P1")] } })).find((s) => s.id === "story:name:NVDA")!;
    assert.equal(named.reaction, "NVDA's move since the close is withheld while a split or other corporate action is checked");
    assert.deepEqual(named.reactions, []);
  });

  it("omits the market's share unless the conclusion states it as a figure", () => {
    const none = implication("name_specific:NVDA", "name_specific", "NVDA's 2.34% rise is its own, not the market's.", "The market explains almost none of it, and no headline on NVDA since the close accounts for it.", ["NVDA"]);
    const story = deriveStories(input({ overnight: { held_movers: [mover("NVDA", 2.34, 1.4)] }, implications: [none] })).find((s) => s.id === "story:name:NVDA")!;
    assert.equal(story.reaction, "NVDA is up 2.34% since the close, 1.4 times its normal day");
    assert.equal(story.meaning, none.headline);
    assert.ok(story.evidence.includes("name_specific:NVDA"));
  });
});

describe("deriveStories: scope market", () => {
  it("tells the tape once, with the futures and the VIX as the reaction and the open indication as the meaning", () => {
    const tape = deriveStories(input({ implications: [OPEN] })).find((s) => s.id === "story:market:tape")!;
    assert.equal(tape.scope, "market");
    assert.equal(tape.at, null);
    assert.equal(tape.what, "Overnight, the tape has 3 market headlines");
    assert.equal(tape.reaction, "S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close; VIX down 0.55 pts at 16.85");
    assert.equal(tape.meaning, OPEN.headline);
    assert.deepEqual(tape.tickers, []);
    assert.deepEqual(tape.evidence, ["ES=F", "NQ=F", "h1", "h2", "h3", "open_indication:book"]);
    assert.deepEqual(
      tape.reactions.map((r) => [r.symbol, r.move, r.unit]),
      [
        ["ES=F", 0.42, "pct"],
        ["NQ=F", 0.61, "pct"],
        ["^VIX", -0.55, "pts"],
      ],
    );
  });

  it("names the night by the handover, and says quiet, or unread, when there is no headline", () => {
    assert.equal(deriveStories(input({ headlines: [headline("h1", "One")] }))[0]!.what, "Overnight, the tape has 1 market headline");
    const base = input({ headlines: [] });
    assert.equal(deriveStories(base)[0]!.what, "Overnight, the tape is quiet: no market headline since the close");
    assert.equal(deriveStories({ ...base, market_news_unavailable: true })[0]!.what, "Overnight, the market headlines could not be read for this report");
    assert.equal(deriveStories({ ...base, window: { ...base.window, handover: "weekend" } })[0]!.what, "Over the weekend, the tape is quiet: no market headline since the close");
    assert.equal(deriveStories({ ...base, window: { ...base.window, handover: "holiday" } })[0]!.what, "Over the holiday break, the tape is quiet: no market headline since the close");
    // Once the session is open the count runs into the morning's trading too, so "overnight" stops being true.
    assert.equal(deriveStories({ ...base, window: { ...base.window, phase: "in_session" } })[0]!.what, "Since the close, the tape is quiet: no market headline since the close");
  });

  it("uses whichever US contract printed, and tells no tape story when neither did", () => {
    const nqOnly = deriveStories(input({ overnight: { markets: markets({ "ES=F": { state: "stale", move: null }, "^VIX": { state: "stale", move: null } }) }, implications: [OPEN] }));
    const tape = nqOnly.find((s) => s.id === "story:market:tape")!;
    assert.equal(tape.reaction, "Nasdaq-100 futures are up 0.61% since the close");
    assert.deepEqual(tape.evidence.slice(0, 1), ["NQ=F"]);

    const gap = implication("data_gap:futures", "data_gap", "S&P 500 futures carry no move since the close, so the open cannot be sized from them.", "Other US futures have printed.");
    assert.equal(deriveStories(input({ overnight: { markets: markets({ "ES=F": { state: "stale", move: null } }) }, implications: [gap] }))[0]!.meaning, gap.headline);

    const none = deriveStories(input({ overnight: { markets: markets({ "ES=F": { state: "unavailable", move: null, last: null }, "NQ=F": { state: "stale", move: null } }) } }));
    assert.ok(!none.some((s) => s.id === "story:market:tape"));
  });

  it("tells a region as one story only when every row is final and moved the same way past 1% on average", () => {
    const down = { "^N225": { move: -1.4 }, "^HSI": { move: -1.1 }, "000001.SS": { move: -0.7 }, "^AXJO": { move: -0.9 } };
    const asia = deriveStories(input({ overnight: { markets: markets(down) } })).find((s) => s.id === "story:market:asia")!;
    assert.equal(asia.what, "Asia closed lower across the board");
    assert.equal(asia.reaction, "Nikkei 225 down 1.4%, Hang Seng down 1.1%, Shanghai Composite down 0.7% and ASX 200 down 0.9%");
    assert.deepEqual(asia.evidence, ["^N225", "^HSI", "000001.SS", "^AXJO"]);
    assert.equal(asia.reactions.length, 4);
    assert.equal(asia.meaning, null);

    const region = (over: Record<string, Partial<MarketRow>>) => deriveStories(input({ overnight: { markets: markets(over) } })).find((s) => s.id === "story:market:asia");
    // Mixed direction, too small on average, one row withheld, one row still trading: no story.
    assert.equal(region({ ...down, "^HSI": { move: 1.1 } }), undefined);
    assert.equal(region({ "^N225": { move: -1.4 }, "^HSI": { move: -1.1 }, "000001.SS": { move: -0.7 }, "^AXJO": { move: -0.7 } }), undefined);
    assert.equal(region({ ...down, "^AXJO": { state: "stale", move: null } }), undefined);
    assert.equal(region({ ...down, "^AXJO": { state: "live" } }), undefined);
    // Exactly 1% on average clears the bar.
    assert.ok(region({ "^N225": { move: -1 }, "^HSI": { move: -1 }, "000001.SS": { move: -1 }, "^AXJO": { move: -1 } }));
  });

  it("says a region still trading is trading, not closed", () => {
    const up = { "^STOXX50E": { move: 1.2 }, "^GDAXI": { move: 1.5 }, "^FTSE": { move: 0.9 }, "^FCHI": { move: 1.1 } };
    const europe = deriveStories(input({ overnight: { markets: markets(up) } })).find((s) => s.id === "story:market:europe")!;
    assert.equal(europe.what, "Europe is trading higher across the board");
  });
});

describe("deriveStories: scope release", () => {
  const cpi = calendarItem("macro:2026-09-22:CPI", "CPI", "08:30", "2026-09-22T12:30:00.000Z", 3);
  const claims = calendarItem("macro:2026-09-22:CLAIMS", "Initial jobless claims", "08:30", "2026-09-22T12:30:00.000Z", 2);
  const fomc = calendarItem("macro:2026-09-22:FOMC", "FOMC rate decision", "14:00", "2026-09-22T18:00:00.000Z", 3, "fomc");
  const minor = calendarItem("macro:2026-09-22:WHOLESALE", "Wholesale inventories", "07:00", "2026-09-22T11:00:00.000Z", 1);

  it("tells a release that has printed, with the futures since the close as its reaction", () => {
    const at = "2026-09-22T13:00:00.000Z";
    const stories = deriveStories(input({ generated_at: at, calendar_today: [fomc, cpi, claims, minor] }));
    const printed = stories.filter((s) => s.scope === "release");
    assert.deepEqual(printed.map((s) => s.id), ["story:release:macro:2026-09-22:CLAIMS", "story:release:macro:2026-09-22:CPI"]);
    assert.equal(printed[1]!.what, "CPI printed at 08:30 ET");
    assert.equal(printed[1]!.reaction, "S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close; VIX down 0.55 pts at 16.85");
    assert.equal(printed[1]!.at, "2026-09-22T12:30:00.000Z");
    assert.deepEqual(printed[1]!.evidence, ["macro:2026-09-22:CPI"]);
    assert.equal(printed[1]!.meaning, null);
    // The FOMC is still ahead at 09:00 ET, and the importance-1 print never qualifies.
    assert.ok(!stories.some((s) => s.id.endsWith("FOMC") || s.id.endsWith("WHOLESALE")));
  });

  it("says a rate decision landed, and takes its meaning from the sensitivity that names it", () => {
    const sensitivity = implication("event_sensitivity:macro:2026-09-22:FOMC", "event_sensitivity", "FOMC rate decision at 14:00 ET is the first top-tier release ahead this session.", "It lands mid-session.");
    const story = deriveStories(input({ generated_at: "2026-09-22T18:30:00.000Z", calendar_today: [fomc], implications: [sensitivity] })).find((s) => s.scope === "release")!;
    assert.equal(story.what, "FOMC rate decision landed at 14:00 ET");
    assert.equal(story.meaning, sensitivity.headline);
  });

  it("stays quiet at the print time itself, and for an untimed item", () => {
    assert.ok(!deriveStories(input({ generated_at: "2026-09-22T12:30:00.000Z", calendar_today: [cpi] })).some((s) => s.scope === "release"));
    const untimed: CalendarItem = { ...cpi, time_et: null, at: null };
    assert.ok(!deriveStories(input({ generated_at: "2026-09-22T13:00:00.000Z", calendar_today: [untimed] })).some((s) => s.scope === "release"));
  });

  it("says the futures carry no move when none printed", () => {
    const story = deriveStories(
      input({
        generated_at: "2026-09-22T13:00:00.000Z",
        calendar_today: [cpi],
        overnight: { markets: markets({ "ES=F": { state: "stale", move: null }, "NQ=F": { state: "stale", move: null } }) },
      }),
    ).find((s) => s.scope === "release")!;
    assert.equal(story.reaction, "US futures carry no move since the close");
    assert.deepEqual(story.reactions, []);
  });
});

describe("deriveStories: ranking and shape", () => {
  it("ranks results and top-band names first, then the tape, then regions, then releases, then the rest by move", () => {
    const stories = deriveStories(
      input({
        generated_at: "2026-09-22T13:00:00.000Z",
        overnight: {
          markets: markets({ "^N225": { move: -1.4 }, "^HSI": { move: -1.1 }, "000001.SS": { move: -1.2 }, "^AXJO": { move: -0.9 } }),
          held_movers: [mover("TSLA", -3.9, -1.9), mover("NVDA", 0.5, 0.2), mover("KO", 1.2, 0.8), mover("AAPL", -2.5, -1.7)],
          held_news: [news("NVDA", "P1"), news("AAPL", "P0")],
          filings: [filing("KO", "8-K, items 2.02, 9.01 (results of operations)")],
        },
        calendar_today: [calendarItem("macro:2026-09-22:CPI", "CPI", "08:30", "2026-09-22T12:30:00.000Z", 3)],
      }),
    );
    assert.deepEqual(stories.map((s) => s.id), [
      "story:name:KO",
      "story:name:AAPL",
      "story:name:NVDA",
      "story:market:tape",
      "story:market:asia",
      "story:release:macro:2026-09-22:CPI",
    ]);
    assert.equal(stories.length, MAX_STORIES);
    // TSLA's own move ranks behind everything with a headline or a filing and falls off the cap.
    assert.ok(!stories.some((s) => s.id === "story:name:TSLA"));
  });

  it("puts the remaining names after the releases, largest move first", () => {
    const stories = deriveStories(
      input({
        generated_at: "2026-09-22T13:00:00.000Z",
        overnight: { held_movers: [mover("KO", 1.2, 0.8), mover("TSLA", -3.9, -1.9)] },
        calendar_today: [calendarItem("macro:2026-09-22:CPI", "CPI", "08:30", "2026-09-22T12:30:00.000Z", 3)],
      }),
    );
    assert.deepEqual(stories.map((s) => s.id), ["story:market:tape", "story:release:macro:2026-09-22:CPI", "story:name:TSLA", "story:name:KO"]);
  });

  it("ids are scope plus subject, and every story carries the contract's fields", () => {
    for (const s of deriveStories(input({ overnight: { held_movers: [mover("NVDA", 2, 1)] }, implications: [OPEN] }))) {
      assert.match(s.id, /^story:(name|market|release):.+$/);
      assert.ok(s.id.startsWith(`story:${s.scope}:`));
      assert.equal(typeof s.what, "string");
      assert.equal(typeof s.reaction, "string");
      assert.ok(s.meaning === null || typeof s.meaning === "string");
      assert.ok(Array.isArray(s.tickers) && Array.isArray(s.evidence) && Array.isArray(s.reactions));
      assert.equal(s.source, "template");
    }
  });

  it("returns [] for an empty or unreadable input without throwing", () => {
    assert.deepEqual(deriveStories({} as StoryInput), []);
    assert.deepEqual(deriveStories(null as unknown as StoryInput), []);
    assert.deepEqual(deriveStories({ generated_at: "nope", window: {}, overnight: {} } as unknown as StoryInput), []);
    const bare = input({ overnight: { markets: [] }, headlines: [] });
    assert.deepEqual(deriveStories(bare), []);
  });

  it("gives the same list for the same input", () => {
    const twice = [0, 1].map(() => deriveStories(input({ overnight: { held_movers: [mover("NVDA", 2, 1)], held_news: [news("NVDA", "P1")] }, implications: [OPEN, OWN] })));
    assert.deepEqual(twice[0], twice[1]);
  });
});

describe("deriveStories: copy rules", () => {
  it("never repeats a third-party headline, or any long piece of one, in a template sentence", () => {
    const titles = [
      "Equity futures edge higher before the bell as oil extends its climb",
      "Treasury yields hold near last week's highs into a busy data calendar",
      "Gold steadies after a record run as the dollar firms",
      "Nvidia wins a sovereign chip order worth billions, sources say",
    ];
    const built = input({
      headlines: titles.slice(0, 3).map((t, i) => headline(`h${i}`, t)),
      overnight: {
        held_movers: [mover("NVDA", 2.34, 1.4)],
        held_news: [news("NVDA", "P0", titles[3]!)],
        filings: [filing("NVDA", "8-K, items 2.02, 9.01 (results of operations)")],
      },
      implications: [OPEN, OWN],
    });
    const texts = sentences(built);
    assert.ok(texts.length >= 4);
    for (const text of texts) {
      for (const title of titles) {
        assert.ok(!text.toLowerCase().includes(title.toLowerCase()), `${title} in: ${text}`);
        // Nor any four consecutive words of one.
        const words = title.split(" ");
        for (let i = 0; i + 4 <= words.length; i++) {
          assert.ok(!text.toLowerCase().includes(words.slice(i, i + 4).join(" ").toLowerCase()), `${title} in: ${text}`);
        }
      }
    }
  });

  it("stays inside the copy rules over a randomized sweep, with a dollar in every third-party string", () => {
    // A small deterministic generator, so a failure is reproducible from its case number.
    let seed = 20260922;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const tickers = ["NVDA", "AAPL", "KO", "ADD", "STOP", "BUY", "TGT", "LONG"];
    const bands: HeldNewsItem["band"][] = ["P0", "P1", "P2", "P3"];
    const states: MarketState[] = ["live", "final", "stale", "unavailable"];
    const labels = [
      "8-K, items 2.02, 9.01 (results of operations)",
      "8-K, items 7.01, 9.01 (Regulation FD disclosure)",
      "Insider filing (Form 4)",
      "10-Q",
      "Results for the quarter, $2B buyback",
    ];
    const seen = new Set<string>();
    for (let n = 0; n < 400; n++) {
      const movers: HeldMover[] = [];
      const items: HeldNewsItem[] = [];
      const filings: HeldFiling[] = [];
      for (const t of tickers) {
        if (rand() < 0.6) movers.push(mover(t, Math.round((rand() * 12 - 6) * 100) / 100, rand() < 0.3 ? null : Math.round((rand() * 6 - 3) * 100) / 100, { flag: rand() < 0.1 ? "corporate_action_check" : null }));
        if (rand() < 0.4) items.push(news(t, pick(bands), `${t} $3B headline about a target price and a buy rating`, { also: rand() < 0.3 ? [pick(tickers)] : [] }));
        if (rand() < 0.3) filings.push(filing(t, pick(labels), rand() < 0.2 ? "insider" : "filing"));
      }
      const over: Record<string, Partial<MarketRow>> = {};
      for (const symbol of ["^N225", "^HSI", "000001.SS", "^AXJO", "^STOXX50E", "^GDAXI", "^FTSE", "^FCHI", "ES=F", "NQ=F", "^VIX"]) {
        const state = pick(states);
        const withheld = state === "stale" || state === "unavailable";
        over[symbol] = { state, move: withheld ? null : Math.round((rand() * 6 - 3) * 100) / 100, last: state === "unavailable" ? null : Math.round(rand() * 4000) / 100 };
      }
      const now = pick(["2026-09-22T11:00:00.000Z", "2026-09-22T13:00:00.000Z", "2026-09-22T18:30:00.000Z"]);
      const built = input({
        generated_at: now,
        window: { ...input().window, handover: pick(["overnight", "weekend", "holiday"]) },
        overnight: { markets: markets(over), held_movers: movers, held_news: items, filings },
        headlines: Array.from({ length: Math.floor(rand() * 5) }, (_, i) => headline(`h${i}`, `Stocks $ should buy the dip, analysts say ${i}`)),
        implications: rand() < 0.5 ? [OPEN, OWN] : [],
        calendar_today: [
          calendarItem("macro:2026-09-22:CPI", "CPI", "08:30", "2026-09-22T12:30:00.000Z", 3),
          calendarItem("macro:2026-09-22:FOMC", "FOMC rate decision", "14:00", "2026-09-22T18:00:00.000Z", 3, "fomc"),
        ],
        market_news_unavailable: rand() < 0.2,
      });
      const stories = deriveStories(built);
      assert.ok(stories.length <= MAX_STORIES, `case ${n}`);
      for (const s of stories) seen.add(s.scope);
      for (const text of stories.flatMap((s) => [s.what, s.reaction, s.meaning ?? ""]).filter((t) => t !== "")) {
        // A ticker that spells a forbidden word is a name, not advice: masked as the validator masks it.
        let masked = text;
        for (const t of tickers) masked = masked.replaceAll(t, "Xx");
        try {
          assertCopyClean(masked);
        } catch (err) {
          throw new Error(`case ${n}: ${(err as Error).message}`);
        }
        assert.ok(!text.includes("3B") && !text.includes("buyback") && !text.includes("analysts"), `case ${n}: third-party text in: ${text}`);
      }
    }
    assert.deepEqual([...seen].sort(), ["market", "name", "release"]);
  });
});
