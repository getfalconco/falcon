import test from "node:test";
import assert from "node:assert/strict";
import { checkFormula, type CheckEnv } from "../src/fsl/check";
import { Evaluator } from "../src/fsl/eval";
import { asSeries } from "../src/output";
import { prepare, type SpecData } from "../src/prepare";
import { rng } from "../src/util";
import { quarterly, sessions, specData, walkBars } from "./v2-helpers";

/** Random FSL expressions that type-check: a small typed grammar. */
function generator(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const W = () => String(2 + Math.floor(r() * 40));
  const K = () => String(1 + Math.floor(r() * 5));
  const c = () => (r() - 0.5).toFixed(3);
  const num = (d: number): string => {
    const leaves = [
      () => `ret(close, ${W()})`,
      () => `logret(close, ${W()})`,
      () => `rsi(close, ${W()})`,
      () => `close / ts_mean(close, ${W()}) - 1`,
      () => `ts_zscore(volume, ${W()})`,
      () => `vol(${W()})`,
      () => `adv(${W()})`,
      () => `ts_rank(close, ${W()})`,
      () => "drawdown(close)",
      () => `at("SPY", ret(close, ${W()}))`,
      () => "earnings.days_since",
      () => "earnings.surprise",
      () => "earnings.reaction_abn",
      () => `tbill_ret(${W()})`,
      () => "dow",
      () => "tdom",
      () => `macd(close, 5, ${10 + Math.floor(r() * 20)}) / close`,
      () => `atr(${W()}) / close`,
      () => "raw_close",
    ];
    if (d <= 0) return pick(leaves)();
    const nodes = [
      () => `cs_rank(${num(d - 1)})`,
      () => `cs_zscore(${num(d - 1)})`,
      () => `cs_demean(${num(d - 1)})`,
      () => `delay(${num(d - 1)}, ${K()})`,
      () => `ts_mean(${num(d - 1)}, ${W()})`,
      () => `ema(${num(d - 1)}, ${W()})`,
      () => `ts_max(${num(d - 1)}, ${W()})`,
      () => `ts_std(${num(d - 1)}, ${W()})`,
      () => `${num(d - 1)} + ${num(d - 1)}`,
      () => `${num(d - 1)} * ${num(d - 1)}`,
      () => `abs(${num(d - 1)})`,
      () => `max(${num(d - 1)}, ${num(d - 1)})`,
      () => `if(${bool(d - 1)}, ${num(d - 1)}, ${num(d - 1)})`,
      () => `count(${bool(d - 1)}, ${W()})`,
      () => `streak(${bool(d - 1)})`,
      () => `days_since(${bool(d - 1)})`,
    ];
    return r() < 0.35 ? pick(leaves)() : pick(nodes)();
  };
  const bool = (d: number): string => {
    const leaves = [
      () => `close > ts_mean(close, ${W()})`,
      () => `close < delay(ts_min(close, ${W()}), 1)`,
      () => "earnings.event",
      () => "is_month_end",
      () => "tdom == -1",
      () => `top_n(ret(close, ${W()}), 2)`,
      () => `at("SPY", close > ts_mean(close, ${W()}))`,
    ];
    if (d <= 0) return pick(leaves)();
    const nodes = [
      () => `${num(d - 1)} > ${num(d - 1)}`,
      () => `${num(d - 1)} < ${c()}`,
      () => `crosses_above(${num(d - 1)}, ${num(d - 1)})`,
      () => `${bool(d - 1)} and ${bool(d - 1)}`,
      () => `(${bool(d - 1)} or ${bool(d - 1)})`,
      () => `not ${bool(d - 1)}`,
      () => `top_n(${num(d - 1)}, 2)`,
      () => `bottom_n(${num(d - 1)}, 1)`,
      () => `delay(${bool(d - 1)}, ${K()})`,
    ];
    return r() < 0.3 ? pick(leaves)() : pick(nodes)();
  };
  return () => bool(1 + Math.floor(r() * 3));
}

const TICKERS = ["AAA", "BBB", "CCC", "DDD"];
const MIN: Record<string, number> = { before_open: 8 * 60, during: 12 * 60, after_close: 16 * 60 + 30, unknown: 16 * 60 + 30 };

/** The data as known at an instant: close clock 16:00 on `day`, preopen 09:15 on `day`. */
function cutAt(data: SpecData, day: string, clock: "close" | "preopen"): SpecData {
  const barsTo = (d: string) => (clock === "close" ? d <= day : d < day);
  const cutoff = clock === "close" ? 16 * 60 : 9 * 60 + 15;
  const bars = Object.fromEntries(Object.entries(data.bars).map(([t, b]) => [t, b.filter((x) => barsTo(x.date))]));
  const earnings = Object.fromEntries(
    Object.entries(data.earnings).map(([t, es]) => [t, es.filter((e) => e.date < day || (e.date === day && MIN[e.time]! <= cutoff))]),
  );
  return { ...data, bars, earnings, rates: data.rates.filter((p) => p.date < day) };
}

test("causality: 500 random FSL expressions x 10 instant cuts give identical decisions (both clocks)", () => {
  const dates = sessions("2019-01-01", 520);
  const bars: SpecData["bars"] = { SPY: walkBars(dates, 1, { vol: 0.01, volume: 9e7 }) };
  const earnings: SpecData["earnings"] = {};
  TICKERS.forEach((t, i) => {
    // DDD lists late: cross-sections change during the window.
    bars[t] = walkBars(dates, 20 + i, { vol: 0.02, from: t === "DDD" ? 200 : 0 });
    earnings[t] = quarterly(dates, 40 + i, 20 + i * 7);
  });
  const rates = dates.map((d, i) => ({ date: d, rate: 1 + Math.sin(i / 50) }));
  const data = specData(bars, earnings, rates);
  const period = { start: dates[60]!, end: dates.at(-1)! };
  const gen = generator(12345);
  const env: CheckEnv = { mode: "rules", params: {}, defs: {} };
  const r = rng(99);
  const cuts = Array.from({ length: 10 }, (_, i) => {
    const clock: "close" | "preopen" = i % 2 ? "preopen" : "close";
    const day = dates[100 + Math.floor(r() * 400)]!;
    return { clock, day };
  });
  const full = { close: prepare(data, TICKERS, period, "close", false), preopen: prepare(data, TICKERS, period, "preopen", false) };
  const parts = cuts.map((c) => ({ ...c, prep: prepare(cutAt(data, c.day, c.clock), TICKERS, { start: period.start, end: c.day }, c.clock, false) }));
  let checked = 0;
  for (let i = 0; i < 500; i++) {
    const src = gen();
    const res = checkFormula(src, "entry", env);
    assert.ok(res.ok, `${src}: ${res.ok ? "" : res.error}`);
    const evalOn = (prep: ReturnType<typeof prepare>, clock: "close" | "preopen") => {
      const ev = new Evaluator({ panel: prep.panel, universe: TICKERS, params: {}, defs: {}, tbill: prep.tbill, clock, events: prep.events });
      return asSeries(ev.run(src), TICKERS.length, prep.panel.dates.length);
    };
    const whole = { close: evalOn(full.close, "close"), preopen: evalOn(full.preopen, "preopen") };
    for (const c of parts) {
      const a = whole[c.clock];
      const b = evalOn(c.prep, c.clock);
      const T1 = full.close.panel.dates.length;
      const T2 = c.prep.panel.dates.length;
      for (let u = 0; u < TICKERS.length; u++) {
        for (let t = 0; t < T2; t++) {
          const x = a[u * T1 + t]!;
          const y = b[u * T2 + t]!;
          // Decisions: a condition is true or not. NaN and 0 are both "not true".
          assert.equal(x > 0, y > 0, `${src} (${c.clock} cut ${c.day}) differs at ${c.prep.panel.dates[t]} ${TICKERS[u]}`);
        }
      }
      checked++;
    }
  }
  assert.equal(checked, 5000);
});
