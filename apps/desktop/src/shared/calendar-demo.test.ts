import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildDemoCalendar } from "./calendar-demo.js";
import { CALENDAR_SCHEMA_VERSION, type CalendarHolding, type CalendarReport, type SessionWindow } from "./calendar-types.js";
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

/** Tuesday 2026-09-22, after Monday's close. Deliberately NOT pre-open, to see it forced. */
const WINDOW: SessionWindow = {
  target_session_ymd: "2026-09-22",
  prev_session_ymd: "2026-09-21",
  overnight_since: "2026-09-21T20:00:00.000Z",
  window_opens_at: "2026-09-22T00:00:00.000Z",
  target_open_at: "2026-09-22T13:30:00.000Z",
  target_close_at: "2026-09-22T20:00:00.000Z",
  phase: "between_sessions",
  gap: "overnight",
  early_close: false,
};

function bookOf(symbols: string[]): CalendarHolding[] {
  return symbols.map((symbol, i) => ({ symbol, shares: 5 + i }));
}

const SMALL_BOOK = bookOf(["NVDA", "AAPL", "JPM", "SPY", "QQQ"]);
const FUNDS_ONLY = bookOf(["SPY", "TLT"]);

function build(seed: number, holdings: CalendarHolding[] = SMALL_BOOK, window: SessionWindow = WINDOW): CalendarReport {
  return buildDemoCalendar(mulberry32(seed), window, holdings);
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

/** Every leaf of the report with its path, so a failure names the field. */
function leaves(value: unknown, at = "report"): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
  }
  return [[at, value]];
}

describe("buildDemoCalendar: determinism and frame", () => {
  it("gives the same report for the same seed", () => {
    assert.deepEqual(build(42), build(42));
    assert.deepEqual(build(42, FUNDS_ONLY), build(42, FUNDS_ONLY));
  });

  it("gives a different report for a different seed", () => {
    assert.notDeepEqual(build(42), build(43));
  });

  it("is a demo report in the pre-open phase, stamped 2 h 14 min before the target open", () => {
    const r = build(7);
    assert.equal(r.demo, true);
    // The engine's constant, read through the renderer's re-export: a bump
    // there fails here until the demo writes the fields that came with it.
    assert.equal(r.schema_version, CALENDAR_SCHEMA_VERSION);
    assert.equal(r.generated_at, "2026-09-22T11:16:00.000Z");
    assert.equal(r.window.phase, "pre_open");
    assert.equal(r.window.target_session_ymd, WINDOW.target_session_ymd);
    assert.equal(r.window.target_close_at, WINDOW.target_close_at);
    assert.deepEqual(r.degraded, []);
  });

  it("does not mutate its inputs", () => {
    const holdings = bookOf(["NVDA", "SPY"]);
    const before = JSON.stringify([holdings, WINDOW]);
    build(3, holdings);
    assert.equal(JSON.stringify([holdings, WINDOW]), before);
    assert.equal(WINDOW.phase, "between_sessions");
  });
});

describe("buildDemoCalendar: the rows", () => {
  it("lists all-day items first, then by time, the heavier row first within a slot", () => {
    for (const seed of SEEDS) {
      const items = build(seed).items;
      const firstTimed = items.findIndex((c) => c.time_et !== null);
      const timed = firstTimed === -1 ? [] : items.slice(firstTimed);
      assert.ok(timed.every((c) => c.time_et !== null), `seed ${seed}: an all-day item after a timed one`);
      for (let i = 1; i < timed.length; i++) {
        const a = timed[i - 1];
        const b = timed[i];
        assert.ok((a.time_et ?? "") <= (b.time_et ?? ""), `seed ${seed}: out of clock order`);
        if (a.time_et === b.time_et) assert.ok(a.importance >= b.importance, `seed ${seed}: lighter row first in one slot`);
      }
      assert.equal(new Set(items.map((c) => c.id)).size, items.length);
      for (const c of items) assert.equal(c.at === null, c.time_et === null);
    }
  });

  it("shows a rate decision or a handful of releases, never both", () => {
    let fomc = 0;
    let opex = 0;
    for (const seed of SEEDS) {
      const items = build(seed).items;
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
    const seed = SEEDS.find((s) => build(s).items.some((c) => c.kind === "fomc"));
    assert.ok(seed !== undefined);
    const item = build(seed).items.find((c) => c.kind === "fomc");
    assert.ok(item);
    assert.equal(item.title, "FOMC rate decision");
    assert.equal(item.time_et, "14:00");
    assert.equal(item.at, "2026-09-22T18:00:00.000Z");
    assert.equal(item.importance, 3);
  });

  it("puts a held company reporting today on the calendar about one time in four, and never a fund", () => {
    let reporting = 0;
    for (const seed of SEEDS) {
      const rows = build(seed).items.filter((c) => c.kind === "earnings");
      assert.ok(rows.length <= 1, `seed ${seed}: ${rows.length} earnings rows`);
      if (rows.length === 0) continue;
      reporting++;
      const [row] = rows;
      assert.equal(row.importance, 3);
      assert.equal(row.time_et, null);
      assert.equal(row.tickers.length, 1);
      assert.ok(["NVDA", "AAPL", "JPM"].includes(row.tickers[0]), row.tickers[0]);
      assert.equal(row.title, `${row.tickers[0]} earnings report`);
      assert.ok(row.detail === "Before the open." || row.detail === "After the close, or at an hour not yet announced.", String(row.detail));
      assert.equal(row.source, "tracker");
    }
    assert.ok(reporting > SEEDS.length * 0.12 && reporting < SEEDS.length * 0.4, `reporting ${reporting}`);
    for (const seed of SEEDS.slice(0, 40)) {
      assert.deepEqual(build(seed, FUNDS_ONLY).items.filter((c) => c.kind === "earnings"), []);
    }
  });

  it("announces an early close when the window has one", () => {
    const r = build(31, SMALL_BOOK, { ...WINDOW, early_close: true, target_close_at: "2026-09-22T17:00:00.000Z" });
    const session = r.items.find((c) => c.kind === "session");
    assert.ok(session);
    assert.equal(session.title, "Early close at 13:00 ET");
    assert.equal(session.time_et, null);
    assert.equal(r.items.indexOf(session), r.items.findIndex((c) => c.time_et === null));
    assert.equal(r.window.early_close, true);
  });

  it("marks the first session after a holiday, and only then", () => {
    const holiday = build(31, SMALL_BOOK, { ...WINDOW, gap: "holiday" });
    assert.deepEqual(holiday.items.filter((c) => c.kind === "session").map((c) => c.title), ["First session after a US market holiday"]);
    const weekend = build(31, SMALL_BOOK, { ...WINDOW, gap: "weekend" });
    assert.deepEqual(weekend.items.filter((c) => c.kind === "session"), []);
  });

  it("covers the target with room to spare", () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const c = build(seed).coverage;
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

describe("buildDemoCalendar: robustness", () => {
  const BOOKS: Array<[string, CalendarHolding[]]> = [
    ["small", SMALL_BOOK],
    ["empty", []],
    ["funds only", FUNDS_ONLY],
    ["borrowed", [{ symbol: "TSLA", shares: -5 }]],
    ["residue and spellings", [{ symbol: " nvda ", shares: 1 }, { symbol: "NVDA", shares: 2 }, { symbol: "DUST", shares: 1e-12 }, { symbol: "BAD", shares: Number.NaN }]],
  ];

  it("has no NaN, no undefined and no infinity anywhere", () => {
    for (const [name, holdings] of BOOKS) {
      for (const seed of SEEDS.slice(0, 40)) {
        for (const [at, value] of leaves(build(seed, holdings))) {
          assert.notEqual(value, undefined, `${name} seed ${seed}: ${at} is undefined`);
          if (typeof value === "number") assert.ok(Number.isFinite(value), `${name} seed ${seed}: ${at} is ${value}`);
        }
      }
    }
  });

  it("works with no positions at all, and still has a day", () => {
    const r = build(41, []);
    assert.deepEqual(r.items.filter((c) => c.kind === "earnings"), []);
    assert.ok(r.items.length >= 1);
  });

  it("only ever names a held company, however the symbol was spelled", () => {
    const seed = SEEDS.find((s) => build(s, [{ symbol: " nvda ", shares: 1 }]).items.some((c) => c.kind === "earnings"));
    assert.ok(seed !== undefined);
    assert.deepEqual(build(seed, [{ symbol: " nvda ", shares: 1 }]).items.find((c) => c.kind === "earnings")?.tickers, ["NVDA"]);
  });

  it("still builds when the window does not parse", () => {
    const broken = { ...WINDOW, target_open_at: "soon", overnight_since: "", target_session_ymd: "tomorrow" };
    const r = build(43, SMALL_BOOK, broken);
    for (const [at, value] of leaves(r)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value), at);
    }
    assert.ok(Number.isFinite(Date.parse(r.generated_at)));
    assert.match(r.coverage.until, /^\d{4}-\d{2}-\d{2}$/);
    for (const c of r.items) if (c.at !== null) assert.ok(Number.isFinite(Date.parse(c.at)), c.id);
  });
});

describe("buildDemoCalendar: copy rules", () => {
  it("keeps every string in the report clean, whatever the seed and the book", () => {
    for (const seed of SEEDS) {
      for (const holdings of [SMALL_BOOK, FUNDS_ONLY, []]) {
        for (const [at, value] of leaves(build(seed, holdings))) {
          if (typeof value !== "string") continue;
          assert.deepEqual(textProblems(value, { riskWords: true }), [], `seed ${seed}: ${at}`);
        }
      }
    }
  });

  it("keeps every literal in the source clean, including lines no seed reached", () => {
    const src = fs.readFileSync(path.join(HERE, "calendar-demo.ts"), "utf8");
    assert.deepEqual(copyProblems(src, { riskWords: true }), []);
    // A rule that passes because the copy vanished would be worse than the
    // rule failing, so pin a few of the lines the report actually shows.
    assert.ok(src.includes("FOMC rate decision"));
    assert.ok(src.includes("Monthly options expiry"));
    assert.ok(src.includes("Early close at 13:00 ET"));
  });
});
