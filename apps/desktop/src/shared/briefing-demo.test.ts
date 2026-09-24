import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildDemoBriefing } from "./briefing-demo.js";
import {
  BRIEFING_SCHEMA_VERSION,
  MARKET_NEWS_SYMBOLS,
  MARKET_SYMBOLS,
  MAX_IMPLICATIONS,
  MAX_STORIES,
  deriveStories,
  type BriefingHolding,
  type BriefingReport,
  type BriefingWindow,
  type Story,
} from "./briefing-types.js";
import { copyProblems, textProblems } from "./copy-rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The demo seed's generator, copied from `renderer/lib/demo-mode.ts` (which needs React to load). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tuesday 2026-09-22, handed over from Monday's close. Deliberately NOT pre-open, to see it forced. */
const WINDOW: BriefingWindow = {
  target_session_ymd: "2026-09-22",
  prev_session_ymd: "2026-09-21",
  overnight_since: "2026-09-21T20:00:00.000Z",
  window_opens_at: "2026-09-22T00:00:00.000Z",
  target_open_at: "2026-09-22T13:30:00.000Z",
  target_close_at: "2026-09-22T20:00:00.000Z",
  phase: "between_sessions",
  auto_show: true,
  handover: "overnight",
  early_close: false,
};

const COMPANIES = ["NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "LLY", "COST", "PLTR", "AMD", "JPM", "XOM", "NFLX", "MSTR"];
const FUNDS = ["SPY", "VOO", "QQQ", "VTI", "SCHD", "IWM", "SMH", "XLK", "ARKK", "GLD", "TLT", "VXUS", "IBIT", "JEPI"];

function bookOf(symbols: string[]): BriefingHolding[] {
  return symbols.map((symbol, i) => ({ symbol, shares: 5 + i, cost_usd: 1000 + 100 * i }));
}

const SMALL_BOOK = bookOf(["NVDA", "AAPL", "JPM", "SPY", "QQQ"]);
const FULL_BOOK = bookOf([...COMPANIES, ...FUNDS]);
/** The preview harness's fixed book: seven companies, one of them borrowed, and three funds. */
const STAGE_BOOK: BriefingHolding[] = [
  { symbol: "NVDA", shares: 120, cost_usd: 21_000 },
  { symbol: "AAPL", shares: 80, cost_usd: 16_500 },
  { symbol: "MSFT", shares: 40, cost_usd: 15_800 },
  { symbol: "AVGO", shares: 60, cost_usd: 14_900 },
  { symbol: "LLY", shares: 12, cost_usd: 9_800 },
  { symbol: "JPM", shares: 50, cost_usd: 12_400 },
  { symbol: "TSLA", shares: -20, cost_usd: -6_900 },
  { symbol: "SPY", shares: 45, cost_usd: 26_500 },
  { symbol: "QQQ", shares: 30, cost_usd: 15_200 },
  { symbol: "TLT", shares: 100, cost_usd: 9_300 },
];

function build(seed: number, positions: BriefingHolding[] = SMALL_BOOK, cash = 5_000, window: BriefingWindow = WINDOW): BriefingReport {
  return buildDemoBriefing(mulberry32(seed), window, positions, cash);
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);
/** The task's bar for the stories: 50 seeds, 4 to 6 stories in at least 45 of them. */
const STORY_SEEDS = SEEDS.slice(0, 50);

/** Every leaf of the report with its path, so a failure names the field. */
function leaves(value: unknown, at = "report"): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
  }
  return [[at, value]];
}

function isWeekend(ymd: string): boolean {
  const day = new Date(`${ymd}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Weekdays in (from, to]: what `sessions_until` means in a calendar with no holidays. */
function weekdaysAfter(from: string, to: string): number {
  let count = 0;
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let t = Date.parse(`${from}T00:00:00.000Z`) + 86_400_000; t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/** The engine's own sentence split, minus its abbreviation list: the lead here never uses one. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?]["')\]]?)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The three sentences of a story, the ones a reader sees. */
function storyText(story: Story): string[] {
  return [story.what, story.reaction, ...(story.meaning === null ? [] : [story.meaning])];
}

function storyOf(report: BriefingReport, id: string): Story {
  const story = report.stories.find((s) => s.id === id);
  assert.ok(story, `no story ${id} among ${report.stories.map((s) => s.id).join(", ")}`);
  return story;
}

describe("buildDemoBriefing: determinism and frame", () => {
  it("gives the same report for the same seed", () => {
    assert.deepEqual(build(42), build(42));
    assert.deepEqual(build(42, FULL_BOOK), build(42, FULL_BOOK));
    assert.deepEqual(build(42, STAGE_BOOK, 18_400), build(42, STAGE_BOOK, 18_400));
  });

  it("gives a different report for a different seed", () => {
    assert.notDeepEqual(build(42), build(43));
    assert.notEqual(build(42).facts_hash, build(43).facts_hash);
  });

  it("is a demo report in the pre-open phase that never shows itself", () => {
    const r = build(7);
    assert.equal(r.demo, true);
    assert.equal(r.synthetic_now, false);
    // The engine's constant, read through the renderer's re-export: a bump
    // there fails here until the demo writes the fields that came with it.
    assert.equal(r.schema_version, BRIEFING_SCHEMA_VERSION);
    assert.equal(r.window.phase, "pre_open");
    assert.equal(r.window.auto_show, false);
    assert.equal(r.window.target_session_ymd, WINDOW.target_session_ymd);
    assert.equal(r.window.overnight_since, WINDOW.overnight_since);
    assert.deepEqual(r.degraded, []);
  });

  it("is stamped 2 h 14 min before the target open", () => {
    const r = build(7);
    assert.equal(r.generated_at, "2026-09-22T11:16:00.000Z");
    assert.equal(r.book.priced_at, r.generated_at);
    assert.equal(r.narrative.generated_at, r.generated_at);
  });

  it("does not mutate its inputs", () => {
    const positions = bookOf(["NVDA", "SPY"]);
    const before = JSON.stringify([positions, WINDOW]);
    build(3, positions);
    assert.equal(JSON.stringify([positions, WINDOW]), before);
  });
});

describe("buildDemoBriefing: overnight markets", () => {
  const EXPECTED: Array<[string, string, string]> = [
    ["^N225", "asia", "pct"],
    ["^HSI", "asia", "pct"],
    ["000001.SS", "asia", "pct"],
    ["^AXJO", "asia", "pct"],
    ["^STOXX50E", "europe", "pct"],
    ["^GDAXI", "europe", "pct"],
    ["^FTSE", "europe", "pct"],
    ["^FCHI", "europe", "pct"],
    ["ES=F", "us_futures", "pct"],
    ["NQ=F", "us_futures", "pct"],
    ["YM=F", "us_futures", "pct"],
    ["RTY=F", "us_futures", "pct"],
    ["^VIX", "macro", "pts"],
    ["DX-Y.NYB", "macro", "pct"],
    ["CL=F", "macro", "pct"],
    ["GC=F", "macro", "pct"],
    ["^TNX", "macro", "bp"],
  ];

  it("carries all 17 rows, in the engine's order, with its groups and units", () => {
    const rows = build(11).overnight.markets;
    assert.deepEqual(rows.map((r) => [r.symbol, r.group, r.unit]), EXPECTED);
    for (const r of rows) {
      const future = r.symbol.endsWith("=F");
      assert.equal(r.basis, future ? "prior_settle" : "prev_close", r.symbol);
      assert.ok(r.label.length > 0);
    }
  });

  it("matches the engine's own table field for field, labels and bases included", () => {
    // The list above is kept by hand, and so is the demo's. This one is not:
    // a symbol, label, unit or basis changed in the engine fails here until
    // the demo follows, instead of the two tables drifting apart unnoticed.
    const want = MARKET_SYMBOLS.map((d) => [d.symbol, d.label, d.group, d.unit, d.basis]);
    for (const seed of SEEDS.slice(0, 20)) {
      const rows = build(seed).overnight.markets;
      assert.deepEqual(rows.map((r) => [r.symbol, r.label, r.group, r.unit, r.basis]), want, `seed ${seed}`);
    }
  });

  it("marks Asia final, Europe and futures live, and at most one European row stale", () => {
    for (const seed of SEEDS) {
      const rows = build(seed).overnight.markets;
      const stale = rows.filter((r) => r.state === "stale");
      assert.ok(stale.length <= 1, `seed ${seed}`);
      for (const r of rows) {
        if (r.state === "stale") {
          // Europe, not Asia: the Asian session is told as one story, which
          // the engine tells only when every row in the region printed.
          assert.equal(r.group, "europe");
          assert.equal(r.move, null);
          assert.ok(r.last !== null && r.as_of !== null);
          assert.ok(Date.parse(r.as_of) < Date.parse(WINDOW.overnight_since), "a stale print predates the last US close");
          continue;
        }
        assert.equal(r.state, r.group === "asia" ? "final" : "live", `${r.symbol} seed ${seed}`);
        assert.ok(r.move !== null && r.last !== null && r.prev_close !== null && r.as_of !== null);
        assert.ok(Date.parse(r.as_of) >= Date.parse(WINDOW.overnight_since));
        assert.ok(Date.parse(r.as_of) <= Date.parse(build(seed).generated_at));
      }
    }
  });

  it("closes Asia lower across the board, past 1% on average", () => {
    for (const seed of SEEDS) {
      const asia = build(seed).overnight.markets.filter((r) => r.group === "asia");
      assert.equal(asia.length, 4);
      for (const r of asia) assert.ok(r.move !== null && r.move < 0, `${r.symbol} seed ${seed}: ${r.move}`);
      const average = asia.reduce((sum, r) => sum + Math.abs(r.move ?? 0), 0) / asia.length;
      assert.ok(average >= 1, `seed ${seed}: Asia averaged ${average}`);
    }
  });

  it("exercises the stale design about one time in three", () => {
    const stale = SEEDS.filter((seed) => build(seed).overnight.markets.some((r) => r.state === "stale")).length;
    assert.ok(stale > SEEDS.length * 0.15 && stale < SEEDS.length * 0.55, `${stale} of ${SEEDS.length}`);
  });

  it("states each move in the row's own unit, from the two levels beside it", () => {
    for (const r of build(5).overnight.markets) {
      if (r.move === null || r.last === null || r.prev_close === null) continue;
      const expected =
        r.unit === "pct" ? (r.last / r.prev_close - 1) * 100 : r.unit === "pts" ? r.last - r.prev_close : (r.last - r.prev_close) * 100;
      assert.ok(Math.abs(r.move - expected) < 0.051, `${r.symbol}: ${r.move} vs ${expected}`);
      assert.ok(Math.abs(r.move) < (r.unit === "bp" ? 12 : 4), `${r.symbol} moved ${r.move}`);
    }
  });
});

describe("buildDemoBriefing: held names", () => {
  it("gives every held symbol a mover and a coverage row", () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const r = build(seed, FULL_BOOK);
      const held = FULL_BOOK.map((p) => p.symbol).sort();
      assert.deepEqual(r.overnight.held_movers.map((m) => m.ticker).sort(), held);
      assert.deepEqual(r.held_coverage.map((c) => c.ticker).sort(), held);
    }
  });

  it("merges two spellings of one symbol and drops a flat row", () => {
    const r = build(9, [
      { symbol: "nvda", shares: 4, cost_usd: 800 },
      { symbol: "NVDA ", shares: 6, cost_usd: 1300 },
      { symbol: "AAPL", shares: 0, cost_usd: 0 },
      { symbol: "MSFT", shares: Number.NaN, cost_usd: 10 },
    ]);
    assert.deepEqual(r.held_coverage.map((c) => c.ticker), ["NVDA"]);
    assert.equal(r.book.position_count, 1);
    const mover = r.overnight.held_movers[0];
    assert.ok(Math.abs(mover.pnl_usd - 10 * (mover.last - mover.ref_close)) < 0.011);
  });

  it("orders movers by the size of the move and measures them since the close", () => {
    const movers = build(21, FULL_BOOK).overnight.held_movers;
    for (let i = 1; i < movers.length; i++) assert.ok(Math.abs(movers[i - 1].move_pct) >= Math.abs(movers[i].move_pct));
    for (const m of movers) {
      assert.equal(m.basis, "since_close");
      assert.equal(m.session, "pre");
      assert.equal(m.flag, null);
      assert.ok(Math.abs(m.move_pct - (m.last / m.ref_close - 1) * 100) < 0.006);
    }
  });

  it("moves an index fund with the markets row it tracks", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const r = build(seed, FULL_BOOK);
      const row = (symbol: string): number => r.overnight.markets.find((m) => m.symbol === symbol)?.move ?? Number.NaN;
      const held = (ticker: string): number => r.overnight.held_movers.find((m) => m.ticker === ticker)?.move_pct ?? Number.NaN;
      assert.ok(Math.abs(held("SPY") - row("ES=F")) < 0.1, `seed ${seed}: SPY ${held("SPY")} vs ES ${row("ES=F")}`);
      assert.ok(Math.abs(held("QQQ") - row("NQ=F")) < 0.1, `seed ${seed}: QQQ ${held("QQQ")} vs NQ ${row("NQ=F")}`);
      assert.ok(Math.abs(held("IWM") - row("RTY=F")) < 0.1, `seed ${seed}: IWM ${held("IWM")} vs RTY ${row("RTY=F")}`);
    }
  });

  it("files funds as price-only and keeps headlines to tracked names", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const r = build(seed, FULL_BOOK);
      const coverage = new Map(r.held_coverage.map((c) => [c.ticker, c.coverage]));
      for (const fund of FUNDS) assert.equal(coverage.get(fund), "price_only");
      assert.ok(r.overnight.held_news.length >= 2 && r.overnight.held_news.length <= 4, `seed ${seed}`);
      for (const n of r.overnight.held_news) {
        assert.equal(coverage.get(n.ticker), "tracked");
        assert.ok(n.headline.length > 0 && n.url.startsWith("https://example.com/"));
        assert.ok(Date.parse(n.published_at) >= Date.parse(WINDOW.overnight_since));
        assert.ok(Date.parse(n.published_at) <= Date.parse(r.generated_at));
        for (const other of n.also) assert.ok(coverage.has(other) && other !== n.ticker);
      }
      for (const m of r.overnight.held_movers) {
        if (coverage.get(m.ticker) === "pending") assert.equal(m.move_z, null);
        else assert.notEqual(m.move_z, null);
      }
      for (const f of r.overnight.filings) {
        assert.ok(COMPANIES.includes(f.ticker));
        assert.notEqual(coverage.get(f.ticker), "pending", `${f.ticker} seed ${seed}: a filing on a name the chain does not follow`);
        assert.ok(Date.parse(f.filed_at) >= Date.parse(WINDOW.overnight_since));
        assert.ok(Date.parse(f.filed_at) <= Date.parse(r.generated_at));
      }
      assert.ok(r.overnight.measurements.length >= 1);
      for (const m of r.overnight.measurements) assert.ok(coverage.has(m.ticker));
    }
  });

  it("falls back to a generic headline for a symbol outside the pools", () => {
    const r = build(4, [{ symbol: "ZZZZ", shares: 10, cost_usd: 500 }]);
    assert.equal(r.overnight.held_news.length, 1);
    assert.ok(r.overnight.held_news[0].headline.startsWith("ZZZZ "));
    // Priced at its own cost basis (50 a share), give or take the demo's jitter.
    assert.ok(Math.abs(r.overnight.held_movers[0].ref_close - 50) < 2);
  });
});

describe("buildDemoBriefing: the cast", () => {
  const BOOKS: Array<[string, BriefingHolding[]]> = [
    ["small", SMALL_BOOK],
    ["stage", STAGE_BOOK],
    ["full pool", FULL_BOOK],
  ];

  it("gives one held name a top-band headline and a move past 1.5%, with a story about it", () => {
    for (const [name, positions] of BOOKS) {
      for (const seed of STORY_SEEDS) {
        const r = build(seed, positions);
        const top = r.overnight.held_news.filter((n) => n.band === "P0");
        assert.equal(top.length, 1, `${name} seed ${seed}: ${top.length} top-band headlines`);
        const lead = top[0];
        assert.equal(r.held_coverage.find((c) => c.ticker === lead.ticker)?.coverage, "tracked");
        const mover = r.overnight.held_movers.find((m) => m.ticker === lead.ticker);
        assert.ok(mover && Math.abs(mover.move_pct) > 1.5, `${name} seed ${seed}: ${lead.ticker} moved ${mover?.move_pct}`);
        // The headline reads the way the name moved: an outlook lifted beside
        // a drop would be caught from the back of the room.
        const story = storyOf(r, `story:name:${lead.ticker}`);
        assert.equal(story.scope, "name");
        assert.ok(story.reaction.includes(`${Math.abs(mover.move_pct)}%`), `${name} seed ${seed}: "${story.reaction}"`);
        assert.ok(story.reaction.includes(mover.move_pct < 0 ? "down" : "up"), story.reaction);
        assert.ok(story.evidence.includes(lead.incident_id), `${name} seed ${seed}: the headline is not in the evidence`);
      }
    }
  });

  it("gives another held name a results filing and a move, and leads with it", () => {
    for (const [name, positions] of BOOKS) {
      for (const seed of STORY_SEEDS) {
        const r = build(seed, positions);
        const results = r.overnight.filings.filter((f) => /\b2\.02\b/.test(f.label));
        assert.equal(results.length, 1, `${name} seed ${seed}: ${results.length} results filings`);
        const filing = results[0];
        assert.equal(filing.kind, "filing");
        const mover = r.overnight.held_movers.find((m) => m.ticker === filing.ticker);
        assert.ok(mover && Math.abs(mover.move_pct) >= 1, `${name} seed ${seed}: ${filing.ticker} moved ${mover?.move_pct}`);
        // The results filing lands in the hour or so after the close.
        assert.ok(Date.parse(filing.filed_at) - Date.parse(WINDOW.overnight_since) <= 76 * 60_000, filing.filed_at);
        // Results outrank everything else in the engine's ranking, so this is the first story.
        const story = r.stories[0];
        assert.equal(story.id, `story:name:${filing.ticker}`, `${name} seed ${seed}: led by ${story.id}`);
        assert.equal(story.what, `${filing.ticker} reported results`);
        assert.ok(story.reaction.includes(`${Math.abs(mover.move_pct)}%`), story.reaction);
        // A name that has just reported is not also due to report soon.
        assert.ok(!r.earnings_next.some((e) => e.ticker === filing.ticker), `${name} seed ${seed}: ${filing.ticker} reports twice`);
        // Its headline (a second name in every book here) lands minutes after the 8-K.
        const wire = r.overnight.held_news.find((n) => n.ticker === filing.ticker && n.band === "P1");
        assert.ok(wire, `${name} seed ${seed}: no results headline on ${filing.ticker}`);
        assert.ok(Date.parse(wire.published_at) >= Date.parse(filing.filed_at));
        assert.notEqual(wire.ticker, r.overnight.held_news.find((n) => n.band === "P0")?.ticker);
      }
    }
  });

  it("puts both roles on the one name when only one company is held", () => {
    const r = build(4, [{ symbol: "ZZZZ", shares: 10, cost_usd: 500 }]);
    assert.deepEqual(r.overnight.held_news.map((n) => [n.ticker, n.band]), [["ZZZZ", "P0"]]);
    assert.deepEqual(r.overnight.filings.map((f) => f.ticker), ["ZZZZ"]);
    assert.equal(r.stories[0]?.what, "ZZZZ reported results");
  });

  it("labels filings the way the chain does, so the engine reads the form off them", () => {
    const labels = new Set<string>();
    for (const seed of SEEDS) for (const f of build(seed, FULL_BOOK).overnight.filings) labels.add(`${f.kind}|${f.label}`);
    assert.deepEqual(
      [...labels].sort(),
      ["filing|8-K, item 7.01 (Regulation FD disclosure)", "filing|8-K, items 2.02, 9.01 (results of operations)", "insider|Insider filing (Form 4)"],
    );
    // The Regulation FD form is read off the label as "8-K" and nothing longer.
    const seed = SEEDS.find((s) => build(s, FULL_BOOK).overnight.filings.some((f) => f.label.includes("7.01")));
    assert.ok(seed !== undefined);
    const r = build(seed, FULL_BOOK);
    const fd = r.overnight.filings.find((f) => f.label.includes("7.01"))!;
    const story = r.stories.find((s) => s.id === `story:name:${fd.ticker}`);
    if (story) assert.ok(story.what === `${fd.ticker} filed a new 8-K since the close` || story.what.startsWith(`${fd.ticker} `), story.what);
  });
});

describe("buildDemoBriefing: market headlines", () => {
  it("carries four to six market headlines since the close, newest first, one per article", () => {
    for (const seed of SEEDS) {
      const r = build(seed);
      const h = r.headlines;
      assert.ok(h.length >= 4 && h.length <= 6, `seed ${seed}: ${h.length} headlines`);
      assert.equal(new Set(h.map((x) => x.url)).size, h.length, `seed ${seed}: a url repeats`);
      assert.equal(new Set(h.map((x) => x.id)).size, h.length, `seed ${seed}: an id repeats`);
      for (let i = 1; i < h.length; i++) assert.ok(h[i - 1].published_at >= h[i].published_at, `seed ${seed}: not newest first`);
      for (const x of h) {
        assert.ok(x.title.length > 0 && !x.title.includes("$"), x.title);
        assert.ok(x.url.startsWith("https://example.com/"), x.url);
        assert.ok(x.source.length > 0);
        assert.ok(Date.parse(x.published_at) >= Date.parse(WINDOW.overnight_since), x.published_at);
        assert.ok(Date.parse(x.published_at) <= Date.parse(r.generated_at), x.published_at);
        assert.ok(x.related.length > 0, x.id);
        // Surfaced by one of the query symbols the real port asks the provider about.
        assert.ok(MARKET_NEWS_SYMBOLS.includes(x.via), `${x.id} via ${x.via}`);
      }
    }
  });

  it("words a headline the way the row it reads moved", () => {
    let seen = 0;
    for (const seed of SEEDS) {
      const r = build(seed);
      const es = r.overnight.markets.find((m) => m.symbol === "ES=F")?.move ?? 0;
      const futures = r.headlines.find((h) => h.id === "demo-headline-futures");
      if (!futures) continue;
      seen++;
      assert.ok(futures.title.includes(es < 0 ? "lower" : "higher"), `seed ${seed}: ES ${es}, "${futures.title}"`);
    }
    assert.ok(seen > 10, `${seen} seeds carried the futures headline`);
  });
});

describe("buildDemoBriefing: stories", () => {
  const BOOKS: Array<[string, BriefingHolding[], number]> = [
    ["small", SMALL_BOOK, 5_000],
    ["stage", STAGE_BOOK, 18_400],
    ["full pool", FULL_BOOK, 25_000],
  ];

  it("tells four to six stories on nearly every seed, never more than the cap", () => {
    for (const [name, positions, cash] of BOOKS) {
      let inRange = 0;
      for (const seed of STORY_SEEDS) {
        const n = build(seed, positions, cash).stories.length;
        assert.ok(n <= MAX_STORIES, `${name} seed ${seed}: ${n} stories`);
        if (n >= 4 && n <= 6) inRange++;
      }
      assert.ok(inRange >= 45, `${name}: ${inRange} of ${STORY_SEEDS.length} seeds gave 4 to 6 stories`);
    }
  });

  it("tells them with the engine's own rule over the report's own body", () => {
    for (const [, positions, cash] of BOOKS) {
      for (const seed of STORY_SEEDS.slice(0, 20)) {
        const r = build(seed, positions, cash);
        assert.deepEqual(r.stories, deriveStories(r), `seed ${seed}`);
      }
    }
  });

  it("tells the Asian session as one story and the tape with live futures", () => {
    for (const [name, positions, cash] of BOOKS) {
      for (const seed of STORY_SEEDS) {
        const r = build(seed, positions, cash);
        const asia = storyOf(r, "story:market:asia");
        assert.equal(asia.what, "Asia closed lower across the board", `${name} seed ${seed}`);
        assert.deepEqual(asia.reactions.map((c) => c.symbol), ["^N225", "^HSI", "000001.SS", "^AXJO"]);
        for (const chip of asia.reactions) assert.ok(chip.move !== null && chip.move < 0);

        const tape = storyOf(r, "story:market:tape");
        assert.equal(tape.what, `Overnight, the tape has ${r.headlines.length} market headlines`);
        assert.deepEqual(tape.reactions.map((c) => c.symbol), ["ES=F", "NQ=F", "^VIX"]);
        for (const chip of tape.reactions) assert.ok(chip.move !== null, `${name} seed ${seed}: ${chip.symbol} has no move`);
        assert.ok(tape.reaction.startsWith("S&P 500 futures are "), tape.reaction);
        // The open indication is what the futures mean for this book; the
        // demo's futures and book beta always let the engine size it, and on
        // a flat night it reads "little change" with no figure.
        assert.ok(tape.meaning !== null && tape.meaning.startsWith("Overnight futures point to"), `${name} seed ${seed}: ${tape.meaning}`);
      }
    }
  });

  it("gives a held name's story the conclusion about it as its meaning", () => {
    let seen = 0;
    for (const seed of STORY_SEEDS) {
      const r = build(seed, STAGE_BOOK, 18_400);
      for (const story of r.stories) {
        if (story.scope !== "name") continue;
        const own = r.implications.find((i) => i.id === `name_specific:${story.tickers[0]}`);
        if (!own) {
          assert.equal(story.meaning, null, `seed ${seed}: ${story.id} has a meaning with no conclusion behind it`);
          continue;
        }
        seen++;
        assert.equal(story.meaning, own.headline, `seed ${seed}: ${story.id}`);
        assert.ok(story.evidence.includes(own.id));
      }
    }
    assert.ok(seen > 20, `${seen} name stories carried a conclusion`);
  });

  it("keeps every story sentence clean, dollar-free and in its own words", () => {
    for (const [name, positions, cash] of BOOKS) {
      for (const seed of STORY_SEEDS) {
        const r = build(seed, positions, cash);
        assert.equal(new Set(r.stories.map((s) => s.id)).size, r.stories.length, `${name} seed ${seed}: an id repeats`);
        const titles = [...r.headlines.map((h) => h.title), ...r.overnight.held_news.map((n) => n.headline)];
        for (const story of r.stories) {
          assert.equal(story.source, "template");
          assert.ok(["market", "name", "release"].includes(story.scope));
          assert.ok(story.what.length > 0 && story.reaction.length > 0, `${name} seed ${seed}: ${story.id}`);
          for (const text of storyText(story)) {
            assert.deepEqual(textProblems(text, { riskWords: true }), [], `${name} seed ${seed}: ${story.id}: "${text}"`);
            assert.ok(!text.includes("$"), `${name} seed ${seed}: ${story.id}: "${text}"`);
            // Headlines are third-party text: counted and named in the
            // evidence, never pasted into a sentence.
            for (const title of titles) assert.ok(!text.includes(title), `${name} seed ${seed}: ${story.id} quotes "${title}"`);
          }
        }
      }
    }
  });

  it("tells the tape and Asia, and nothing about names, for a book with nothing in it", () => {
    const r = build(41, [], 10_000);
    assert.deepEqual(r.stories.map((s) => s.id), ["story:market:tape", "story:market:asia"]);
    assert.ok(r.headlines.length >= 4);
  });
});

describe("buildDemoBriefing: book and risk", () => {
  it("adds up: equity is cash plus positions, and the weights sum to one", () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const r = build(seed, SMALL_BOOK, 5_000);
      const last = new Map(r.overnight.held_movers.map((m) => [m.ticker, m.last]));
      const positions = SMALL_BOOK.reduce((sum, p) => sum + p.shares * (last.get(p.symbol) ?? Number.NaN), 0);
      assert.ok(Math.abs(r.book.equity_usd - (5_000 + positions)) < 0.011);
      assert.ok(Math.abs(r.book.invested_usd - positions) < 0.011);
      assert.equal(r.book.cash_usd, 5_000);
      assert.equal(r.book.position_count, SMALL_BOOK.length);
      assert.deepEqual(r.book.unpriced, []);

      const weightSum = r.book.top_weights.reduce((s, w) => s + w.weight, 0);
      assert.ok(Math.abs(weightSum - 1) < 0.001, `weights sum to ${weightSum}`);
      for (let i = 1; i < r.book.top_weights.length; i++) {
        assert.ok(r.book.top_weights[i - 1].weight >= r.book.top_weights[i].weight);
      }

      const pnl = r.overnight.held_movers.reduce((s, m) => s + m.pnl_usd, 0);
      assert.ok(r.book.overnight_pnl_usd !== null && Math.abs(r.book.overnight_pnl_usd - pnl) < 0.05);
      assert.ok(Math.abs(r.book.net_exposure_pct - (positions / r.book.equity_usd) * 100) < 0.011);
      assert.equal(r.book.net_exposure_pct, r.book.gross_exposure_pct);
    }
  });

  it("caps the weights list at five and keeps it within one", () => {
    const r = build(8, FULL_BOOK, 12_000);
    assert.equal(r.book.top_weights.length, 5);
    assert.ok(r.book.top_weights.reduce((s, w) => s + w.weight, 0) <= 1);
  });

  it("carries a borrowed position with its sign", () => {
    const r = build(13, [
      { symbol: "NVDA", shares: 20, cost_usd: 4_000 },
      { symbol: "TSLA", shares: -5, cost_usd: -1_700 },
    ], 10_000);
    const tsla = r.overnight.held_movers.find((m) => m.ticker === "TSLA");
    assert.ok(tsla);
    assert.equal(Math.sign(tsla.pnl_usd), -Math.sign(tsla.last - tsla.ref_close) || 0);
    assert.equal(r.book.top_weights.find((w) => w.ticker === "TSLA")?.side, "short");
    assert.ok(r.book.gross_exposure_pct > r.book.net_exposure_pct);
  });

  it("scores the book it shows, with a band and a plain driver sentence", () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const r = build(seed);
      assert.ok(r.risk);
      assert.equal(r.risk.matches_book, true);
      assert.ok(r.risk.score !== null && r.risk.score >= 0 && r.risk.score <= 100);
      assert.ok(r.risk.band !== null && ["low", "moderate", "elevated", "high"].includes(r.risk.band));
      const top = r.book.top_weights[0];
      assert.equal(r.risk.driver_sentence, `${Math.round(top.weight * 100)}% of the portfolio sits in ${top.ticker}.`);
      assert.deepEqual(textProblems(r.risk.driver_sentence ?? "", { riskWords: true }), []);
    }
  });

  // `beta_port` is the book's beta, signed by side; `beta_eff` is its size
  // times the invested fraction, the way `risk/components.ts` defines the two.
  // Drawn at random the book beta was always positive, and a book that is net
  // borrowed moves against the index, so a demo short book was sized backwards.
  it("signs the book beta against a book that is net borrowed", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const held = build(seed, bookOf(["NVDA", "AAPL"]), 10_000).risk;
      assert.ok(held && held.beta_port !== null && held.beta_port > 0, `seed ${seed}: ${held?.beta_port}`);

      const borrowed = build(seed, [
        { symbol: "NVDA", shares: -6, cost_usd: -1_200 },
        { symbol: "AAPL", shares: -4, cost_usd: -900 },
      ], 10_000).risk;
      assert.ok(borrowed && borrowed.beta_port !== null && borrowed.beta_port < 0, `seed ${seed}: ${borrowed?.beta_port}`);
      assert.ok(borrowed.beta_eff !== null && borrowed.beta_eff >= 0, `seed ${seed}: ${borrowed.beta_eff}`);
    }
  });
});

describe("buildDemoBriefing: conclusions", () => {
  it("leads with conclusions on every seed and book, within the contract's cap", () => {
    for (const seed of SEEDS) {
      for (const positions of [SMALL_BOOK, FULL_BOOK]) {
        const r = build(seed, positions);
        assert.ok(r.implications.length >= 1, `seed ${seed}: the demo report draws no conclusions`);
        assert.ok(r.implications.length <= MAX_IMPLICATIONS, `seed ${seed}: ${r.implications.length} conclusions`);
        assert.equal(new Set(r.implications.map((i) => i.id)).size, r.implications.length, `seed ${seed}`);
        for (const i of r.implications) {
          assert.ok(i.headline.length > 0 && i.because.length > 0, `seed ${seed}: ${i.id}`);
          for (const text of [i.headline, i.because, i.scenario ?? ""]) {
            assert.deepEqual(textProblems(text, { riskWords: true }), [], `seed ${seed}: ${i.id}`);
          }
        }
      }
    }
  });

  // The one dollar figure a conclusion may carry is `scenario_usd`, which the
  // panel shows beside the scenario and hides in privacy mode. A sentence that
  // spelled the same amount out would walk straight past that switch, and so
  // would a story or a lead built over it.
  it("keeps account dollars out of every sentence, whatever the book is worth", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const r = build(seed, FULL_BOOK, 250_000);
      for (const i of r.implications) {
        for (const text of [i.headline, i.because, i.scenario ?? ""]) assert.ok(!text.includes("$"), `${i.id}: ${text}`);
      }
      for (const story of r.stories) for (const text of storyText(story)) assert.ok(!text.includes("$"), `${story.id}: ${text}`);
      assert.ok(!r.narrative.text.includes("$"), r.narrative.text);
    }
  });

  it("gives each held name the beta and the daily range its conclusions are drawn from", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const r = build(seed, FULL_BOOK);
      const coverage = new Map(r.held_coverage.map((c) => [c.ticker, c.coverage]));
      for (const m of r.overnight.held_movers) {
        // A pending name has no history behind it, so all three read null together.
        if (coverage.get(m.ticker) === "pending") {
          assert.equal(m.beta, null, m.ticker);
          assert.equal(m.daily_vol_pct, null, m.ticker);
          assert.equal(m.move_z, null, m.ticker);
          continue;
        }
        assert.ok(m.beta !== null && Number.isFinite(m.beta), `${m.ticker}: ${m.beta}`);
        assert.ok(m.daily_vol_pct !== null && m.daily_vol_pct > 0, `${m.ticker}: ${m.daily_vol_pct}`);
        // The multiple beside it is measured in exactly this yardstick.
        assert.ok(Math.abs((m.move_z ?? 0) - m.move_pct / (m.daily_vol_pct ?? 1)) < 0.03, `${m.ticker}: ${m.move_z}`);
      }
      // Long bonds run against the index, so the demo's betas are not all one sign.
      assert.ok((r.overnight.held_movers.find((m) => m.ticker === "TLT")?.beta ?? 0) < 0, `seed ${seed}`);
    }
  });

  it("draws no conclusions from a book with nothing in it", () => {
    assert.deepEqual(build(41, [], 10_000).implications, []);
  });
});

describe("buildDemoBriefing: corporate events", () => {
  it("dates every event on a weekday, the stated number of sessions out", () => {
    for (const seed of SEEDS) {
      const r = build(seed, FULL_BOOK);
      for (const e of [...r.corporate_events, ...r.earnings_next.map((x) => ({ date: x.due_ymd, sessions_until: x.sessions_until, id: x.ticker }))]) {
        assert.ok(!isWeekend(e.date), `${e.id} on a weekend`);
        assert.equal(e.sessions_until, weekdaysAfter(WINDOW.target_session_ymd, e.date), `${e.id} seed ${seed}`);
        assert.ok(e.sessions_until >= 0);
      }
      for (let i = 1; i < r.corporate_events.length; i++) {
        assert.ok(r.corporate_events[i - 1].date <= r.corporate_events[i].date);
      }
      assert.equal(new Set(r.corporate_events.map((e) => e.id)).size, r.corporate_events.length);
    }
  });

  it("always has an estimated item when a company is held", () => {
    for (const seed of SEEDS) {
      const r = build(seed);
      assert.ok(r.corporate_events.some((e) => e.certainty === "estimated"), `seed ${seed}`);
      assert.ok(r.earnings_next.length >= 1 && r.earnings_next.length <= 2);
      for (const e of r.earnings_next) assert.ok(e.sessions_until <= 9);
    }
  });

  it("mirrors each held earnings date as a corporate event", () => {
    const r = build(17, FULL_BOOK);
    for (const e of r.earnings_next) {
      const event = r.corporate_events.find((c) => c.kind === "earnings" && c.ticker === e.ticker);
      assert.ok(event);
      assert.equal(event.date, e.due_ymd);
      assert.equal(event.certainty, e.confirmed ? "confirmed" : "estimated");
    }
  });

  it("gives dividends to the payers held, and only to them", () => {
    const r = build(19, bookOf(["AAPL", "TSLA", "AMZN", "SPY"]));
    const dividends = r.corporate_events.filter((e) => e.kind === "dividend");
    assert.deepEqual(dividends.map((d) => d.ticker), ["AAPL"]);
    assert.deepEqual(dividends[0].affects_held, ["AAPL"]);
    assert.ok(dividends[0].detail.includes("$0.26 per share"));
  });

  it("ties a rebalance to the held funds that track the index", () => {
    const r = build(23, bookOf(["NVDA", "SPY", "XLK", "QQQ", "GLD"]));
    const rebalances = r.corporate_events.filter((e) => e.kind === "rebalance");
    assert.deepEqual(rebalances.map((e) => e.index).sort(), ["nasdaq100", "sp"]);
    const sp = rebalances.find((e) => e.index === "sp");
    assert.ok(sp);
    assert.deepEqual(sp.affects_held, ["SPY", "XLK"]);
    assert.equal(sp.ticker, null);
    assert.equal(sp.certainty, "rule");
    assert.equal(sp.source, "rule");
    assert.equal(new Date(`${sp.date}T00:00:00.000Z`).getUTCDay(), 5);
    assert.ok(sp.detail.includes("SPY, XLK"));
  });

  it("shows a Russell reconstitution as announced, never as a rule date", () => {
    const r = build(23, bookOf(["NVDA", "IWM"]));
    const russell = r.corporate_events.find((e) => e.kind === "rebalance" && e.index === "russell");
    assert.ok(russell);
    assert.equal(russell.certainty, "confirmed");
    assert.equal(russell.source, "curated");
    assert.deepEqual(russell.affects_held, ["IWM"]);
  });

  it("says what the list cannot know, and names the funds it has nothing for", () => {
    const r = build(29);
    assert.ok(r.corporate_coverage.dividends.includes("fund distributions are not available"));
    assert.ok(r.corporate_coverage.splits.includes("Upcoming splits are not available"));
    assert.deepEqual(r.corporate_coverage.unknown_symbols, ["SPY", "QQQ"]);
  });
});

describe("buildDemoBriefing: today's calendar", () => {
  it("lists all-day items first, then by time", () => {
    for (const seed of SEEDS) {
      const items = build(seed, FULL_BOOK).calendar_today;
      const firstTimed = items.findIndex((c) => c.time_et !== null);
      const timed = firstTimed === -1 ? [] : items.slice(firstTimed);
      assert.ok(timed.every((c) => c.time_et !== null), `seed ${seed}: an all-day item after a timed one`);
      for (let i = 1; i < timed.length; i++) assert.ok((timed[i - 1].time_et ?? "") <= (timed[i].time_et ?? ""));
      assert.equal(new Set(items.map((c) => c.id)).size, items.length);
      for (const c of items) assert.equal(c.at === null, c.time_et === null);
    }
  });

  it("shows a rate decision or a handful of releases, never both", () => {
    let fomc = 0;
    let opex = 0;
    for (const seed of SEEDS) {
      const items = build(seed).calendar_today;
      const data = items.filter((c) => c.kind === "data");
      if (items.some((c) => c.kind === "fomc")) {
        fomc++;
        assert.equal(data.length, 0);
      } else {
        assert.ok(data.length >= 2 && data.length <= 4, `seed ${seed}: ${data.length} releases`);
        for (const d of data) assert.ok(d.time_et === "08:30" || d.time_et === "10:00");
      }
      if (items.some((c) => c.kind === "opex")) opex++;
      // An ordinary session has no line of its own in the engine's calendar.
      assert.equal(items.filter((c) => c.kind === "session").length, 0);
    }
    assert.ok(fomc > SEEDS.length * 0.18 && fomc < SEEDS.length * 0.5, `fomc ${fomc}`);
    assert.ok(opex > SEEDS.length * 0.1 && opex < SEEDS.length * 0.42, `opex ${opex}`);
  });

  it("places ET times as instants relative to the open", () => {
    const seed = SEEDS.find((s) => build(s).calendar_today.some((c) => c.kind === "fomc"));
    assert.ok(seed !== undefined);
    const item = build(seed).calendar_today.find((c) => c.kind === "fomc");
    assert.ok(item);
    assert.equal(item.title, "FOMC rate decision");
    assert.equal(item.time_et, "14:00");
    assert.equal(item.at, "2026-09-22T18:00:00.000Z");
    assert.equal(item.importance, 3);
  });

  it("puts a held name reporting today on the calendar", () => {
    const seed = SEEDS.find((s) => build(s).earnings_next.some((e) => e.sessions_until === 0));
    assert.ok(seed !== undefined);
    const r = build(seed);
    const today = r.earnings_next.filter((e) => e.sessions_until === 0).map((e) => e.ticker);
    const items = r.calendar_today.filter((c) => c.kind === "earnings");
    assert.deepEqual(items.flatMap((c) => c.tickers), today);
    for (const item of items) {
      assert.equal(item.importance, 3);
      assert.ok(item.detail === "Before the open." || item.detail === "After the close, or at an hour not yet announced.", String(item.detail));
    }
  });

  it("lists a rebalance that lands this session as an all-day item, as the engine does", () => {
    // Demo rebalances land on a Friday, so only a Friday target can have one "today".
    const friday: BriefingWindow = {
      ...WINDOW,
      target_session_ymd: "2026-09-25",
      prev_session_ymd: "2026-09-24",
      overnight_since: "2026-09-24T20:00:00.000Z",
      window_opens_at: "2026-09-25T00:00:00.000Z",
      target_open_at: "2026-09-25T13:30:00.000Z",
      target_close_at: "2026-09-25T20:00:00.000Z",
    };
    const today = (s: number): BriefingReport => build(s, FULL_BOOK, 5_000, friday);
    const seed = SEEDS.find((s) => today(s).corporate_events.some((e) => e.kind === "rebalance" && e.sessions_until === 0));
    assert.ok(seed !== undefined);
    const r = today(seed);
    const items = r.calendar_today.filter((c) => c.kind === "rebalance");
    assert.ok(items.length >= 1);
    for (const item of items) {
      assert.equal(item.time_et, null);
      assert.equal(item.at, null);
      const event = r.corporate_events.find((e) => e.kind === "rebalance" && e.title === item.title);
      assert.ok(event);
      assert.equal(item.source, event.source);
      assert.deepEqual(item.tickers, event.affects_held);
    }
  });

  it("announces an early close when the window has one", () => {
    const r = build(31, SMALL_BOOK, 5_000, { ...WINDOW, early_close: true, target_close_at: "2026-09-22T17:00:00.000Z" });
    const session = r.calendar_today.find((c) => c.kind === "session");
    assert.ok(session);
    assert.equal(session.title, "Early close at 13:00 ET");
    assert.equal(session.time_et, null);
    assert.equal(r.window.early_close, true);
  });

  it("marks the first session after a holiday, and only then", () => {
    const holiday = build(31, SMALL_BOOK, 5_000, { ...WINDOW, handover: "holiday" });
    assert.deepEqual(holiday.calendar_today.filter((c) => c.kind === "session").map((c) => c.title), ["First session after a US market holiday"]);
    const weekend = build(31, SMALL_BOOK, 5_000, { ...WINDOW, handover: "weekend" });
    assert.deepEqual(weekend.calendar_today.filter((c) => c.kind === "session"), []);
  });

  it("covers the target with room to spare", () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const c = build(seed).calendar_coverage;
      assert.equal(c.covers_target, true);
      assert.ok(c.from < WINDOW.target_session_ymd && WINDOW.target_session_ymd < c.until);
      assert.equal(c.days_left, Math.round((Date.parse(c.until) - Date.parse(WINDOW.target_session_ymd)) / 86_400_000));
      assert.ok(c.days_left >= 90);
      // A calendar date, the way the engine's curated file states it.
      assert.match(c.compiled_at, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(c.compiled_at < WINDOW.target_session_ymd);
    }
  });
});

describe("buildDemoBriefing: the lead", () => {
  it("is one or two template sentences inside the engine's word limit", () => {
    for (const seed of SEEDS) {
      for (const positions of [SMALL_BOOK, FULL_BOOK, STAGE_BOOK]) {
        const n = build(seed, positions).narrative;
        assert.equal(n.source, "template");
        assert.equal(n.pending, false);
        assert.equal(n.model, null);
        assert.equal(n.reason, "Demo book: no model is called.");
        const sentences = sentencesOf(n.text);
        assert.ok(sentences.length >= 1 && sentences.length <= 2, `seed ${seed}: ${sentences.length} sentences in "${n.text}"`);
        assert.ok(wordCount(n.text) <= 55, `seed ${seed}: ${wordCount(n.text)} words in "${n.text}"`);
        assert.ok(!n.text.includes("$"), n.text);
        assert.ok(n.text.includes("%"), n.text);
        assert.deepEqual(textProblems(n.text, { riskWords: true }), [], n.text);
      }
    }
  });

  it("opens with the first story, event then reaction, and closes with the calendar", () => {
    for (const seed of SEEDS) {
      const r = build(seed, STAGE_BOOK, 18_400);
      const first = r.stories[0];
      assert.ok(first);
      const [lead, calendar] = sentencesOf(r.narrative.text);
      // A name story is joined on its ticker ("LLY reported results and is up
      // 1.9% since the close"); "since the close" is said once.
      assert.ok(lead.startsWith(`${first.what} and `), `seed ${seed}: "${lead}" does not open with "${first.what}"`);
      assert.ok(lead.includes(first.reaction.replace(`${first.tickers[0]} `, "")), `seed ${seed}: "${lead}" lacks "${first.reaction}"`);
      assert.equal(lead.split("since the close").length - 1, 1, lead);
      if (calendar !== undefined) assert.match(calendar, /^(This session|Nothing is scheduled)/);
    }
  });

  it("opens with the tape when no held name has a story", () => {
    const r = build(41, [], 10_000);
    const tape = storyOf(r, "story:market:tape");
    assert.ok(r.narrative.text.startsWith(`${tape.what}: ${tape.reaction}.`), r.narrative.text);
  });

  it("quotes the figures the tables show", () => {
    const r = build(37, STAGE_BOOK, 18_400);
    const tape = storyOf(r, "story:market:tape");
    const es = r.overnight.markets.find((m) => m.symbol === "ES=F");
    assert.ok(es && es.move !== null);
    assert.ok(tape.reaction.includes(`${Math.abs(es.move)}%`), tape.reaction);
    assert.equal(r.narrative.facts_hash, r.facts_hash);
    // The hash moves with the stories and the headlines, as the engine's does.
    assert.notEqual(r.facts_hash, build(38, STAGE_BOOK, 18_400).facts_hash);
  });

  it("never quotes a stale row", () => {
    for (const seed of SEEDS) {
      const r = build(seed);
      for (const row of r.overnight.markets) {
        if (row.state === "stale") assert.ok(!r.narrative.text.includes(row.label), `seed ${seed}: "${r.narrative.text}"`);
      }
    }
  });
});

describe("buildDemoBriefing: robustness", () => {
  const BOOKS: Array<[string, BriefingHolding[], number]> = [
    ["small", SMALL_BOOK, 5_000],
    ["full pool", FULL_BOOK, 25_000],
    ["stage", STAGE_BOOK, 18_400],
    ["empty", [], 10_000],
    ["funds only", bookOf(["SPY", "TLT"]), 0],
    ["borrowed", [{ symbol: "TSLA", shares: -5, cost_usd: -1_700 }], 3_000],
    ["bad cash", SMALL_BOOK, Number.NaN],
  ];

  it("has no NaN, no undefined and no infinity anywhere", () => {
    for (const [name, positions, cash] of BOOKS) {
      for (const seed of SEEDS.slice(0, 40)) {
        for (const [at, value] of leaves(build(seed, positions, cash))) {
          assert.notEqual(value, undefined, `${name} seed ${seed}: ${at} is undefined`);
          if (typeof value === "number") assert.ok(Number.isFinite(value), `${name} seed ${seed}: ${at} is ${value}`);
        }
      }
    }
  });

  it("works with no positions at all", () => {
    const r = build(41, [], 10_000);
    assert.deepEqual(r.overnight.held_movers, []);
    assert.deepEqual(r.overnight.held_news, []);
    assert.deepEqual(r.overnight.filings, []);
    assert.deepEqual(r.overnight.measurements, []);
    assert.deepEqual(r.held_coverage, []);
    assert.deepEqual(r.earnings_next, []);
    assert.deepEqual(r.corporate_events, []);
    assert.equal(r.book.position_count, 0);
    assert.equal(r.book.equity_usd, 10_000);
    assert.equal(r.book.invested_usd, 0);
    assert.equal(r.book.overnight_pnl_usd, null);
    assert.equal(r.book.overnight_pnl_pct, null);
    assert.deepEqual(r.book.top_weights, []);
    assert.ok(r.risk);
    assert.equal(r.risk.score, null);
    assert.equal(r.risk.driver_sentence, null);
    assert.equal(r.overnight.markets.length, 17);
    assert.ok(r.calendar_today.length >= 2);
    assert.ok(r.narrative.text.length > 0);
  });

  it("works with funds only: no cast, and the market stories stand", () => {
    const r = build(5, bookOf(["SPY", "TLT"]), 0);
    assert.deepEqual(r.overnight.held_news, []);
    assert.deepEqual(r.overnight.filings, []);
    assert.deepEqual(r.stories.map((s) => s.id), ["story:market:tape", "story:market:asia"]);
  });

  it("still builds when the window does not parse", () => {
    const broken = { ...WINDOW, target_open_at: "soon", overnight_since: "", target_session_ymd: "tomorrow" };
    const r = build(43, SMALL_BOOK, 5_000, broken);
    for (const [at, value] of leaves(r)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value), at);
    }
    assert.ok(Number.isFinite(Date.parse(r.generated_at)));
    for (const e of r.corporate_events) assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.stories.length >= 4, `${r.stories.length} stories`);
  });
});

describe("buildDemoBriefing: copy rules", () => {
  it("keeps every string in the report clean, whatever the seed and the book", () => {
    for (const seed of SEEDS) {
      for (const positions of [FULL_BOOK, SMALL_BOOK, STAGE_BOOK, []]) {
        for (const [at, value] of leaves(build(seed, positions))) {
          if (typeof value !== "string") continue;
          assert.deepEqual(textProblems(value, { riskWords: true }), [], `seed ${seed}: ${at}`);
        }
      }
    }
  });

  it("keeps every literal in the source clean, including lines no seed reached", () => {
    const src = fs.readFileSync(path.join(HERE, "briefing-demo.ts"), "utf8");
    assert.deepEqual(copyProblems(src, { riskWords: true }), []);
    // A rule that passes because the copy vanished would be worse than the
    // rule failing, so pin a few of the lines the report actually shows.
    assert.ok(src.includes("FOMC rate decision"));
    assert.ok(src.includes("Monthly options expiry"));
    assert.ok(src.includes("Demo book: no model is called."));
    assert.ok(src.includes("Equity futures lower before the bell"));
  });
});
