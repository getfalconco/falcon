import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTradingDays, nyWallTimeToUtc } from "../tracker/calendar.js";
import { MAX_IMPLICATIONS, deriveImplications, type ImplicationInput, type ImplicationPosition } from "./implications.js";
import { buildNarrativeFacts, copyRuleFaults, templateNarrative, validateNarrative } from "./narrative.js";
import type {
  BriefingReport,
  BriefingRisk,
  CalendarItem,
  CorporateEvent,
  HeldCoverage,
  HeldEarnings,
  HeldMover,
  HeldNewsItem,
  Implication,
  ImplicationKind,
  IndexFamily,
  MarketRow,
  MarketState,
} from "./types.js";
import { resolveBriefingWindow } from "./window.js";

/** Tuesday 2026-09-22, 07:30 ET: before the open. */
const PRE = "2026-09-22T11:30:00.000Z";
/** 11:00 ET the same day. */
const IN_SESSION = "2026-09-22T15:00:00.000Z";
/** 18:00 ET the same day: the report hands over to Wednesday. */
const BETWEEN = "2026-09-22T22:00:00.000Z";
/**
 * Sunday 2026-09-27, 21:00 ET: the window is open and the phase is already
 * pre_open, while New York's date is still the day before Monday's session.
 */
const EVENING = "2026-09-28T01:00:00.000Z";

/** Figure dash to horizontal bar, built from code points so this file stays ASCII. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2012)}-${String.fromCharCode(0x2015)}]`);

// ---------------------------------------------------------------------------
// A small world: five names, 100,000 of equity, 20,000 of it cash
// ---------------------------------------------------------------------------

type NameSpec = {
  value: number;
  beta?: number | null;
  vol?: number | null;
  /** Defaults to what the market explains (index move times beta), so the name has no story of its own. */
  move?: number;
  z?: number | null;
  flag?: HeldMover["flag"];
  coverage?: HeldCoverage;
};

type SceneOptions = {
  now?: string;
  names?: Record<string, NameSpec>;
  cash?: number;
  /** The S&P 500 futures move; null leaves the row without one. */
  es?: number | null;
  futures?: MarketState;
  risk?: Partial<BriefingRisk> | null;
  /**
   * The effective book beta the risk snapshot stands for. The engine reads the
   * snapshot's signed, cash-free `beta_port` and applies this book's own
   * invested fraction, so the scene states the beta it wants and works back to
   * the figure a snapshot of this book would carry.
   */
  beta?: number | null;
  pnl?: number | null;
  /** Held names the book could find no price for: carried at cost. */
  unpriced?: string[];
  /** Held names left out of the book's overnight figure: a split in the window, or no pair of prices. */
  pnl_excluded?: string[];
};

type Scene = { input: ImplicationInput; positions: ImplicationPosition[] };

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function fiveNames(over: Record<string, Partial<NameSpec>> = {}): Record<string, NameSpec> {
  const names: Record<string, NameSpec> = {};
  for (const ticker of ["NVDA", "AAPL", "MSFT", "KO", "JNJ"]) names[ticker] = { value: 16_000, ...over[ticker] };
  return names;
}

function futuresRows(es: number | null, state: MarketState): MarketRow[] {
  const fresh = state === "live" || state === "final";
  const row = (symbol: string, label: string, move: number | null): MarketRow => ({
    symbol,
    label,
    group: "us_futures",
    last: state === "unavailable" ? null : 5000,
    prev_close: state === "unavailable" ? null : 5000,
    move: fresh ? move : null,
    unit: "pct",
    basis: "prior_settle",
    state,
    as_of: state === "unavailable" ? null : "2026-09-22T11:00:00.000Z",
  });
  const scaled = (k: number): number | null => (es === null ? null : round(es * k, 2));
  return [
    row("ES=F", "S&P 500 futures", es),
    row("NQ=F", "Nasdaq-100 futures", scaled(1.2)),
    row("YM=F", "Dow futures", scaled(0.8)),
    row("RTY=F", "Russell 2000 futures", scaled(0.6)),
  ];
}

function scene(o: SceneOptions = {}): Scene {
  const now = o.now ?? PRE;
  const window = resolveBriefingWindow(new Date(now));
  const names = o.names ?? fiveNames();
  const es = o.es === undefined ? 1 : o.es;
  const cash = o.cash ?? 20_000;
  const entries = Object.entries(names);

  const invested = entries.reduce((sum, [, n]) => sum + Math.abs(n.value), 0);
  const equity = cash + entries.reduce((sum, [, n]) => sum + n.value, 0);
  const top_weights = entries
    .filter(([, n]) => n.value !== 0)
    .sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value) || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([ticker, n]) => ({ ticker, weight: round(Math.abs(n.value) / invested, 4), side: n.value > 0 ? ("long" as const) : ("short" as const) }));

  const held_movers: HeldMover[] = entries.map(([ticker, n]) => {
    const beta = n.beta === undefined ? 1 : n.beta;
    const vol = n.vol === undefined ? 1.5 : n.vol;
    const move = n.move ?? (es !== null && beta !== null ? round(es * beta, 2) : 0);
    return {
      ticker,
      last: 100,
      ref_close: 100,
      move_pct: move,
      move_z: n.z !== undefined ? n.z : vol === null ? null : round(move / vol, 2),
      pnl_usd: 0,
      basis: window.phase === "in_session" ? "today" : "since_close",
      session: "pre",
      as_of: now,
      flag: n.flag ?? null,
      beta,
      daily_vol_pct: vol,
    };
  });

  const effective = o.beta === undefined ? 0.9 : o.beta;
  const investedFraction = equity > 0 ? invested / equity : 0;
  const risk: BriefingRisk | null =
    o.risk === null
      ? null
      : {
          score: 50,
          band: "moderate",
          driver_component: null,
          driver_sentence: null,
          // An absolute value the engine does not read, kept because the risk
          // snapshot carries it and a fixture that dropped it would not be one.
          beta_eff: effective === null ? null : Math.abs(effective),
          beta_port: effective === null || investedFraction === 0 ? null : round(effective / investedFraction, 6),
          port_vol_daily_pct: 1.2,
          computed_at: now,
          matches_book: true,
          ...o.risk,
        };

  return {
    positions: entries.map(([ticker, n]) => ({ ticker, market_value: n.value })),
    input: {
      generated_at: now,
      window,
      overnight: {
        markets: futuresRows(es, o.futures ?? "live"),
        held_movers,
        held_news: [],
        filings: [],
        measurements: [],
      },
      held_coverage: entries.map(([ticker, n]) => ({ ticker, coverage: n.coverage ?? "tracked" })),
      book: {
        position_count: entries.length,
        equity_usd: equity,
        cash_usd: cash,
        invested_usd: invested,
        net_exposure_pct: equity > 0 ? round(((equity - cash) / equity) * 100, 2) : 0,
        gross_exposure_pct: equity > 0 ? round((invested / equity) * 100, 2) : 0,
        overnight_pnl_usd: null,
        overnight_pnl_pct: o.pnl ?? null,
        top_weights,
        unpriced: o.unpriced ?? [],
        pnl_excluded: o.pnl_excluded ?? o.unpriced ?? [],
        priced_at: now,
      },
      risk,
      earnings_next: [],
      corporate_events: [],
      calendar_today: [],
    },
  };
}

function withInput(s: Scene, patch: Partial<ImplicationInput>): Scene {
  return { ...s, input: { ...s.input, ...patch } };
}

function derive(s: Scene): Implication[] {
  return deriveImplications(s.input, s.positions);
}

function ofKind(s: Scene, kind: ImplicationKind): Implication[] {
  return derive(s).filter((i) => i.kind === kind);
}

function one(s: Scene, kind: ImplicationKind): Implication {
  const found = ofKind(s, kind);
  assert.equal(found.length, 1, `${kind}: ${JSON.stringify(derive(s).map((i) => i.id))}`);
  return found[0]!;
}

function news(ticker: string, published_at: string, also: string[] = []): HeldNewsItem {
  return {
    ticker,
    also,
    headline: `${ticker} update`,
    source: "wire",
    url: `https://news.example.com/${ticker}/${published_at}`,
    published_at,
    band: "P2",
    tags: [],
    incident_id: `inc-${ticker}-${published_at}`,
  };
}

function release(id: string, kind: "fomc" | "data", time_et: string, title: string, importance: 1 | 2 | 3 = 3, ymd = "2026-09-22"): CalendarItem {
  const [hh, mm] = time_et.split(":").map(Number);
  return { id, kind, time_et, at: nyWallTimeToUtc(ymd, hh!, mm!).toISOString(), title, detail: null, importance, tickers: [], source: "curated" };
}

const CPI = release("macro:CPI:2026-09-22", "data", "08:30", "Consumer Price Index");
const FOMC = release("macro:FOMC:2026-09-22", "fomc", "14:00", "FOMC rate decision");

function earnings(ticker: string, sessions_until: number, over: Partial<HeldEarnings> = {}): HeldEarnings {
  return {
    ticker,
    due_ymd: addTradingDays("2026-09-22", sessions_until),
    timing: "amc_or_unspecified",
    sessions_until,
    fiscal_period: null,
    confirmed: true,
    source: "tracker",
    ...over,
  };
}

function rebalance(family: IndexFamily, date: string, sessions_until: number, affects_held: string[], title: string): CorporateEvent {
  return {
    id: `reb:${family}:${date}`,
    kind: "rebalance",
    date,
    sessions_until,
    ticker: null,
    index: family,
    title,
    detail: "Scheduled, per index methodology.",
    affects_held,
    certainty: "rule",
    source: "rule",
  };
}

function dividend(ticker: string, date: string): CorporateEvent {
  return {
    id: `div:${ticker}:${date}`,
    kind: "dividend",
    date,
    sessions_until: 0,
    ticker,
    index: null,
    title: `${ticker} ex-dividend date`,
    detail: "Shares held before this date carry the payment.",
    affects_held: [ticker],
    certainty: "confirmed",
    source: "yahoo_calendar",
  };
}

// ---------------------------------------------------------------------------
// Copy rules, checked without leaning on the engine's own checker alone
// ---------------------------------------------------------------------------

const FORBIDDEN_WORDS = [
  "buy", "sell", "enter", "exit", "long", "short", "add", "trim", "target", "stop", "take profit", "signal",
  "prediction", "recommend", "reduce", "consider", "should", "will", "expect", "forecast", "predict", "likely", "may",
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]]/g, (c) => `[${c}]`);
}

/** Tickers are identifiers, not copy: a held "ADD" is not the word. */
function masked(text: string, tickers: string[]): string {
  let out = text;
  for (const t of tickers) if (t) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegex(t)}(?![A-Za-z0-9])`, "g"), "Xx");
  return out;
}

function copyFaults(text: string, tickers: string[]): string[] {
  const faults: string[] = [];
  if (text.includes("$")) faults.push("dollar sign");
  if (DASHES.test(text)) faults.push("dash");
  if (/NaN|Infinity|undefined|null|\[object/.test(text)) faults.push("leaked value");
  const clean = masked(text, tickers);
  const monthless = clean.replace(/May (?=\d)/g, "Mmm ");
  for (const word of FORBIDDEN_WORDS) {
    if (new RegExp(`(?<![A-Za-z])${word}(?:s|es|d|ed|ing)?(?![A-Za-z])`, "i").test(monthless)) faults.push(word);
  }
  faults.push(...copyRuleFaults(clean));
  return faults;
}

function assertCopyClean(items: Implication[], tickers: string[]): void {
  for (const i of items) {
    for (const text of [i.headline, i.because, i.scenario ?? ""]) {
      assert.deepEqual(copyFaults(text, tickers), [], `${i.id}: ${text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// open_indication and the book's beta
// ---------------------------------------------------------------------------

describe("implications: open_indication", () => {
  it("reads the futures through the book's beta before the open", () => {
    const i = one(scene(), "open_indication");
    assert.equal(i.id, "open_indication:book");
    assert.equal(i.headline, "Overnight futures point to a rise of about 0.9% for the book at the open.");
    assert.equal(i.because, "S&P 500 futures are up 1% since the close, and the book moves about 0.9% for each 1% the index moves.");
    assert.equal(i.scenario, null);
    assert.equal(i.scenario_usd, null);
    assert.equal(i.book_pct, 0.9);
    assert.deepEqual(i.tickers, []);
  });

  it("says a drop, and quotes the figures as given", () => {
    const i = one(scene({ es: -1.48, beta: 0.88 }), "open_indication");
    assert.equal(i.headline, "Overnight futures point to a drop of about 1.3% for the book at the open.");
    assert.equal(i.because, "S&P 500 futures are down 1.48% since the close, and the book moves about 0.88% for each 1% the index moves.");
    assert.equal(i.book_pct, -1.3);
  });

  it("says little change under 0.1% of the book, and gives the figure from 0.1%", () => {
    assert.equal(one(scene({ es: 0.1, beta: 0.9 }), "open_indication").headline, "Overnight futures point to little change for the book at the open.");
    assert.equal(one(scene({ es: 0.1, beta: 1 }), "open_indication").headline, "Overnight futures point to a rise of about 0.1% for the book at the open.");
    assert.ok(one(scene({ es: 0 }), "open_indication").because.startsWith("S&P 500 futures are flat since the close"));
  });

  it("reads the same between sessions, and as the market's share of the day once the session trades", () => {
    assert.equal(one(scene({ now: BETWEEN }), "open_indication").headline, "Overnight futures point to a rise of about 0.9% for the book at the open.");
    assert.equal(one(scene({ now: IN_SESSION }), "open_indication").headline, "The market's move since the close accounts for a rise of about 0.9% in the book.");
    assert.equal(one(scene({ now: IN_SESSION, es: 0.05 }), "open_indication").headline, "The market's move since the close accounts for little change in the book.");
  });

  it("sets the held names' own quotes beside the futures only when they part by half a point", () => {
    assert.equal(
      one(scene({ pnl: 1.5 }), "open_indication").because,
      "S&P 500 futures are up 1% since the close, and the book moves about 0.9% for each 1% the index moves; the held names' own quotes put the book up 1.5% so far, ahead of what the futures imply.",
    );
    assert.ok(one(scene({ pnl: 0.2 }), "open_indication").because.endsWith("put the book up 0.2% so far, behind what the futures imply."));
    assert.ok(one(scene({ now: IN_SESSION, pnl: -0.4 }), "open_indication").because.endsWith("put the book down 0.4% so far, behind the market's share."));
    assert.ok(!one(scene({ pnl: 1.35 }), "open_indication").because.includes("quotes"));
    assert.ok(!one(scene({ pnl: null }), "open_indication").because.includes("quotes"));
  });

  it("turns the move around for a book that moves against the index", () => {
    const i = one(scene({ beta: -0.4 }), "open_indication");
    assert.equal(i.headline, "Overnight futures point to a drop of about 0.4% for the book at the open.");
    assert.ok(i.because.endsWith("the book moves about 0.4% the other way for each 1% the index moves."));
  });

  it("counts a final print as well as a live one, and nothing else", () => {
    assert.equal(ofKind(scene({ futures: "final" }), "open_indication").length, 1);
    for (const state of ["stale", "unavailable"] as const) assert.equal(ofKind(scene({ futures: state }), "open_indication").length, 0, state);
    assert.equal(ofKind(scene({ es: null }), "open_indication").length, 0);
  });
});

describe("implications: the book's beta", () => {
  it("takes the risk engine's beta only when its snapshot describes this book", () => {
    assert.ok(one(scene(), "open_indication").because.includes("moves about 0.9% for each 1%"));
    // Five names at 16% of equity, each with a beta of 1.
    for (const risk of [{ matches_book: false }, { beta_port: null }, { beta_port: Number.NaN }, { beta_port: 0 }]) {
      assert.ok(one(scene({ risk }), "open_indication").because.includes("moves about 0.8% for each 1%"), JSON.stringify(risk));
    }
    assert.ok(one(scene({ risk: null }), "open_indication").because.includes("moves about 0.8% for each 1%"));
  });

  it("sums the held names' betas only once they cover half of the invested book", () => {
    const half = scene({ risk: null, cash: 20_000, names: { NVDA: { value: 40_000, beta: 1.2 }, KO: { value: 40_000, beta: null } } });
    assert.ok(one(half, "open_indication").because.includes("moves about 0.48% for each 1%"));
    assert.equal(ofKind(half, "data_gap").length, 0);

    const under = scene({ risk: null, cash: 19_999, names: { NVDA: { value: 40_000, beta: 1.2 }, KO: { value: 40_001, beta: null } } });
    assert.equal(ofKind(under, "open_indication").length, 0);
    const gap = one(under, "data_gap");
    assert.equal(gap.id, "data_gap:beta");
    assert.equal(gap.headline, "Beta is missing for most of the book, so the market's effect on it cannot be sized.");
    assert.equal(gap.because, "Beta is known for names making up 50% of the invested book, under the half this needs.");
    assert.equal(gap.book_pct, null);

    const none = scene({ risk: null, names: fiveNames({ NVDA: { value: 16_000, beta: null }, AAPL: { value: 16_000, beta: null }, MSFT: { value: 16_000, beta: null }, KO: { value: 16_000, beta: null }, JNJ: { value: 16_000, beta: null } }) });
    assert.equal(one(none, "data_gap").because, "No held name carries a beta in this report.");
  });

  it("points a book that is net short the same way with the snapshot and without it", () => {
    // 200,000 of cash against 40,000 of borrowed SPY: equity 160,000, and a
    // quarter of it working against the index.
    const names = { SPY: { value: -40_000, beta: 1, vol: 1.5 } };
    const withRisk = scene({ es: 0.42, names, cash: 200_000, beta: -0.25 });
    const withoutRisk = scene({ es: 0.42, names, cash: 200_000, risk: null });

    const led = one(withRisk, "open_indication");
    assert.equal(led.headline, "Overnight futures point to a drop of about 0.11% for the book at the open.");
    assert.ok(led.because.endsWith("the book moves about 0.25% the other way for each 1% the index moves."));
    assert.equal(led.book_pct, -0.1);
    assert.deepEqual(one(withoutRisk, "open_indication"), led);
  });

  it("sizes the snapshot's beta on this request's cash, not on the cash it was computed with", () => {
    // A snapshot taken when the account held almost no cash, read against a
    // book that is now 95% cash: its own invested fraction would overstate the
    // book roughly twentyfold.
    const s = scene({ names: { SPY: { value: 5700, beta: 1, vol: 1.5 } }, cash: 100_000, risk: { beta_port: 1 } });
    const i = one(s, "open_indication");
    assert.equal(i.headline, "Overnight futures point to little change for the book at the open.");
    assert.ok(i.because.endsWith("the book moves about 0.05% for each 1% the index moves."));
  });

  it("does not take a snapshot's beta as known when no held name carries one", () => {
    // The risk engine fills 1.0 in for a name it has no beta for and says so
    // only in its own degraded list, so the report has to judge coverage itself.
    const s = scene({ names: { ZZZZ: { value: 10_000, beta: null }, WXYZ: { value: 20_000, beta: null } }, cash: 0, risk: { beta_port: 1 } });
    assert.equal(ofKind(s, "open_indication").length, 0);
    assert.equal(one(s, "data_gap").because, "No held name carries a beta in this report.");
  });

  it("does not let a snapshot of another book stand in when the names cover too little", () => {
    const s = scene({ risk: { matches_book: false }, names: fiveNames({ NVDA: { value: 16_000, beta: null }, AAPL: { value: 16_000, beta: null }, MSFT: { value: 16_000, beta: null } }) });
    assert.equal(one(s, "data_gap").because, "Beta is known for names making up 40% of the invested book, under the half this needs.");
  });
});

// ---------------------------------------------------------------------------
// name_specific
// ---------------------------------------------------------------------------

describe("implications: name_specific", () => {
  it("names a drop the market does not explain, with what the market did point to", () => {
    const i = one(scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) }), "name_specific");
    assert.equal(i.id, "name_specific:NVDA");
    assert.equal(i.headline, "NVDA's 4.2% drop is its own, not the market's.");
    assert.equal(i.because, "The market alone points to a rise of about 0.55% for it, and no headline on NVDA in this report accounts for it.");
    // The residual, -4.75%, on 16% of the book.
    assert.equal(i.book_pct, -0.76);
    assert.deepEqual(i.tickers, ["NVDA"]);
    assert.equal(i.scenario, null);
  });

  it("says how much the market explains when it moved the same way", () => {
    const i = one(scene({ es: -0.8, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) }), "name_specific");
    assert.equal(i.because, "The market explains about 0.88% of it, and no headline on NVDA in this report accounts for it.");
    assert.equal(i.book_pct, -0.53);
    const flat = one(scene({ es: 0.02, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) }), "name_specific");
    assert.ok(flat.because.startsWith("The market explains almost none of it, "));
  });

  it("names the part left over when the market explains most of the move, or pulled the other way", () => {
    const trails = one(scene({ es: 2, names: fiveNames({ NVDA: { value: 16_000, move: 0.2, beta: 1, vol: 1 } }) }), "name_specific");
    assert.equal(trails.headline, "NVDA trails what the market explains for it by about 1.8%.");
    assert.equal(trails.because, "It is up 0.2% since the close, against a rise of about 2% from the market alone, and no headline on NVDA in this report accounts for it.");

    const ahead = one(scene({ es: -2, names: fiveNames({ NVDA: { value: 16_000, move: -0.2, beta: 1, vol: 1 } }) }), "name_specific");
    assert.equal(ahead.headline, "NVDA runs about 1.8% ahead of what the market explains for it.");
    assert.ok(ahead.because.startsWith("It is down 0.2% since the close, against a drop of about 2% from the market alone"));

    // Down 3% on a day the market explains 2% of it: mostly the market's.
    const mostly = one(scene({ es: -2, names: fiveNames({ NVDA: { value: 16_000, move: -3, beta: 1, vol: 0.8 } }) }), "name_specific");
    assert.equal(mostly.headline, "NVDA trails what the market explains for it by about 1%.");
  });

  it("needs a residual of 1% and of the name's own normal day, whichever is larger", () => {
    const at = (move: number, vol: number | null): number =>
      ofKind(scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move, beta: 1, vol } }) }), "name_specific").length;
    assert.equal(at(-2.0, 2.5), 1);
    assert.equal(at(-1.99, 2.5), 0);
    assert.equal(at(-0.5, null), 1);
    assert.equal(at(-0.49, null), 0);
    assert.equal(at(-0.5, 0.5), 1);
    assert.equal(at(-0.49, 0.5), 0);
  });

  it("needs the name to be 1% of the book", () => {
    const tiny = (value: number): number =>
      ofKind(scene({ es: 0.5, cash: 20_000 - value, names: { ...fiveNames(), TINY: { value, move: -5, beta: 1, vol: 2 } } }), "name_specific").length;
    assert.equal(tiny(1000), 1);
    assert.equal(tiny(999), 0);
  });

  it("counts the headlines on the name since the close, shared and undated ones included", () => {
    const base = scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) });
    const withNews = (items: HeldNewsItem[]): string =>
      one(withInput(base, { overnight: { ...base.input.overnight, held_news: items } }), "name_specific").because;
    assert.ok(withNews([news("NVDA", "2026-09-22T05:00:00.000Z")]).endsWith("and the report lists 1 headline on NVDA since the close."));
    assert.ok(
      withNews([
        news("NVDA", "2026-09-22T05:00:00.000Z"),
        news("AAPL", "2026-09-22T06:00:00.000Z", ["NVDA"]),
        // Before the last US close: not part of this night.
        news("NVDA", "2026-09-21T15:00:00.000Z"),
        // A date the provider wrote in a shape nobody can read is still a
        // headline the report carries; dropping it would count it as absent.
        news("NVDA", "not a time"),
      ]).endsWith("and the report lists 3 headlines on NVDA since the close."),
    );
  });

  it("says no headline only of a night it can count, not of a list that was cut", () => {
    const base = scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) });
    const withCounts = (news_counts: Record<string, number> | undefined): string =>
      one(withInput(base, { news_counts }), "name_specific").because;
    // Nothing on the name anywhere: the report can say so of the night itself.
    assert.ok(withCounts({ NVDA: 0, AAPL: 4 }).endsWith("and no headline on NVDA since the close accounts for it."));
    // Two headlines on the name, both cut from the list by other names' items.
    assert.ok(withCounts({ NVDA: 2 }).endsWith("and 2 headlines on NVDA came out since the close, none of them in this report."));
    assert.ok(withCounts({ NVDA: 1 }).endsWith("and 1 headline on NVDA came out since the close, none of them in this report."));
    // No count to lean on: the claim stays inside what the report lists.
    assert.ok(withCounts(undefined).endsWith("and no headline on NVDA in this report accounts for it."));
    assert.ok(withCounts({}).endsWith("and no headline on NVDA in this report accounts for it."));
  });

  it("never reads a name the chain does not follow for news as a quiet night", () => {
    const because = (coverage: HeldCoverage): string =>
      one(scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5, coverage } }) }), "name_specific").because;
    assert.ok(because("price_only").endsWith("and NVDA is followed for prices only, so the cause is not in this report."));
    assert.ok(because("pending").endsWith("and NVDA has no news coverage yet, so the cause is not in this report."));
    const s = scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) });
    const missing = withInput(s, { held_coverage: s.input.held_coverage.filter((c) => c.ticker !== "NVDA") });
    assert.ok(one(missing, "name_specific").because.endsWith("NVDA has no news coverage yet, so the cause is not in this report."));
  });

  it("keeps the two that move the book most, and leaves a flagged move out", () => {
    const three = scene({
      es: 0.5,
      names: fiveNames({ NVDA: { value: 16_000, move: -6 }, AAPL: { value: 16_000, move: 5 }, MSFT: { value: 16_000, move: -3.5 } }),
    });
    assert.deepEqual(ofKind(three, "name_specific").map((i) => [i.id, i.book_pct]), [["name_specific:NVDA", -1.04], ["name_specific:AAPL", 0.72]]);

    const flagged = scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -48, flag: "corporate_action_check" } }) });
    assert.equal(ofKind(flagged, "name_specific").length, 0);
  });

  it("measures the move against the name's normal day when there is no market part to take out", () => {
    const noFutures = scene({ futures: "stale", names: fiveNames({ NVDA: { value: 16_000, move: -4.2, vol: 2.1, z: -2 } }) });
    const i = one(noFutures, "name_specific");
    assert.equal(i.headline, "NVDA's 4.2% drop is about 2 times its normal day.");
    assert.equal(i.because, "Its normal daily move is 2.1% and futures carry no move to compare it with; no headline on NVDA in this report accounts for it.");
    assert.equal(i.book_pct, -0.67);
    assert.equal(ofKind(scene({ futures: "stale", names: fiveNames({ NVDA: { value: 16_000, move: -4.2, vol: 2.1, z: -1.49 } }) }), "name_specific").length, 0);

    const noBeta = one(scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: null, vol: 2.1, z: -2 } }) }), "name_specific");
    assert.ok(noBeta.because.startsWith("Its normal daily move is 2.1% and no beta is known to take the market's part out; "));
  });
});

// ---------------------------------------------------------------------------
// event_sensitivity
// ---------------------------------------------------------------------------

describe("implications: event_sensitivity", () => {
  it("sizes the next top-tier release through the book's beta, both ways", () => {
    const i = one(withInput(scene(), { calendar_today: [CPI] }), "event_sensitivity");
    assert.equal(i.id, "event_sensitivity:macro:CPI:2026-09-22");
    assert.equal(i.headline, "Consumer Price Index at 08:30 ET is the first top-tier release ahead this session.");
    assert.equal(i.because, "It prints before the open, and the book moves about 0.9% for each 1% the index moves.");
    assert.equal(i.scenario, "A 1% index move either way is about 0.9% of the book.");
    // 0.9% of 100,000 of equity.
    assert.equal(i.scenario_usd, 900);
    assert.equal(i.book_pct, 0.9);
  });

  it("names the first of several, and says when each lands against the session", () => {
    assert.equal(
      one(withInput(scene(), { calendar_today: [FOMC, CPI] }), "event_sensitivity").headline,
      "Consumer Price Index at 08:30 ET is the first of this session's 2 top-tier releases.",
    );
    const fomc = one(withInput(scene(), { calendar_today: [FOMC] }), "event_sensitivity");
    assert.ok(fomc.because.startsWith("It lands mid-session, "));
    const early = scene();
    const closesEarly = withInput(early, { calendar_today: [FOMC], window: { ...early.input.window, target_close_at: "2026-09-22T17:00:00.000Z", early_close: true } });
    assert.ok(one(closesEarly, "event_sensitivity").because.startsWith("It lands after the close, "));
  });

  it("looks only ahead of the report's own clock, and only at top-tier macro releases with a time", () => {
    const later = withInput(scene({ now: IN_SESSION }), { calendar_today: [CPI, FOMC] });
    assert.equal(one(later, "event_sensitivity").headline, "FOMC rate decision at 14:00 ET is the first top-tier release ahead this session.");
    const others: CalendarItem[] = [
      release("claims", "data", "08:30", "Initial jobless claims", 2),
      { ...CPI, id: "opex", kind: "opex", time_et: null, at: null, title: "Monthly options expiry" },
      { ...CPI, id: "earn", kind: "earnings", title: "NVDA earnings report" },
      { ...CPI, id: "untimed", time_et: null, at: null },
    ];
    assert.equal(ofKind(withInput(scene(), { calendar_today: others }), "event_sensitivity").length, 0);
    assert.equal(ofKind(withInput(scene({ now: "2026-09-22T19:00:00.000Z" }), { calendar_today: [CPI, FOMC] }), "event_sensitivity").length, 0);
  });

  it("needs a book beta of at least 0.1 either way", () => {
    const at = (beta: number): number => ofKind(withInput(scene({ beta }), { calendar_today: [CPI] }), "event_sensitivity").length;
    assert.equal(at(0.1), 1);
    assert.equal(at(-0.1), 1);
    assert.equal(at(0.09), 0);
    const unknown = withInput(scene({ risk: null, names: fiveNames({ NVDA: { value: 16_000, beta: null }, AAPL: { value: 16_000, beta: null }, MSFT: { value: 16_000, beta: null } }) }), { calendar_today: [CPI] });
    assert.equal(ofKind(unknown, "event_sensitivity").length, 0);
  });
});

// ---------------------------------------------------------------------------
// earnings_exposure
// ---------------------------------------------------------------------------

describe("implications: earnings_exposure", () => {
  const nvda = (over: Partial<NameSpec> = {}): Record<string, NameSpec> => fiveNames({ NVDA: { value: 16_000, vol: 2.7, ...over } });

  it("sizes a report on a large holding by two of its normal days, either way", () => {
    const i = one(withInput(scene({ names: nvda() }), { earnings_next: [earnings("NVDA", 2)] }), "earnings_exposure");
    assert.equal(i.id, "earnings_exposure:NVDA");
    assert.equal(i.headline, "NVDA reports in 2 sessions and is 16% of the book.");
    assert.equal(i.because, "The report is due Thursday, September 24, after the close or at an hour not yet announced; its normal daily move is 2.7%.");
    assert.equal(i.scenario, "A move of twice its normal day (5.4%) either way is about 0.86% of the book.");
    // 2 x 2.7% of the 16,000 position.
    assert.equal(i.scenario_usd, 864);
    assert.equal(i.book_pct, 0.86);
    assert.deepEqual(i.tickers, ["NVDA"]);
  });

  it("words a report due this session by its timing and by the phase", () => {
    const headline = (now: string, e: HeldEarnings): string[] =>
      ofKind(withInput(scene({ now, names: nvda() }), { earnings_next: [e] }), "earnings_exposure").map((i) => i.headline);
    const bmo = earnings("NVDA", 0, { timing: "bmo" });
    const amc = earnings("NVDA", 0);
    assert.deepEqual(headline(PRE, bmo), ["NVDA reports today before the open and is 16% of the book."]);
    assert.deepEqual(headline(PRE, amc), ["NVDA reports today after the close, or at an hour not yet announced, and is 16% of the book."]);
    assert.deepEqual(headline(BETWEEN, { ...bmo, due_ymd: "2026-09-23" }), ["NVDA reports before the next open and is 16% of the book."]);
    assert.deepEqual(headline(BETWEEN, { ...amc, due_ymd: "2026-09-23" }), ["NVDA reports after the next session's close, or at an hour not yet announced, and is 16% of the book."]);
    // Released before this session's open: the price has it by now.
    assert.deepEqual(headline(IN_SESSION, bmo), []);
    assert.deepEqual(headline(IN_SESSION, amc), ["NVDA reports today after the close, or at an hour not yet announced, and is 16% of the book."]);
    assert.deepEqual(headline(PRE, earnings("NVDA", 1)), ["NVDA reports in 1 session and is 16% of the book."]);
    const due = one(withInput(scene({ names: nvda() }), { earnings_next: [bmo] }), "earnings_exposure").because;
    assert.equal(due, "The report is due Tuesday, September 22, before the open; its normal daily move is 2.7%.");
  });

  it("says when the company has not confirmed the date", () => {
    const i = one(withInput(scene({ names: nvda() }), { earnings_next: [earnings("NVDA", 2, { confirmed: false, source: "yahoo" })] }), "earnings_exposure");
    assert.equal(
      i.because,
      "The report is due Thursday, September 24, after the close or at an hour not yet announced, on a date the company has not confirmed; its normal daily move is 2.7%.",
    );
  });

  it("looks five sessions ahead, at names of 3% of the book or more", () => {
    const count = (e: HeldEarnings, names = nvda(), cash = 20_000): number =>
      ofKind(withInput(scene({ names, cash }), { earnings_next: [e] }), "earnings_exposure").length;
    assert.equal(count(earnings("NVDA", 5)), 1);
    assert.equal(count(earnings("NVDA", 6)), 0);
    assert.equal(count(earnings("NVDA", -1)), 0);
    assert.equal(count(earnings("NVDA", 2), nvda({ value: 3000 }), 33_000), 1);
    assert.equal(count(earnings("NVDA", 2), nvda({ value: 2999 }), 33_001), 0);
  });

  it("has no scenario without the name's volatility, and ranks it by its move per 1%", () => {
    const i = one(withInput(scene({ names: nvda({ vol: null }) }), { earnings_next: [earnings("NVDA", 2)] }), "earnings_exposure");
    assert.equal(i.scenario, null);
    assert.equal(i.scenario_usd, null);
    assert.equal(i.because, "The report is due Thursday, September 24, after the close or at an hour not yet announced.");
    assert.equal(i.book_pct, 0.16);
  });

  it("keeps the two that could move the book most", () => {
    const names = fiveNames({ NVDA: { value: 16_000, vol: 2.7 }, AAPL: { value: 16_000, vol: 1.5 }, MSFT: { value: 16_000, vol: 3 } });
    const s = withInput(scene({ names }), { earnings_next: [earnings("AAPL", 1), earnings("NVDA", 2), earnings("MSFT", 4)] });
    assert.deepEqual(ofKind(s, "earnings_exposure").map((i) => [i.id, i.book_pct]), [["earnings_exposure:MSFT", 0.96], ["earnings_exposure:NVDA", 0.86]]);
  });
});

// ---------------------------------------------------------------------------
// index_flow
// ---------------------------------------------------------------------------

describe("implications: index_flow", () => {
  const funds = (): Record<string, NameSpec> => ({ SPY: { value: 30_000 }, IWM: { value: 10_000 }, NVDA: { value: 16_000 }, AAPL: { value: 16_000 } });

  it("names the held funds that trade into a rebalance, and the expiry sharing its close", () => {
    const s = withInput(scene({ now: "2026-12-15T12:00:00.000Z", names: funds(), cash: 28_000 }), {
      corporate_events: [
        rebalance("sp", "2026-12-18", 3, ["SPY"], "S&P quarterly index rebalance"),
        rebalance("russell", "2026-12-18", 3, ["IWM"], "Russell quarterly index rebalance"),
      ],
    });
    const i = one(s, "index_flow");
    assert.equal(i.id, "index_flow:2026-12-18");
    assert.equal(i.headline, "SPY and IWM trade into the quarterly index rebalance at the close on Friday, December 18.");
    assert.equal(
      i.because,
      "Funds that track the S&P and Russell indices adjust to their new weights at that close, the same close as the quarterly options and futures expiry.",
    );
    assert.equal(i.scenario, null);
    // 30% and 10% of the book, per 1% the two funds move.
    assert.equal(i.book_pct, 0.4);
    assert.deepEqual(i.tickers, ["SPY", "IWM"]);
  });

  it("leaves the expiry out on any other date, and words one fund and one family", () => {
    const s = withInput(scene({ names: funds(), cash: 28_000 }), {
      corporate_events: [rebalance("russell", "2026-09-25", 3, ["IWM"], "Russell index reconstitution")],
    });
    const i = one(s, "index_flow");
    assert.equal(i.headline, "IWM trades into the index reconstitution at the close on Friday, September 25.");
    assert.equal(i.because, "Funds that track the Russell indices adjust to their new weights at that close.");

    const qqq = withInput(scene({ names: { QQQ: { value: 40_000 } }, cash: 60_000 }), {
      corporate_events: [rebalance("nasdaq100", "2026-09-25", 3, ["QQQ"], "Nasdaq-100 annual reconstitution")],
    });
    assert.equal(one(qqq, "index_flow").because, "Funds that track the Nasdaq-100 index adjust to their new weights at that close.");
  });

  it("says today's close on the day itself, and the next session's close the evening before", () => {
    const today = withInput(scene({ names: funds(), cash: 28_000 }), { corporate_events: [rebalance("sp", "2026-09-22", 0, ["SPY"], "S&P quarterly index rebalance")] });
    assert.equal(one(today, "index_flow").headline, "SPY trades into the quarterly index rebalance at today's close.");
    const evening = withInput(scene({ now: BETWEEN, names: funds(), cash: 28_000 }), { corporate_events: [rebalance("sp", "2026-09-23", 0, ["SPY"], "S&P quarterly index rebalance")] });
    assert.equal(one(evening, "index_flow").headline, "SPY trades into the quarterly index rebalance at the next session's close.");
  });

  it("calls a mixed date a rebalance, keeps only the nearest date, and needs a held fund within five sessions", () => {
    const mixed = withInput(scene({ names: { ...funds(), QQQ: { value: 10_000 } }, cash: 18_000 }), {
      corporate_events: [
        rebalance("nasdaq100", "2026-09-25", 3, ["QQQ"], "Nasdaq-100 annual reconstitution"),
        rebalance("sp", "2026-09-25", 3, ["SPY"], "S&P quarterly index rebalance"),
        rebalance("russell", "2026-09-28", 4, ["IWM"], "Russell index reconstitution"),
      ],
    });
    const i = one(mixed, "index_flow");
    assert.equal(i.headline, "QQQ and SPY trade into the index rebalance at the close on Friday, September 25.");
    assert.ok(i.because.startsWith("Funds that track the S&P and Nasdaq-100 indices "));

    const none = (e: CorporateEvent): number => ofKind(withInput(scene({ names: funds(), cash: 28_000 }), { corporate_events: [e] }), "index_flow").length;
    assert.equal(none(rebalance("sp", "2026-09-30", 6, ["SPY"], "S&P quarterly index rebalance")), 0);
    assert.equal(none(rebalance("sp", "2026-09-25", 3, [], "S&P quarterly index rebalance")), 0);
    assert.equal(none(rebalance("sp", "2026-09-25", 3, ["VOO"], "S&P quarterly index rebalance")), 0);
    assert.equal(none(rebalance("sp", "2026-09-29", 5, ["SPY"], "S&P quarterly index rebalance")), 1);

    // A nearer event that names no position here does not hide the one that does.
    const later = withInput(scene({ names: funds(), cash: 28_000 }), {
      corporate_events: [
        rebalance("sp", "2026-09-23", 1, ["VOO"], "S&P quarterly index rebalance"),
        rebalance("russell", "2026-09-25", 3, ["IWM"], "Russell index reconstitution"),
      ],
    });
    assert.equal(one(later, "index_flow").id, "index_flow:2026-09-25");
  });
});

// ---------------------------------------------------------------------------
// ex_dividend
// ---------------------------------------------------------------------------

describe("implications: ex_dividend", () => {
  it("explains the drop at the open as the dividend, not the market", () => {
    const i = one(withInput(scene(), { corporate_events: [dividend("AAPL", "2026-09-22")] }), "ex_dividend");
    assert.equal(i.id, "ex_dividend:AAPL");
    assert.equal(i.headline, "AAPL opens ex-dividend today, so its price starts lower by the dividend.");
    assert.equal(i.because, "That drop is the dividend leaving the share price, not a market move; holders of record receive it.");
    assert.equal(i.scenario, null);
    // Per 1% of the price paid out: it ranks low, where a drop paid back in cash belongs.
    assert.equal(i.book_pct, 0.16);
  });

  it("follows the phase, the side of the position and the date", () => {
    assert.equal(
      one(withInput(scene({ now: IN_SESSION }), { corporate_events: [dividend("AAPL", "2026-09-22")] }), "ex_dividend").headline,
      "AAPL went ex-dividend today, so its price started lower by the dividend.",
    );
    assert.equal(
      one(withInput(scene({ now: BETWEEN }), { corporate_events: [dividend("AAPL", "2026-09-23")] }), "ex_dividend").headline,
      "AAPL opens ex-dividend in the next session, so its price starts lower by the dividend.",
    );
    const borrowed = withInput(scene({ names: fiveNames({ AAPL: { value: -16_000 } }), cash: 52_000 }), { corporate_events: [dividend("AAPL", "2026-09-22")] });
    assert.ok(one(borrowed, "ex_dividend").because.endsWith("a borrowed position pays it to the lender."));
    assert.equal(ofKind(withInput(scene(), { corporate_events: [dividend("AAPL", "2026-09-25")] }), "ex_dividend").length, 0);
    assert.equal(ofKind(withInput(scene(), { corporate_events: [dividend("PEP", "2026-09-22")] }), "ex_dividend").length, 0);
  });
});

// ---------------------------------------------------------------------------
// concentration
// ---------------------------------------------------------------------------

describe("implications: concentration", () => {
  it("names a position that is a quarter of the invested book, and the next one down", () => {
    const names = { SPY: { value: 26_000 }, NVDA: { value: 17_000 }, AAPL: { value: 16_000 }, MSFT: { value: 16_000 }, KO: { value: 15_000 }, JNJ: { value: 10_000 } };
    const i = one(scene({ names, cash: 0 }), "concentration");
    assert.equal(i.id, "concentration:SPY");
    assert.equal(i.headline, "SPY is 26% of the invested book, so its move alone sets about a quarter of the book's.");
    assert.equal(i.because, "The next largest position, NVDA, is 17% of it.");
    assert.equal(i.book_pct, 0.26);
    assert.deepEqual(i.tickers, ["SPY"]);
  });

  it("starts at a quarter, and words the share in plain fractions", () => {
    const s = scene();
    const withTop = (weights: Array<[string, number]>): Implication[] =>
      ofKind(withInput(s, { book: { ...s.input.book, top_weights: weights.map(([ticker, weight]) => ({ ticker, weight, side: "long" as const })) } }), "concentration");
    assert.equal(withTop([["NVDA", 0.25], ["AAPL", 0.2]]).length, 1);
    assert.equal(withTop([["NVDA", 0.2499], ["AAPL", 0.2]]).length, 0);
    assert.ok(withTop([["NVDA", 0.34], ["AAPL", 0.2]])[0]!.headline.endsWith("sets about a third of the book's."));
    assert.ok(withTop([["NVDA", 0.5], ["AAPL", 0.2]])[0]!.headline.endsWith("sets about half of the book's."));
    assert.ok(withTop([["NVDA", 0.97], ["AAPL", 0.03]])[0]!.headline.endsWith("sets nearly all of the book's."));
    const whole = withTop([["NVDA", 1]])[0]!;
    assert.equal(whole.headline, "NVDA is the whole invested book, so its move alone sets the book's.");
    assert.equal(whole.because, "It is the only position.");
  });
});

// ---------------------------------------------------------------------------
// data_gap
// ---------------------------------------------------------------------------

describe("implications: data_gap", () => {
  it("says before the open when the futures cannot size it, and why", () => {
    const stale = one(scene({ futures: "stale" }), "data_gap");
    assert.equal(stale.id, "data_gap:futures");
    assert.equal(stale.headline, "US futures have not printed since the close, so the open cannot be sized from them.");
    assert.equal(stale.because, "Their latest prints are from before the last US close.");
    assert.equal(stale.book_pct, null);
    assert.equal(stale.scenario_usd, null);

    const down = one(scene({ futures: "unavailable" }), "data_gap");
    assert.equal(down.headline, "US futures could not be read for this report, so the open cannot be sized from them.");
    assert.equal(down.because, "The futures feed did not answer when this report was built.");

    const s = scene();
    const noRows = withInput(s, { overnight: { ...s.input.overnight, markets: [] } });
    assert.equal(one(noRows, "data_gap").headline, down.headline);

    const esOnly = withInput(s, {
      overnight: { ...s.input.overnight, markets: s.input.overnight.markets.map((r) => (r.symbol === "ES=F" ? { ...r, state: "stale" as const, move: null } : r)) },
    });
    assert.equal(one(esOnly, "data_gap").headline, "S&P 500 futures carry no move since the close, so the open cannot be sized from them.");
    assert.equal(one(scene({ es: null }), "data_gap").headline, "S&P 500 futures carry no move since the close, so the open cannot be sized from them.");
  });

  it("leaves the futures alone between sessions and during the session", () => {
    assert.equal(ofKind(scene({ now: BETWEEN, futures: "stale" }), "data_gap").length, 0);
    assert.equal(ofKind(scene({ now: IN_SESSION, futures: "stale" }), "data_gap").length, 0);
  });

  it("says when the weights rest on what a position cost, and holds the conclusions that lean on it back", () => {
    const names = fiveNames({ NVDA: { value: 16_000 } });
    const s = scene({ names, unpriced: ["NVDA"] });
    const gap = one(s, "data_gap");
    assert.equal(gap.id, "data_gap:unpriced");
    assert.equal(gap.headline, "No price was found for NVDA, so the weights under these conclusions rest on what it cost.");
    assert.equal(gap.because, "about 20% of the invested book is carried at its cost basis in this report, which is as old as the position.");
    assert.equal(gap.book_pct, null);
    assert.deepEqual(gap.tickers, ["NVDA"]);
    // It leads although the open indication is there beside it: the weights
    // under every line below rest on the basis this one names.
    assert.equal(derive(s)[0]!.id, "data_gap:unpriced");
    assertCopyClean([gap], ["NVDA"]);

    const two = one(scene({ names, unpriced: ["NVDA", "AAPL"] }), "data_gap");
    assert.equal(two.headline, "No price was found for NVDA and AAPL, so the weights under these conclusions rest on what they cost.");
    assert.ok(two.because.endsWith("which is as old as the positions."));

    // Under a tenth of the invested book the weights are right to the
    // arithmetic's own precision, so the line would only take a slot.
    const small = scene({ names: { ...fiveNames(), TINY: { value: 4000 } }, cash: 16_000, unpriced: ["TINY"] });
    assert.equal(ofKind(small, "data_gap").length, 0);
    assert.equal(ofKind(scene({ names }), "data_gap").length, 0);
  });

  it("drops the conclusions whose own subject has no price", () => {
    const heavy = { NVDA: { value: 40_000, vol: 2.7 }, AAPL: { value: 16_000 }, MSFT: { value: 16_000 } };
    const priced = withInput(scene({ names: heavy, cash: 28_000 }), { earnings_next: [earnings("NVDA", 2)] });
    assert.equal(one(priced, "concentration").id, "concentration:NVDA");
    assert.equal(one(priced, "earnings_exposure").scenario_usd, 2160);

    const s = withInput(scene({ names: heavy, cash: 28_000, unpriced: ["NVDA"] }), { earnings_next: [earnings("NVDA", 2)] });
    assert.equal(ofKind(s, "concentration").length, 0);
    const report = one(s, "earnings_exposure");
    assert.equal(report.scenario_usd, null);
    // The percentages stay: they are the report's own weights either way.
    assert.equal(report.scenario, "A move of twice its normal day (5.4%) either way is about 2.2% of the book.");
  });

  it("sets the held names' quotes beside the futures only when the whole book was priced", () => {
    assert.ok(one(scene({ pnl: 1.5 }), "open_indication").because.includes("quotes"));
    assert.ok(!one(scene({ pnl: 1.5, unpriced: ["NVDA"] }), "open_indication").because.includes("quotes"));
  });

  it("holds the quotes clause back when a priced name is still outside the P&L", () => {
    // A split name is valued into equity and left out of the overnight figure,
    // so the figure covers less of the book than it is expressed over, without
    // the name ever showing up as unpriced.
    assert.ok(!one(scene({ pnl: 1.5, pnl_excluded: ["NVDA"] }), "open_indication").because.includes("quotes"));
    // A report built without the field is read as a book with nothing left out.
    const s = scene({ pnl: 1.5 });
    assert.ok(one(withInput(s, { book: { ...s.input.book, pnl_excluded: undefined } }), "open_indication").because.includes("quotes"));
  });
});

// ---------------------------------------------------------------------------
// The evening slice: pre_open on the calendar day before the target session
// ---------------------------------------------------------------------------

describe("implications: the day a sentence names", () => {
  const funds = (): Record<string, NameSpec> => ({ SPY: { value: 40_000 }, AAPL: { value: 40_000 } });

  it("names the target session's weekday while the date is still the day before", () => {
    const window = resolveBriefingWindow(new Date(EVENING));
    assert.equal(window.phase, "pre_open");
    assert.equal(window.target_session_ymd, "2026-09-28");

    const s = withInput(scene({ now: EVENING, names: funds(), cash: 20_000 }), {
      earnings_next: [earnings("AAPL", 0, { due_ymd: "2026-09-28", timing: "bmo" })],
      corporate_events: [
        dividend("AAPL", "2026-09-28"),
        rebalance("sp", "2026-09-28", 0, ["SPY"], "S&P quarterly index rebalance"),
      ],
    });
    assert.equal(one(s, "earnings_exposure").headline, "AAPL reports on Monday before the open and is 40% of the book.");
    assert.equal(one(s, "earnings_exposure").because, "The report is due Monday, September 28, before the open; its normal daily move is 1.5%.");
    assert.equal(one(s, "ex_dividend").headline, "AAPL opens ex-dividend on Monday, so its price starts lower by the dividend.");
    assert.equal(one(s, "index_flow").headline, "SPY trades into the quarterly index rebalance at Monday's close.");
    assertCopyClean(derive(s), ["SPY", "AAPL"]);
  });

  it("still says today once the calendar day is the target session's", () => {
    const s = withInput(scene({ names: funds(), cash: 20_000 }), {
      earnings_next: [earnings("AAPL", 0, { timing: "bmo" })],
      corporate_events: [
        dividend("AAPL", "2026-09-22"),
        rebalance("sp", "2026-09-22", 0, ["SPY"], "S&P quarterly index rebalance"),
      ],
    });
    assert.equal(one(s, "earnings_exposure").headline, "AAPL reports today before the open and is 40% of the book.");
    assert.equal(one(s, "ex_dividend").headline, "AAPL opens ex-dividend today, so its price starts lower by the dividend.");
    assert.equal(one(s, "index_flow").headline, "SPY trades into the quarterly index rebalance at today's close.");
  });
});

// ---------------------------------------------------------------------------
// Ranking, cap and edges
// ---------------------------------------------------------------------------

describe("implications: ranking", () => {
  it("ranks the expected moves first, then the standing sensitivities, and keeps five", () => {
    const names = fiveNames({
      NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 },
      MSFT: { value: 16_000, vol: 3 },
      KO: { value: 16_000, vol: 0.5 },
    });
    const s = withInput(scene({ es: 0.5, names }), {
      calendar_today: [CPI],
      earnings_next: [earnings("MSFT", 2), earnings("KO", 3)],
      corporate_events: [dividend("AAPL", "2026-09-22")],
    });
    const list = derive(s);
    assert.equal(list.length, MAX_IMPLICATIONS);
    assert.deepEqual(list.map((i) => [i.id, i.book_pct]), [
      ["earnings_exposure:MSFT", 0.96],
      ["name_specific:NVDA", -0.76],
      ["open_indication:book", 0.45],
      ["earnings_exposure:KO", 0.16],
      // A move per 1% of the index, not a move: it ranks under every figure
      // above it although 0.9 is the largest number in the list.
      ["event_sensitivity:macro:CPI:2026-09-22", 0.9],
    ]);
  });

  it("keeps the open indication in the list on a crowded quiet morning", () => {
    const names: Record<string, NameSpec> = {
      ...fiveNames({ NVDA: { value: 30_000, move: -6, beta: 1, vol: 2.5 }, MSFT: { value: 16_000, vol: 3 }, KO: { value: 16_000, vol: 2.4 } }),
      TSLA: { value: 20_000, move: 5.5, beta: 1, vol: 3 },
      SPY: { value: 12_000 },
    };
    const s = withInput(scene({ es: 0.1, names, cash: 20_000 }), {
      calendar_today: [CPI],
      earnings_next: [earnings("NVDA", 1), earnings("TSLA", 2), earnings("MSFT", 3)],
      corporate_events: [dividend("KO", "2026-09-22"), rebalance("sp", "2026-09-25", 3, ["SPY"], "S&P quarterly index rebalance")],
    });
    const list = derive(s);
    // Two name_specific and two earnings are all the tier can hold beside it,
    // so the reader is never left without the line the panel exists for.
    assert.ok(list.some((i) => i.kind === "open_indication"), list.map((i) => i.id).join(", "));
  });

  it("puts a data gap first when it stands in for the open indication", () => {
    const names = fiveNames({ NVDA: { value: 16_000, move: -4.2, vol: 2.1, z: -2 }, MSFT: { value: 16_000, vol: 3 } });
    const s = withInput(scene({ futures: "stale", names }), { earnings_next: [earnings("MSFT", 2)] });
    assert.deepEqual(derive(s).map((i) => i.id), ["data_gap:futures", "earnings_exposure:MSFT", "name_specific:NVDA"]);

    const both = scene({ futures: "unavailable", risk: null, names: fiveNames({ NVDA: { value: 16_000, beta: null }, AAPL: { value: 16_000, beta: null }, MSFT: { value: 16_000, beta: null } }) });
    assert.deepEqual(derive(both).map((i) => i.id), ["data_gap:beta", "data_gap:futures"]);
  });

  it("gives the same list for the same figures, and leaves its input untouched", () => {
    const s = withInput(scene({ es: 0.5, names: fiveNames({ NVDA: { value: 16_000, move: -4.2, beta: 1.1, vol: 2.5 } }) }), {
      calendar_today: [CPI],
      earnings_next: [earnings("NVDA", 2)],
    });
    const frozen = deepFreeze(structuredClone(s));
    assert.deepEqual(deriveImplications(frozen.input, frozen.positions), derive(s));
    assert.deepEqual(derive(s), derive(s));
  });
});

describe("implications: edges", () => {
  it("returns nothing for an empty book, a book of nothing, or no positive equity", () => {
    assert.deepEqual(deriveImplications(scene({ names: {}, cash: 5000 }).input, []), []);
    const s = scene();
    assert.deepEqual(deriveImplications(s.input, s.positions.map((p) => ({ ...p, market_value: 0 }))), []);
    assert.deepEqual(deriveImplications(s.input, [{ ticker: "NVDA", market_value: Number.NaN }]), []);
    // Two rows of one symbol that net to nothing are no position.
    assert.deepEqual(deriveImplications(s.input, [{ ticker: "NVDA", market_value: 500 }, { ticker: "nvda", market_value: -500 }]), []);
    for (const equity of [0, -500, Number.NaN]) {
      assert.deepEqual(deriveImplications({ ...s.input, book: { ...s.input.book, equity_usd: equity } }, s.positions), [], String(equity));
    }
  });

  it("does not throw on lists that are missing or hold junk", () => {
    const s = scene();
    const junk = {
      ...s.input,
      overnight: { markets: undefined, held_movers: [null, { ticker: 7 }], held_news: undefined, filings: [], measurements: [] },
      held_coverage: undefined,
      earnings_next: [null],
      corporate_events: undefined,
      calendar_today: [null, { kind: "data", importance: 3, at: 42 }],
      book: { ...s.input.book, top_weights: undefined },
    } as unknown as ImplicationInput;
    assert.doesNotThrow(() => deriveImplications(junk, s.positions));
    assert.ok(Array.isArray(deriveImplications(junk, s.positions)));
  });

  it("keeps a typed-in symbol's stray characters out of every sentence", () => {
    const names = { "x$y": { value: 30_000, move: -6, vol: 2 }, AAPL: { value: 16_000 } };
    const s = scene({ es: 0.5, names, cash: 54_000 });
    const list = derive(s);
    assert.ok(list.some((i) => i.id === "name_specific:XY"), JSON.stringify(list.map((i) => i.id)));
    for (const i of list) assert.ok(![i.headline, i.because, i.scenario ?? "", ...i.tickers].join(" ").includes("$"), i.id);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Randomised sweep: every sentence, every branch, inside the copy rules
// ---------------------------------------------------------------------------

/** Mulberry32: a small seeded generator, so a failure names a seed that reproduces it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shaped the way assembly leaves a symbol (it drops anything else before a
 * port sees it), with one lower-case spelling so two rows can name one
 * position. A stray character in a typed symbol has its own test above.
 */
const POOL = ["NVDA", "AAPL", "MSFT", "KO", "JNJ", "SPY", "IWM", "QQQ", "XLK", "BRK.B", "TSLA", "EEM", "brk.b"];
const TITLES = [
  "Consumer Price Index",
  "FOMC rate decision",
  "FOMC rate decision and projections",
  "Employment Situation (jobs report)",
  "Producer Price Index",
  "GDP (advance estimate)",
];
const REBALANCE_TITLES = ["S&P quarterly index rebalance", "Nasdaq-100 annual reconstitution", "Russell index reconstitution", "MSCI quarterly index review"];
const CLOCKS = [PRE, IN_SESSION, BETWEEN, "2026-11-27T12:00:00.000Z", "2026-12-18T12:00:00.000Z", "2026-09-08T11:00:00.000Z", "2026-05-12T11:00:00.000Z"];
const FAMILIES: IndexFamily[] = ["sp", "nasdaq100", "russell", "msci"];
const STATES: MarketState[] = ["live", "final", "stale", "unavailable"];

function randomScene(r: () => number): Scene {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
  const chance = (p: number): boolean => r() < p;
  const between = (lo: number, hi: number): number => lo + r() * (hi - lo);

  const now = pick(CLOCKS);
  const count = Math.floor(r() * 8);
  const names: Record<string, NameSpec> = {};
  for (let k = 0; k < count; k++) {
    const ticker = pick(POOL);
    names[ticker] = {
      value: chance(0.05) ? 0 : (chance(0.15) ? -1 : 1) * round(between(50, 60_000), 2),
      beta: chance(0.2) ? null : round(between(-0.6, 2.6), 3),
      vol: chance(0.2) ? null : round(between(0.2, 6), 2),
      move: chance(0.1) ? round(between(-45, 45), 2) : round(between(-7, 7), 2),
      flag: chance(0.08) ? "corporate_action_check" : null,
      coverage: pick<HeldCoverage>(["tracked", "tracked", "price_only", "pending"]),
    };
  }
  const es = chance(0.1) ? null : round(between(-3, 3), 2);
  const s = scene({
    now,
    names,
    cash: round(between(-20_000, 80_000), 2),
    es,
    futures: chance(0.75) ? "live" : pick(STATES),
    risk: chance(0.3) ? null : { matches_book: chance(0.6), beta_eff: chance(0.15) ? null : round(between(-0.8, 2.2), 3) },
    pnl: chance(0.3) ? null : round(between(-4, 4), 2),
  });
  const held = Object.keys(names);
  const target = s.input.window.target_session_ymd;
  const anyName = (): string => (held.length > 0 && chance(0.85) ? pick(held) : pick(POOL));

  const markets = s.input.overnight.markets.map((row) => (chance(0.15) ? { ...row, state: pick(STATES), move: chance(0.5) ? row.move : null } : row));
  const since = Date.parse(s.input.window.overnight_since);
  const held_news = Array.from({ length: Math.floor(r() * 5) }, () =>
    news(anyName(), new Date(since + between(-6, 14) * 3_600_000).toISOString(), chance(0.3) ? [anyName()] : []),
  );
  const earnings_next = Array.from({ length: Math.floor(r() * 4) }, () => {
    const sessions = Math.floor(between(-1, 8));
    return earnings(anyName(), sessions, {
      due_ymd: addTradingDays(target, Math.max(0, sessions)),
      timing: chance(0.5) ? "bmo" : "amc_or_unspecified",
      confirmed: chance(0.6),
    });
  });
  const corporate_events: CorporateEvent[] = [
    ...Array.from({ length: Math.floor(r() * 3) }, () => dividend(anyName(), chance(0.6) ? target : addTradingDays(target, 2))),
    ...Array.from({ length: Math.floor(r() * 3) }, () => {
      const sessions = Math.floor(between(-1, 8));
      const affects = held.filter(() => chance(0.4));
      return rebalance(pick(FAMILIES), addTradingDays(target, Math.max(0, sessions)), sessions, chance(0.2) ? [...affects, "VOO"] : affects, pick(REBALANCE_TITLES));
    }),
  ];
  const calendar_today: CalendarItem[] = Array.from({ length: Math.floor(r() * 5) }, (_, k) => {
    const hh = String(7 + Math.floor(r() * 10)).padStart(2, "0");
    const item = release(`macro:${k}`, chance(0.3) ? "fomc" : "data", `${hh}:${chance(0.5) ? "30" : "00"}`, pick(TITLES), pick([1, 2, 3, 3] as const), target);
    return chance(0.15) ? { ...item, time_et: null, at: null } : item;
  });
  const book = chance(0.1) ? { ...s.input.book, top_weights: [...s.input.book.top_weights].reverse() } : s.input.book;

  return withInput(s, {
    overnight: { ...s.input.overnight, markets, held_news },
    earnings_next,
    corporate_events,
    calendar_today,
    book,
  });
}

describe("implications: copy rules across a randomised sweep", () => {
  it("writes no dollar sign, no long dash and no forbidden word in any sentence, and keeps the list's shape", () => {
    const seen = new Set<ImplicationKind>();
    const r = mulberry32(20260922);
    for (let n = 0; n < 1500; n++) {
      const s = randomScene(r);
      const tickers = [...new Set([...POOL, ...POOL.map((t) => t.toUpperCase().replace(/[^A-Z0-9.=^-]/g, ""))])];
      let list: Implication[] = [];
      assert.doesNotThrow(() => {
        list = derive(s);
      }, `case ${n}`);
      assert.ok(list.length <= MAX_IMPLICATIONS, `case ${n}`);
      assert.equal(new Set(list.map((i) => i.id)).size, list.length, `case ${n}: repeated id in ${list.map((i) => i.id).join(", ")}`);
      assertCopyClean(list, tickers);

      let pastGaps = false;
      // The two scales of `book_pct`: an expected move ranks ahead of a move
      // per 1%, and the size only settles the order inside one of them.
      let lastScale = -1;
      let last = Number.POSITIVE_INFINITY;
      for (const i of list) {
        seen.add(i.kind);
        assert.ok(i.id.startsWith(`${i.kind}:`), i.id);
        assert.ok(i.headline.endsWith(".") && i.because.endsWith(".") && (i.scenario === null || i.scenario.endsWith(".")), i.id);
        assert.ok(i.book_pct === null || Number.isFinite(i.book_pct), i.id);
        assert.ok(i.scenario_usd === null || (Number.isFinite(i.scenario_usd) && i.scenario_usd >= 0), i.id);
        assert.ok(i.tickers.every((t) => !t.includes("$")), i.id);
        if (i.kind === "data_gap") {
          assert.ok(!pastGaps, `case ${n}: a data gap after another kind`);
          continue;
        }
        pastGaps = true;
        const scale =
          i.kind === "open_indication" || i.kind === "name_specific" || (i.kind === "earnings_exposure" && i.scenario !== null) ? 0 : 1;
        assert.ok(scale >= lastScale, `case ${n}: ${i.id} out of order by scale`);
        const size = i.book_pct === null ? -1 : Math.abs(i.book_pct);
        assert.ok(scale > lastScale || size <= last, `case ${n}: ${i.id} out of order`);
        lastScale = scale;
        last = size;
      }

      // The template over the same report stays inside the rules and passes the model's own validator.
      const report: Omit<BriefingReport, "narrative" | "facts_hash"> = {
        ...s.input,
        schema_version: 2,
        demo: false,
        synthetic_now: false,
        corporate_coverage: { dividends: "", splits: "", unknown_symbols: [] },
        calendar_coverage: { from: "2026-01-01", until: "2026-12-31", compiled_at: "2026-09-01", covers_target: true, days_left: 100 },
        headlines: [],
        stories: [],
        implications: list,
        degraded: [],
      };
      const facts = buildNarrativeFacts(report);
      const text = templateNarrative(facts, s.input.generated_at, "h", null).text;
      assert.deepEqual(copyFaults(text, tickers), [], `case ${n}: ${text}`);
      const verdict = validateNarrative(text, facts);
      assert.ok(verdict.ok, verdict.ok ? "" : `case ${n}: ${text} :: ${verdict.reasons.join("; ")}`);
      // The lead opens on the open indication when the list has one (a report
      // with no stories has nothing else to lead with) and on the market list otherwise.
      const open = list.find((i) => i.kind === "open_indication");
      if (open) assert.ok(text.startsWith(open.headline), `case ${n}: ${text}`);
      else assert.ok(!list.some((i) => text.startsWith(i.headline)), `case ${n}: ${text}`);
    }
    // The sweep is only worth its runtime if it reaches every kind.
    assert.deepEqual([...seen].sort(), Object.keys({
      concentration: 1, data_gap: 1, earnings_exposure: 1, event_sensitivity: 1, ex_dividend: 1, index_flow: 1, name_specific: 1, open_indication: 1,
    }).sort());
  });
});
