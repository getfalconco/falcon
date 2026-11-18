// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/event-backtest.test.ts
// Falcon's event-backtest helper (Python, run here with python3 on small fixture files) and its TypeScript side:
// the rule parser, the plain words, the generated script and the independent check of the trades. No network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { EVENT_HELPER_MODULE, EVENT_HELPER_PY, eventScript, isCanonicalEventScript } from "./event-backtest-py";
import { checkEventTrades, describeEventRules, eventTestName, parseEventBacktestInput, rulesFromResult, type CheckBars, type CheckEvent, type EventRules } from "./event-spec";
import { dataMismatch } from "./event-backtest-run";
import { validateRunResult, type RunTrade } from "./run-result";
import { buildDeskAudit } from "./audit";

/* ------------------------------------------------------------------ fixtures */

/** Weekdays from 2024-01-02 to 2024-03-29 (no holidays: the calendar is whatever the benchmark trades). */
const CAL: string[] = (() => {
  const out: string[] = [];
  for (let t = Date.UTC(2024, 0, 2); t <= Date.UTC(2024, 2, 29); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
})();
const at = (d: string) => CAL.indexOf(d);

type Bar = { open: number; close: number };
/** A ticker's bars: a slow drift, open a little below the close, distinct per ticker. */
function path(seed: number, days = CAL): Map<string, Bar> {
  const m = new Map<string, Bar>();
  days.forEach((d, i) => {
    const base = 20 + seed * 7 + i * 0.05 * (seed % 3 === 0 ? -1 : 1) + (i % 4) * 0.03;
    m.set(d, { open: Number(base.toFixed(4)), close: Number((base * 1.004).toFixed(4)) });
  });
  return m;
}

type Ev = { ticker: string; event_date: string; filed_at: string; value: number; kind?: string; flags?: string; d0d1?: number };

function writeFixture(dir: string, events: Ev[], prices: Map<string, Map<string, Bar>>) {
  const evCsv = [
    "ticker,event_date,filed_at,filed_session,event_kind,sector_etf,abnormal_return_d0,stock_return_d0,etf_return_d0,abnormal_return_d1,stock_return_d1,etf_return_d1,abnormal_return_d0_d1,stock_return_d0_d1,etf_return_d0_d1,flags,accession,form,price_source",
    ...events.map((e, k) => `${e.ticker},${e.event_date},${e.filed_at},,${e.kind ?? "earnings"},XLK,${e.value - 0.01},${e.value},0.01,,0,,,${e.d0d1 ?? e.value},,${e.flags ?? ""},000-${String(k).padStart(4, "0")},8-K,yahoo`),
  ].join("\n");
  writeFileSync(join(dir, "events_fx.csv.gz"), gzipSync(evCsv));
  const lines = ["date,ticker,open,close"];
  for (const [t, bars] of [...prices].sort((a, b) => (a[0] < b[0] ? -1 : 1))) for (const [d, b] of bars) lines.push(`${d},${t},${b.open},${b.close}`);
  writeFileSync(join(dir, "prices_fx.csv.gz"), gzipSync(lines.join("\n") + "\n"));
}

const DRIVER = String.raw`import json, os, sys
sys.path.insert(0, sys.argv[1])
import falcon_event_backtest as feb
d = sys.argv[1]
rules = json.loads(sys.argv[2])
kw = json.loads(sys.argv[3])
data = feb.load_data(os.path.join(d, "events_fx.csv.gz"), os.path.join(d, "prices_fx.csv.gz"), rules)
print(json.dumps(feb.run(data, rules, **kw), allow_nan=False))
`;

const pythonOk = (() => {
  try {
    execFileSync("python3", ["-c", "import numpy, pandas"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const skip = pythonOk ? false : "python3 with numpy and pandas is not installed";

type Res = { trades: RunTrade[]; metrics: Record<string, unknown>; spec: { hash: string; counts: Record<string, unknown> & { skipped: Record<string, number> } }; series: { dates: string[]; equity: number[] }; period: { start: string; end: string } };

function runHelper(events: Ev[], prices: Map<string, Map<string, Bar>>, rules: Record<string, unknown>, kw: Record<string, unknown> = {}): Res {
  const dir = mkdtempSync(join(tmpdir(), "falcon-event-"));
  try {
    writeFileSync(join(dir, `${EVENT_HELPER_MODULE}.py`), EVENT_HELPER_PY);
    writeFileSync(join(dir, "driver.py"), DRIVER);
    writeFixture(dir, events, prices);
    const out = execFileSync("python3", [join(dir, "driver.py"), dir, JSON.stringify(rules), JSON.stringify(kw)], { encoding: "utf8", env: { ...process.env, PYTHONHASHSEED: String(Math.floor(Math.random() * 1000)) } });
    return JSON.parse(out) as Res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RULES = { threshold: 0.1, since: "2024-01-02", hold_days: 3, max_positions: 20, costs_bps: 0 };
const buysOf = (r: Res) => r.trades.filter((t) => t.side === "buy");
const sellsOf = (r: Res) => r.trades.filter((t) => t.side === "sell");
const near = (a: number | null | undefined, b: number, tol = 1e-6) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) <= tol, `${a} vs ${b}`);

function market(tickers: string[]): Map<string, Map<string, Bar>> {
  const m = new Map<string, Map<string, Bar>>([["SPY", path(50)]]);
  tickers.forEach((t, i) => m.set(t, path(i + 1)));
  return m;
}

/* ------------------------------------------------------------------ the helper */

test("entry timing: pre-market, intraday and after-close releases; a row filed after its d0 close is skipped", { skip }, () => {
  const events: Ev[] = [
    // 07:00 ET on Wed Jan 10: d0 = Jan 10, the move is known at its close, buy the open of Jan 11.
    { ticker: "AAA", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.15 },
    // 16:30 ET on Jan 10: d0 = Jan 11 (the first session after the news), buy the open of Jan 12.
    { ticker: "BBB", event_date: "2024-01-11", filed_at: "2024-01-10T21:30:00Z", value: 0.2 },
    // 10:00 ET on Jan 10 (intraday): d0 = Jan 10, buy the open of Jan 11.
    { ticker: "DDD", event_date: "2024-01-10", filed_at: "2024-01-10T15:00:00Z", value: 0.12 },
    // Filed 16:30 ET Jan 10 but dated Jan 10: its d0 close came before the news. Skipped, never traded early.
    { ticker: "CCC", event_date: "2024-01-10", filed_at: "2024-01-10T21:30:00Z", value: 0.3 },
    // Below the threshold.
    { ticker: "EEE", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.05 },
  ];
  const px = market(["AAA", "BBB", "CCC", "DDD", "EEE"]);
  const r = runHelper(events, px, RULES);
  const buys = Object.fromEntries(buysOf(r).map((t) => [t.ticker, t]));
  assert.deepEqual(Object.keys(buys).sort(), ["AAA", "BBB", "DDD"]);
  assert.equal(buys.AAA!.date, "2024-01-11");
  assert.equal(buys.AAA!.signal_date, "2024-01-10");
  near(buys.AAA!.price, px.get("AAA")!.get("2024-01-11")!.open);
  assert.equal(buys.BBB!.date, "2024-01-12");
  assert.equal(buys.BBB!.signal_date, "2024-01-11");
  assert.equal(buys.DDD!.date, "2024-01-11");
  // Hold 3 days from a next-open entry: sold at the close of the 3rd trading day held (entry day = day 1).
  const sells = Object.fromEntries(sellsOf(r).map((t) => [t.ticker, t]));
  assert.equal(sells.AAA!.date, CAL[at("2024-01-11") + 2]);
  near(sells.AAA!.price, px.get("AAA")!.get(CAL[at("2024-01-11") + 2]!)!.close);
  assert.equal(sells.BBB!.date, CAL[at("2024-01-12") + 2]);
  assert.equal(r.spec.counts.qualifying, 4);
  assert.equal(r.spec.counts.skipped.timing, 1);
  // Every entry comes after its signal day.
  for (const b of buysOf(r)) assert.ok(b.date > b.signal_date!);
});

test("entry timing: next_close, a two-day measure and lag_days + 1 move the entry the right way", { skip }, () => {
  const ev: Ev[] = [{ ticker: "AAA", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.15, d0d1: 0.2 }];
  const px = market(["AAA"]);
  const close = runHelper(ev, px, { ...RULES, entry: "next_close", hold_days: 2 });
  const b = buysOf(close)[0]!;
  assert.equal(b.date, "2024-01-11");
  near(b.price, px.get("AAA")!.get("2024-01-11")!.close);
  // next_close: held 2 days after the entry day, sold at the close of the 2nd.
  assert.equal(sellsOf(close)[0]!.date, CAL[at("2024-01-11") + 2]);
  const d1 = runHelper(ev, px, { ...RULES, measure: "stock_return_d0_d1" });
  assert.equal(buysOf(d1)[0]!.signal_date, "2024-01-11");
  assert.equal(buysOf(d1)[0]!.date, "2024-01-12");
  const late = runHelper(ev, px, RULES, { lag_days: 2 });
  assert.equal(buysOf(late)[0]!.date, "2024-01-12");
});

test("overlapping holds: slot limit with largest move first, a stock already held is not bought again", { skip }, () => {
  const ev: Ev[] = [
    { ticker: "AAA", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 },
    { ticker: "BBB", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.3 },
    { ticker: "CCC", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.15 },
    // AAA again while its first position is open.
    { ticker: "AAA", event_date: "2024-01-11", filed_at: "2024-01-11T12:00:00Z", value: 0.4 },
    // After the first two are sold (Jan 15 close), a slot is free again on Jan 17.
    { ticker: "CCC", event_date: "2024-01-16", filed_at: "2024-01-16T12:00:00Z", value: 0.11 },
  ];
  const r = runHelper(ev, market(["AAA", "BBB", "CCC"]), { ...RULES, max_positions: 2 });
  const buys = buysOf(r).map((t) => `${t.date} ${t.ticker}`);
  assert.deepEqual(buys, ["2024-01-11 BBB", "2024-01-11 AAA", "2024-01-17 CCC"]);
  assert.deepEqual(r.spec.counts.skipped, { already_held: 1, max_positions: 1 });
  // Each position is 1/max_positions of equity at entry.
  near(buysOf(r)[0]!.weight, 0.5, 1e-6);
  assert.equal(r.metrics.trades, 3);
});

test("missing prices: no bars for the ticker, no price on the entry day, a gap on the exit day, a stock that stops trading", { skip }, () => {
  const px = market(["AAA", "BBB", "CCC"]);
  // BBB: no bar on Jan 11 (its entry day).
  px.get("BBB")!.delete("2024-01-11");
  // CCC: no bar on its planned exit day (Jan 15): sold at the next close (Jan 16).
  px.get("CCC")!.delete("2024-01-15");
  // DDD: delisted after Jan 12 (bought Jan 11, planned exit Jan 15): sold at its last close (Jan 12's) on Jan 15.
  px.set("DDD", path(9, CAL.filter((d) => d <= "2024-01-12")));
  const ev: Ev[] = [
    { ticker: "AAA", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 },
    { ticker: "BBB", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 },
    { ticker: "CCC", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 },
    { ticker: "DDD", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 },
    { ticker: "ZZZ", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 },
  ];
  const r = runHelper(ev, px, RULES);
  assert.deepEqual(r.spec.counts.skipped, { no_entry_price: 1, no_price_data: 1 });
  const sells = Object.fromEntries(sellsOf(r).map((t) => [t.ticker, t]));
  assert.equal(sells.AAA!.date, "2024-01-15");
  assert.equal(sells.CCC!.date, "2024-01-16");
  near(sells.CCC!.price, px.get("CCC")!.get("2024-01-16")!.close);
  assert.equal(sells.DDD!.date, "2024-01-15");
  near(sells.DDD!.price, px.get("DDD")!.get("2024-01-12")!.close);
  // A position whose exit falls after the data stays open and is not a closed trade.
  const end = runHelper([{ ticker: "AAA", event_date: "2024-03-27", filed_at: "2024-03-27T12:00:00Z", value: 0.2 }], market(["AAA"]), RULES);
  assert.equal(buysOf(end).length, 1);
  assert.equal(sellsOf(end).length, 0);
  assert.equal(end.spec.counts.open_at_end, 1);
  assert.equal(end.metrics.trades, 0);
});

test("costs: each side charged on the traded amount; the round trip's pnl and the equity agree", { skip }, () => {
  const ev: Ev[] = [{ ticker: "AAA", event_date: "2024-01-10", filed_at: "2024-01-10T12:00:00Z", value: 0.2 }];
  const px = market(["AAA"]);
  const entry = px.get("AAA")!.get("2024-01-11")!.open;
  const exit = px.get("AAA")!.get("2024-01-15")!.close;
  for (const bps of [0, 10, 25]) {
    const c = bps / 10_000;
    const r = runHelper(ev, px, { ...RULES, costs_bps: bps, max_positions: 1 });
    const pnl = (exit * (1 - c)) / (entry * (1 + c)) - 1;
    near(sellsOf(r)[0]!.pnl, pnl, 1e-7);
    // All of equity in one slot: the curve ends at 1 + pnl.
    near(r.series.equity[r.series.equity.length - 1]!, 1 + pnl, 1e-8);
  }
  const x2 = runHelper(ev, px, { ...RULES, costs_bps: 10, max_positions: 1 }, { costs_bps: 20 });
  near(sellsOf(x2)[0]!.pnl, (exit * (1 - 0.002)) / (entry * (1 + 0.002)) - 1, 1e-7);
});

test("determinism: the generated script run twice gives byte-identical files; random picks come from the rules' hash", { skip }, () => {
  const ev: Ev[] = [];
  const names = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
  CAL.slice(3, 50).forEach((d, i) => {
    ev.push({ ticker: names[i % names.length]!, event_date: d, filed_at: `${d}T12:00:00Z`, value: 0.1 + (i % 5) * 0.05 });
    ev.push({ ticker: names[(i + 3) % names.length]!, event_date: d, filed_at: `${d}T12:00:00Z`, value: 0.11 + (i % 3) * 0.05 });
  });
  const px = market(names);
  const rules = parseEventBacktestInput({ threshold: "10%", since: "2024-01-02", hold_days: 4, max_positions: 3 });
  const runs: string[] = [];
  for (let k = 0; k < 2; k++) {
    const dir = mkdtempSync(join(tmpdir(), "falcon-event-"));
    try {
      writeFixture(dir, ev, px);
      writeFileSync(join(dir, `${EVENT_HELPER_MODULE}.py`), EVENT_HELPER_PY);
      const code = eventScript({ rules, name: eventTestName(rules), plain: describeEventRules(rules), eventsFile: "events_fx.csv.gz", pricesFile: "prices_fx.csv.gz" });
      assert.ok(isCanonicalEventScript(code));
      writeFileSync(join(dir, "event_test.py"), code);
      // A different hash seed per process: nothing may depend on set or dict hashing.
      execFileSync("python3", ["event_test.py"], { cwd: dir, env: { ...process.env, INPUT_DIR: dir, PYTHONHASHSEED: String(k * 977 + 1) }, stdio: "pipe" });
      runs.push(readFileSync(join(dir, "falcon_result.json"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.equal(runs[0], runs[1]);
  const parsed = validateRunResult(JSON.parse(runs[0]!));
  assert.ok(parsed.ok);
  assert.ok(parsed.ok && parsed.result.spec && parsed.result.spec.rules.hold_days === 4);
  // Random comparison: the same seed gives the same picks, other seeds and other rules other picks.
  const r1 = runHelper(ev, px, rules, { seed: 1, random_picks: true });
  const r1b = runHelper(ev, px, rules, { seed: 1, random_picks: true });
  const r2 = runHelper(ev, px, rules, { seed: 2, random_picks: true });
  const other = runHelper(ev, px, { ...rules, hold_days: 5 }, { seed: 1, random_picks: true });
  const picks = (r: Res) => buysOf(r).map((t) => t.ticker).join(",");
  assert.equal(JSON.stringify(r1), JSON.stringify(r1b));
  assert.notEqual(picks(r1), picks(r2));
  assert.notEqual(picks(r1).slice(0, 40), picks(other).slice(0, 40));
  // Same schedule as the real test: random stocks bought only on the days qualifying events enter.
  const entryDays = new Set(ev.map((x) => CAL[at(x.event_date) + 1]));
  assert.ok(buysOf(r1).every((t) => entryDays.has(t.date)));
  assert.ok(buysOf(r1).length > 10);
});

/* ------------------------------------------------------------------ the TypeScript side */

test("parseEventBacktestInput: Falcon's fixed defaults, canonical form, errors", () => {
  const r = parseEventBacktestInput({ threshold: "10%", since: "2016", hold_days: 5 });
  assert.deepEqual(r, {
    version: 1,
    event_kinds: ["earnings"],
    measure: "stock_return_d0",
    direction: "up",
    threshold: 0.1,
    since: "2016-01-01",
    until: null,
    exclude_flags: [],
    tickers: null,
    sector_etf: null,
    entry: "next_open",
    hold_days: 5,
    max_positions: 20,
    costs_bps: 5,
    benchmark: "SPY",
  });
  // 10, "10%" and 0.1 are the same rule.
  assert.deepEqual(parseEventBacktestInput({ threshold: 10, since: "2016-01-01", hold_days: 5 }), r);
  assert.deepEqual(parseEventBacktestInput({ threshold: 0.1, since: "2016-01-01", hold_days: 5, direction: "up" }), r);
  assert.equal(parseEventBacktestInput({ threshold: "-8%", since: "2016", hold_days: 5 }).direction, "down");
  assert.throws(() => parseEventBacktestInput({ since: "2016", hold_days: 5 }), /threshold is required/);
  assert.throws(() => parseEventBacktestInput({ threshold: 10, since: "2016", hold_days: 0 }), /hold_days/);
  assert.throws(() => parseEventBacktestInput({ threshold: 10, since: "2016", hold_days: 5, entry: "same_close" }), /entry/);
  assert.throws(() => parseEventBacktestInput({ threshold: "+10%", direction: "down", since: "2016", hold_days: 5 }), /direction/);
  // A result's rules read back unchanged.
  assert.deepEqual(rulesFromResult(JSON.parse(JSON.stringify({ ...r, costs_bps: 5.0 }))), r);
});

test("describeEventRules: the default reading in plain words", () => {
  const lines = describeEventRules(parseEventBacktestInput({ threshold: "10%", since: "2016-01-01", hold_days: 5 }));
  const text = lines.join("\n");
  assert.match(text, /quarterly earnings releases/);
  assert.match(text, /the stock's own close-to-close return on the reaction day \(d0\) above \+10%/);
  assert.match(text, /buy at the open of the first trading day after d0/);
  assert.match(text, /close of the 5th trading day held \(the entry day counts as day 1\)/);
  assert.match(text, /at most 20 at once, each 1\/20 of equity/);
  assert.match(text, /5 bps per side; SPY held throughout/);
  assert.equal(eventTestName(parseEventBacktestInput({ threshold: "10%", since: "2016-01-01", hold_days: 5 })), "Earnings jump above +10%: buy next open, hold 5 days");
});

test("isCanonicalEventScript: an edited script is not Falcon's", () => {
  const rules = parseEventBacktestInput({ threshold: "10%", since: "2016-01-01", hold_days: 5 });
  const code = eventScript({ rules, name: "x", plain: describeEventRules(rules), eventsFile: "events_ab12cd.csv.gz", pricesFile: "prices_ab12cd.csv.gz" });
  assert.ok(isCanonicalEventScript(code));
  assert.ok(!isCanonicalEventScript(code.replace("lag_days=1", "lag_days=0")));
  assert.ok(!isCanonicalEventScript("import pandas as pd\n"));
  assert.throws(() => eventScript({ rules, name: "x", plain: [], eventsFile: "a b.csv", pricesFile: "p.csv" }));
});

/** The fixture as the server's check reads it. */
function checkInputs(events: Ev[], px: Map<string, Map<string, Bar>>): { events: CheckEvent[]; bars: Map<string, CheckBars> } {
  const bars = new Map<string, CheckBars>();
  for (const [t, m] of px) {
    const days = [...m.keys()].sort();
    bars.set(t, { days, open: days.map((d) => m.get(d)!.open), close: days.map((d) => m.get(d)!.close) });
  }
  return {
    events: events.map((e, k) => ({ ticker: e.ticker, event_date: e.event_date, filed_at: e.filed_at, event_kind: e.kind ?? "earnings", sector_etf: "XLK", flags: e.flags ? e.flags.split("|") : [], accession: `000-${String(k).padStart(4, "0")}`, stock_return_d0: e.value, stock_return_d0_d1: e.d0d1 ?? e.value })),
    bars,
  };
}

test("checkEventTrades: the helper's trades pass; moved, invented or missing trades are flagged", { skip }, () => {
  const names = ["AAA", "BBB", "CCC", "DDD", "EEE"];
  const ev: Ev[] = [];
  CAL.slice(3, 45).forEach((d, i) => {
    ev.push({ ticker: names[i % 5]!, event_date: d, filed_at: `${d}T12:00:00Z`, value: 0.1 + (i % 4) * 0.04 });
    // After the close: d0 is the next trading day.
    ev.push({ ticker: names[(i + 2) % 5]!, event_date: CAL[at(d) + 1]!, filed_at: `${d}T21:30:00Z`, value: 0.12 });
  });
  const px = market(names);
  px.get("CCC")!.delete(CAL[20]!);
  const rules: EventRules = parseEventBacktestInput({ threshold: "10%", since: "2024-01-02", hold_days: 3, max_positions: 3 });
  const r = runHelper(ev, px, rules);
  const { events, bars } = checkInputs(ev, px);
  const base = { rules, events, calendar: CAL.filter((d) => px.get("SPY")!.has(d)), bars, periodEnd: r.period.end, helperQualifying: r.spec.counts.qualifying as number };
  const ok = checkEventTrades({ ...base, trades: r.trades });
  assert.equal(ok.status, "pass", ok.detail + ok.items.join("; "));
  assert.equal(ok.unexplained, 0);
  assert.equal(ok.entered, buysOf(r).length);
  assert.ok((ok.explained.max_positions ?? 0) > 0, JSON.stringify([ok.explained, r.spec.counts]));
  // An entry a day early (the look-ahead the check exists for).
  const early = r.trades.map((t, i) => (i === 0 ? { ...t, date: CAL[at(t.date) - 1]! } : t));
  const e1 = checkEventTrades({ ...base, trades: early });
  assert.equal(e1.status, "flag");
  assert.ok(e1.wrong.entry_day! >= 1);
  // A trade from no qualifying event.
  const invented = [...r.trades, { date: "2024-03-01", ticker: "ZZZ", side: "buy" as const, qty: 1, weight: 0.1, price: 1, pnl: null, signal_date: "2024-02-29" }];
  assert.equal(checkEventTrades({ ...base, trades: invented }).wrong.not_from_event, 1);
  // A third of the trades missing (the bug that gave ~300 trades): unexplained, flagged.
  const fewer = r.trades.filter((t, i) => !(t.side === "buy" && i % 3 === 0));
  const e3 = checkEventTrades({ ...base, trades: fewer });
  assert.equal(e3.status, "flag");
  assert.ok(e3.unexplained > 0);
  // The events file the test read had fewer qualifying events than Falcon's table.
  assert.equal(checkEventTrades({ ...base, trades: r.trades, helperQualifying: 3 }).status, "flag");
});

test("dataMismatch: the loaded files must hold every event and price the rules need", () => {
  const rules = parseEventBacktestInput({ threshold: "10%", since: "2016-01-01", hold_days: 5 });
  const turns = [
    { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "load_events", input: { min_abs_return: "10%", measure: "stock_return_d0", direction: "up", since: "2016-01-01" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: `src:t1\n${JSON.stringify({ file: "events_aa.csv.gz", ticker_list: "AAA,BBB" })}` }] },
  ];
  const events = { input: { tickers: null, etf: null, kinds: ["earnings" as const], min: 0.1, measure: "stock_return_d0" as const, direction: "up" as const, since: "2016-01-01", until: null, includeFlagged: false, columns: ["ticker" as const, "event_date" as const, "filed_at" as const, "stock_return_d0" as const] }, file: "events_aa.csv.gz" };
  const prices = { input: { tickers: ["AAA", "BBB", "SPY"], universe: null, universeLabel: null, todaysPick: false, start: "2016-01-01", end: "2026-11-17", from: "2014-11-28", fields: ["open" as const, "close" as const], benchmark: "SPY" }, file: "prices_aa.csv.gz" };
  assert.equal(dataMismatch(rules, events, prices, turns), null);
  assert.match(dataMismatch(rules, { ...events, input: { ...events.input, measure: "abnormal_return_d0_d1" } }, prices, turns) ?? "", /filtered on abnormal_return_d0_d1/);
  assert.match(dataMismatch(rules, { ...events, input: { ...events.input, min: 0.15 } }, prices, turns) ?? "", /threshold/);
  assert.match(dataMismatch(rules, events, { ...prices, input: { ...prices.input, fields: ["close" as const] } }, turns) ?? "", /no open prices/);
  assert.match(dataMismatch(rules, null, null, turns) ?? "", /No load_events file/);
  // A broader file (every earnings event, no threshold) is fine: the helper filters it.
  assert.equal(dataMismatch(rules, { ...events, input: { ...events.input, min: 0, direction: "both", measure: "abnormal_return_d0_d1" } }, prices, turns), null);
});

test("audit: Falcon's script needs no code review; trades off the declared rules cap the label; a custom event script is named", () => {
  const dates = CAL;
  let e = 1;
  let b = 1;
  const result = validateRunResult({
    name: "x",
    period: { start: dates[0], end: dates[dates.length - 1] },
    assumptions: { costs_bps: 5 },
    metrics: {},
    series: { dates, equity: dates.map((_, i) => (e *= 1 + (i % 2 ? 0.004 : -0.001))), benchmark_equity: dates.map(() => (b *= 1.0005)) },
    trades: [],
  });
  assert.ok(result.ok);
  const input = { result: result.result, review: null, harness: null, bars: null, universe: null, intent: "", trials: 1, today: "2026-11-17" };
  const canon = buildDeskAudit({ ...input, canonicalScript: true });
  assert.equal(canon.checks.find((c) => c.id === "review")!.status, "pass");
  const flagged = buildDeskAudit({
    ...input,
    canonicalScript: true,
    eventCheck: { status: "flag", detail: "The trades do not match the declared rules: 3 entry day.", items: [], qualifying: 10, helperQualifying: 10, entered: 7, expected: 10, explained: {}, unexplained: 0, wrong: { entry_day: 3 } },
  });
  assert.equal(flagged.checks.find((c) => c.id === "rules")!.status, "flag");
  assert.ok(flagged.label.reasons.some((x) => /declared rules/.test(x)));
  assert.ok(["thin", "insufficient"].includes(flagged.label.level));
  const custom = buildDeskAudit({ ...input, customEventScript: true });
  assert.equal(custom.checks.find((c) => c.id === "rules")!.status, "info");
});
