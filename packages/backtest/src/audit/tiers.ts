/**
 * Quality checks (design 6.1).
 *
 * Tier A runs with every result: 1 spec valid, 2 prefix invariance (one cut
 * per run, sampled from the spec hash), 4 data availability, 5 data sanity,
 * 6 sample size, 7 benchmarks and a 50-seed null, 8 uncertainty, 9 costs x2,
 * 10 delay, 12 concentration shares, 14 hindsight universe, 15 survivorship,
 * 16 liquidity, 17 multiple testing (DSR), 21 no model-derived inputs.
 *
 * Tier B is a second request: the null with 200 seeds, 11 parameter
 * neighbourhood, 12 leave-one-ticker-out, 13 regimes.
 */

import { isoToDay } from "../calendar";
import type { EventStudy } from "../event-study";
import { asSeries, computeOutput, evalEnv } from "../output";
import { truncate, type Prepared, type SpecData } from "../prepare";
import { simulate, type Targets, type TradeV2 } from "../simulate";
import { Evaluator } from "../fsl/eval";
import { simOptions } from "../output";
import { resolvePeriod, specHash, universeTickers, type StrategySpecV2 } from "../spec";
import { blockBootstrap, deflatedSharpe, hacT, mean, median, percentileOf, quantile } from "../stats";
import { hash53, rng } from "../util";
import type { Benchmarks, CheckedSpec, Sim } from "../run";
import { dailyRets, simulateSpec } from "../run";
import { EVIDENCE_HEADING, EVIDENCE_SUBTITLE, EVIDENCE_TITLE, topFlags, type Check, type EvidenceLevel, type QualityReport, type ReportValues } from "./report";

export type TierAInput = {
  check: CheckedSpec;
  prep: Prepared;
  data: SpecData;
  trials: number;
  now: Date;
  base: Sim | null;
  bench: Benchmarks | null;
  study: EventStudy | null;
};

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function activeSeries(spec: StrategySpecV2, equity: Float64Array, bench: Benchmarks): number[] {
  const b = spec.benchmark === "equal_weight_universe" && bench.ew ? bench.ew : bench.spy;
  const s = dailyRets(equity);
  const br = dailyRets(b);
  return s.map((x, i) => x - br[i]!);
}

const annual = (xs: number[]) => mean(xs) * 252 * 100;

function sameArr(a: Float64Array, b: Float64Array, upTo: number, T1: number, T2: number, U: number): boolean {
  for (let u = 0; u < U; u++) {
    for (let t = 0; t <= upTo; t++) {
      const x = a[u * T1 + t]!;
      const y = b[u * T2 + t]!;
      if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) return false;
    }
  }
  return true;
}

/** Check 2: decisions up to a cut session are the same when the data stops there. */
export function prefixCheck(check: CheckedSpec, prep: Prepared, cut: number): { ok: boolean; cutDate: string } {
  const spec = check.spec;
  const T = prep.panel.dates.length;
  const small = truncate(prep, cut);
  const T2 = small.panel.dates.length;
  const U = universeTickers(spec).length;
  const p = spec.portfolio;
  let ok = true;
  if (p.mode === "event_study") {
    const a = new Evaluator(evalEnv(spec, prep));
    const b = new Evaluator(evalEnv(spec, small));
    for (const f of [p.event, p.targets]) ok &&= sameArr(asSeries(a.run(f), U, T), asSeries(b.run(f), U, T2), cut, T, T2, U);
  } else {
    const full = computeOutput(spec, prep, check.weightOrder).output;
    const part = computeOutput(spec, small, check.weightOrder).output;
    if (full.kind === "signals" && part.kind === "signals") {
      ok = sameArr(full.entry, part.entry, cut, T, T2, U);
      if (full.exit && part.exit) ok &&= sameArr(full.exit, part.exit, cut, T, T2, U);
    } else if (full.kind === "targets" && part.kind === "targets") {
      // The last session's rebalance flag may come from the rule calendar in the cut run; compare targets.
      ok = sameArr(full.target, part.target, cut - 1, T, T2, U);
    }
  }
  return { ok, cutDate: prep.panel.dates[cut]! };
}

/** Rules-mode null: random trades with the same count and holding periods, from the same universe and dates. */
function rulesNull(trades: TradeV2[], prep: Prepared, universe: string[], seeds: number, seed: number): number[] {
  const T = prep.panel.dates.length;
  const cols = universe.map((t) => prep.panel.col.get(t)!);
  const rand = rng(seed);
  const avgCost = trades.length ? mean(trades.map((t) => (t.cost > 0 ? t.costsPaid / t.cost : 0))) : 0;
  const out: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const rs: number[] = [];
    for (const tr of trades) {
      const h = Math.max(1, tr.exitIndex - tr.entryIndex);
      for (let tries = 0; tries < 20; tries++) {
        const u = Math.floor(rand() * cols.length);
        const e = prep.startIndex + 1 + Math.floor(rand() * Math.max(1, prep.endIndex - prep.startIndex - h));
        const x = e + h;
        if (x > prep.endIndex) continue;
        const c = cols[u]!;
        const o = prep.panel.open[c * T + e]!;
        const cl = prep.panel.open[c * T + x]!;
        if (!(o > 0 && cl > 0) || !prep.panel.has[c * T + e]) continue;
        rs.push((cl / o - 1 - avgCost) * 100);
        break;
      }
    }
    out.push(mean(rs));
  }
  return out;
}

/** Rank-mode null: the same number of names at random on the same rebalance sessions. */
function rankNull(check: CheckedSpec, prep: Prepared, base: Sim, bench: Benchmarks, seeds: number, seed: number): number[] {
  const out = base.computed.output as Targets;
  const T = prep.panel.dates.length;
  const U = base.computed.universe.length;
  const rand = rng(seed);
  const res: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const target = new Float64Array(U * T).fill(NaN);
    for (let t = 0; t < T; t++) {
      if (!out.rebalance[t]) continue;
      const w: number[] = [];
      const avail: number[] = [];
      for (let u = 0; u < U; u++) {
        const v = out.target[u * T + t]!;
        if (Number.isFinite(v)) {
          w.push(v);
          if (prep.panel.has[prep.panel.col.get(base.computed.universe[u]!)! * T + t]) avail.push(u);
        }
      }
      const picks = w.filter((x) => x > 0).length;
      for (let u = 0; u < U; u++) target[u * T + t] = 0;
      for (let k = avail.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [avail[k], avail[j]] = [avail[j]!, avail[k]!];
      }
      for (const u of avail.slice(0, picks)) target[u * T + t] = 1 / Math.max(1, picks);
    }
    const sim = simulate(prep.panel, { kind: "targets", target, rebalance: out.rebalance }, simOptions(check.spec, prep, base.computed.universe));
    res.push(annual(activeSeries(check.spec, sim.equity, bench)));
  }
  return res;
}

/** Weights-mode null: the timing (weights on rebalance sessions) block-shuffled in about 63-session blocks. Null if the weights never change. */
function weightsNull(check: CheckedSpec, prep: Prepared, base: Sim, bench: Benchmarks, seeds: number, seed: number): number[] | null {
  const out = base.computed.output as Targets;
  const T = prep.panel.dates.length;
  const U = base.computed.universe.length;
  const sessions: number[] = [];
  for (let t = prep.startIndex; t <= prep.endIndex; t++) if (out.rebalance[t]) sessions.push(t);
  const vec = (t: number) => Array.from({ length: U }, (_, u) => out.target[u * T + t]!);
  const first = JSON.stringify(vec(sessions[0]!));
  if (sessions.every((t) => JSON.stringify(vec(t)) === first)) return null;
  const spacing = sessions.length > 1 ? (sessions[sessions.length - 1]! - sessions[0]!) / (sessions.length - 1) : 63;
  const block = Math.max(1, Math.round(63 / Math.max(1, spacing)));
  const rand = rng(seed);
  const res: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const blocks: number[][] = [];
    for (let i = 0; i < sessions.length; i += block) blocks.push(sessions.slice(i, i + block));
    for (let k = blocks.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [blocks[k], blocks[j]] = [blocks[j]!, blocks[k]!];
    }
    const order = blocks.flat();
    const target = new Float64Array(U * T).fill(NaN);
    sessions.forEach((t, i) => {
      const from = order[i]!;
      for (let u = 0; u < U; u++) target[u * T + t] = out.target[u * T + from]!;
    });
    const sim = simulate(prep.panel, { kind: "targets", target, rebalance: out.rebalance }, simOptions(check.spec, prep, base.computed.universe));
    res.push(annual(activeSeries(check.spec, sim.equity, bench)));
  }
  return res;
}

/** Event-study null: pseudo-events on random sessions in the same calendar month, same target tickers. */
function eventNull(study: EventStudy, prep: Prepared, window: number, seeds: number, seed: number): number[] {
  const T = prep.panel.dates.length;
  const spy = prep.panel.col.get("SPY")!;
  const rand = rng(seed);
  const byMonth = new Map<string, number[]>();
  for (let t = prep.startIndex + 1; t <= prep.endIndex - window; t++) {
    const m = prep.panel.dates[t]!.slice(5, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), t]);
  }
  const rows = study.events.filter((e) => e.measured[window] !== undefined);
  const res: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const xs: number[] = [];
    for (const r of rows) {
      const pool = byMonth.get(r.date.slice(5, 7)) ?? [];
      if (!pool.length) continue;
      const d = pool[Math.floor(rand() * pool.length)]!;
      const c = prep.panel.col.get(r.ticker)!;
      const last = d + window - 1;
      const ri = prep.panel.close[c * T + last]! / prep.panel.close[c * T + d - 1]! - 1;
      const rm = prep.panel.close[spy * T + last]! / prep.panel.close[spy * T + d - 1]! - 1;
      if (Number.isFinite(ri - rm)) xs.push((ri - rm) * 100);
    }
    res.push(mean(xs));
  }
  return res;
}

function sanity(prep: Prepared, universe: string[]) {
  const T = prep.panel.dates.length;
  let badTicks = 0;
  let zeroVolume = 0;
  let highLow = 0;
  let stale = 0;
  const badNames = new Set<string>();
  for (const t of universe) {
    const c = prep.panel.col.get(t)!;
    let run = 0;
    for (let i = prep.startIndex + 1; i <= prep.endIndex; i++) {
      const k = c * T + i;
      if (!prep.panel.has[k]) continue;
      const prev = prep.panel.close[k - 1]!;
      const cl = prep.panel.close[k]!;
      if (prev > 0 && Math.abs(cl / prev - 1) > 0.5) {
        badTicks++;
        badNames.add(t);
      }
      if (prep.panel.volume[k] === 0) zeroVolume++;
      if (prep.panel.high[k]! < prep.panel.low[k]!) highLow++;
      run = cl === prev ? run + 1 : 0;
      if (run === 4) stale++;
    }
  }
  return { badTicks, zeroVolume, highLow, stale, badNames: Array.from(badNames) };
}

function concentration(trades: TradeV2[], yearly: { year: string; active: number }[]) {
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  const byTicker = new Map<string, number>();
  for (const t of trades) byTicker.set(t.ticker, (byTicker.get(t.ticker) ?? 0) + t.pnl);
  const top = Array.from(byTicker.entries()).sort((a, b) => b[1] - a[1])[0];
  const top5 = [...trades].sort((a, b) => b.pnl - a.pnl).slice(0, 5).reduce((a, t) => a + t.pnl, 0);
  const activeTotal = yearly.reduce((a, y) => a + y.active, 0);
  const best = [...yearly].sort((a, b) => b.active - a.active)[0];
  return {
    total,
    names: byTicker.size,
    topTicker: top?.[0] ?? null,
    topTickerShare: total > 0 && top ? (top[1] / total) * 100 : null,
    top5Share: total > 0 && trades.length >= 10 ? (top5 / total) * 100 : null,
    bestYear: best?.year ?? null,
    bestYearShare: activeTotal > 0 && best && yearly.length >= 3 ? (best.active / activeTotal) * 100 : null,
  };
}

export function evidenceLabel(v: {
  insufficient: boolean;
  t: number;
  costsPass: boolean;
  delayPass: boolean;
  nullPct: number | null;
  dsr: number;
  listUniverse: boolean;
  activeVsEw: number | null;
}): { level: EvidenceLevel; reasons: string[] } {
  if (v.insufficient) return { level: "insufficient", reasons: ["The sample is too small (check 6)."] };
  const reasons: string[] = [];
  if (!(v.t >= 2)) reasons.push("The active return's t statistic is below 2.");
  if (!v.costsPass) reasons.push("The result does not survive twice the modelled costs.");
  if (!v.delayPass) reasons.push("Waiting one session removes more than half of the result.");
  if (v.nullPct !== null && !(v.nullPct >= 90)) reasons.push("It is below the 90th percentile of random versions.");
  if (reasons.length) return { level: "thin", reasons };
  if (!(v.dsr >= 0.8)) return { level: "thin", reasons: ["The deflated Sharpe ratio is below 0.80."] };
  if (v.listUniverse && !(v.activeVsEw !== null && v.activeVsEw > 0)) return { level: "thin", reasons: ["It does not beat holding the same list at equal weight."] };
  if (v.t >= 2.5 && v.dsr >= 0.95) return { level: "consistent", reasons: ["t of 2.5 or more, passes costs, delay and the null, DSR of 0.95 or more."] };
  return { level: "some", reasons: ["t of 2 or more, passes costs, delay and the null, DSR of 0.80 or more."] };
}

export function tierA(input: TierAInput): QualityReport {
  const { check, prep, base, bench, study } = input;
  const spec = check.spec;
  const universe = universeTickers(spec);
  const hash = specHash(spec);
  const seed = hash53(hash);
  const checks: Check[] = [];
  const values: ReportValues = {};
  const T = prep.panel.dates.length;
  const sessions = prep.endIndex - prep.startIndex + 1;
  const years = sessions / 252;

  // 1. Spec valid (it got here).
  checks.push({ id: 1, name: "Spec valid", tier: "A", level: "G", status: "pass", detail: "The rules passed the schema and the type checker; every parameter is in range." });

  // 2. Prefix invariance, one sampled cut.
  const span = prep.endIndex - prep.startIndex;
  const cut = prep.startIndex + 20 + (span > 40 ? seed % (span - 40) : 0);
  const pre = prefixCheck(check, prep, Math.min(prep.endIndex - 1, cut));
  values.prefix = { cut_date: pre.cutDate, ok: pre.ok ? "yes" : "no" };
  checks.push({
    id: 2,
    name: "Prefix invariance",
    tier: "A",
    level: "G",
    status: pre.ok ? "pass" : "gate",
    detail: pre.ok
      ? `Cutting the data at ${pre.cutDate} left every earlier decision unchanged.`
      : `Cutting the data at ${pre.cutDate} changed an earlier decision: the rules read the future. No result is shown.`,
  });

  // 4. Data availability.
  const missing: string[] = [];
  let changes = 0;
  let prevCount = -1;
  for (let t = prep.startIndex; t <= prep.endIndex; t++) {
    let n = 0;
    for (const tk of universe) if (prep.panel.has[prep.panel.col.get(tk)! * T + t]) n++;
    if (prevCount >= 0 && n !== prevCount) changes++;
    prevCount = n;
  }
  for (const tk of universe) {
    const c = prep.panel.col.get(tk)!;
    let any = false;
    for (let t = prep.startIndex; t <= prep.endIndex && !any; t++) any = prep.panel.has[c * T + t] === 1;
    if (!any) missing.push(tk);
  }
  values.availability = { missing: missing.join(", ") || "none", missing_count: missing.length, cross_section_changes: changes };
  checks.push({
    id: 4,
    name: "Data availability",
    tier: "A",
    level: missing.length === universe.length ? "G" : "W",
    status: missing.length === universe.length ? "gate" : missing.length ? "warn" : changes > 0 && universe.length > 1 ? "info" : "pass",
    detail: missing.length
      ? `${missing.join(", ")} had no prices in the window and ${missing.length === 1 ? "was" : "were"} left out.`
      : changes > 0 && universe.length > 1
        ? `The number of tickers with prices changed on ${changes} sessions (listings during the window); cross-sectional rules use the names with data on each date.`
        : "Every ticker has prices across the window.",
  });

  // 5. Data sanity.
  const san = sanity(prep, universe);
  values.sanity = { bad_ticks: san.badTicks, zero_volume: san.zeroVolume, high_below_low: san.highLow, stale_runs: san.stale };
  const sanWarn = san.badTicks > 0 || san.highLow > 0;
  checks.push({
    id: 5,
    name: "Data sanity",
    tier: "A",
    level: "W",
    status: sanWarn ? "warn" : "pass",
    detail: sanWarn
      ? `${san.badTicks} one-day moves above 50% (${san.badNames.slice(0, 4).join(", ")}) and ${san.highLow} bars with the high below the low look like bad data; they were kept as delivered.`
      : `No one-day moves above 50% and no inconsistent bars. ${san.zeroVolume} zero-volume sessions, ${san.stale} runs of five unchanged closes.`,
  });

  // 21. No model-derived inputs (judged_dir is a compile error).
  checks.push({ id: 21, name: "No model-derived inputs", tier: "A", level: "G", status: "pass", detail: "No input comes from a language model's judgment; ripple.judged_dir cannot be used in a backtest." });

  // 14 and 15. Universe.
  const period = resolvePeriod(spec, input.now);
  const yearsBack = (isoToDay(input.now.toISOString().slice(0, 10)) - isoToDay(period.start)) / 365.25;
  const typedList = spec.universe.kind === "static" && spec.portfolio.mode !== "weights" && universe.length >= 2;
  values.hindsight = { years_back: r1(yearsBack), tickers: universe.length };
  checks.push({
    id: 14,
    name: "Hindsight universe",
    tier: "A",
    level: "W",
    status: typedList && yearsBack > 1 ? "warn" : "pass",
    detail:
      typedList && yearsBack > 1
        ? `The list of ${universe.length} tickers was typed today and the test starts ${r1(yearsBack)} years ago: names chosen today tend to be the winners of that period.`
        : "The universe is not a list chosen today for a long look-back.",
  });
  checks.push({
    id: 15,
    name: "Survivorship",
    tier: "A",
    level: "W",
    status: spec.universe.kind === "rule" || universe.length > 1 ? "warn" : "info",
    detail: "Universe: today's listed companies. Delisted, merged and bankrupt names are missing, which tends to flatter lists of stocks.",
  });

  // Event-study mode: sample in independent dates, null by pseudo-events.
  if (study) {
    const w = study.windows[0]!;
    const g = w.g;
    const insufficient = g < 20 || years < 3;
    values.sample = { trades: w.n, event_dates: g, years: r1(years) };
    checks.push({
      id: 6,
      name: "Sample size",
      tier: "A",
      level: "W",
      status: insufficient ? "warn" : "pass",
      detail: insufficient ? `${w.n} events on ${g} separate dates over ${r1(years)} years: fewer than 20 independent dates is too few to tell an effect from noise.` : `${w.n} events on ${g} separate dates.`,
    });
    const nulls = eventNull(study, prep, w.window, 50, seed);
    const pct = percentileOf(w.meanPct, nulls);
    values.null = { percentile: r1(pct), seeds: nulls.length, beaten: Math.round((pct / 100) * nulls.length) };
    checks.push({
      id: 7,
      name: "Null comparison",
      tier: "A",
      level: "I",
      status: pct >= 90 ? "pass" : "warn",
      detail: `The average move beat ${Math.round((pct / 100) * nulls.length)} of ${nulls.length} sets of pseudo-events on random dates in the same months.`,
    });
    values.event = { mean_pct: r2(w.meanPct), t: r2(w.t), dates_up: w.datesUp, dates: g, window: w.window };
    checks.push({
      id: 8,
      name: "Uncertainty",
      tier: "A",
      level: "I",
      status: "info",
      detail: `Clustered by event date: t of ${r2(w.t)} with ${w.df} degrees of freedom${w.wildP !== null ? `, wild bootstrap p of ${r2(w.wildP)}` : ""}.`,
    });
    const lab = evidenceLabel({ insufficient, t: w.t, costsPass: true, delayPass: Math.sign(w.tradableMeanPct) === Math.sign(w.meanPct) && Math.abs(w.tradableMeanPct) >= Math.abs(w.meanPct) / 2, nullPct: pct, dsr: 1, listUniverse: false, activeVsEw: null });
    return finish(checks, values, lab);
  }

  if (!base || !bench) throw new Error("A simulated run is required for Tier A.");
  const sim = base.sim;
  const active = activeSeries(spec, sim.equity, bench);
  const activeAnnual = annual(active);
  const trades = sim.trades;
  const p = spec.portfolio;

  // 6. Sample size.
  let decisions = 0;
  if (base.computed.output.kind === "targets") for (let t = prep.startIndex; t <= prep.endIndex; t++) decisions += base.computed.output.rebalance[t] ? 1 : 0;
  const n = p.mode === "rules" ? trades.length : decisions;
  const insufficient = n < 30 || years < 3;
  values.sample = { trades: trades.length, rebalances: sim.rebalances, years: r1(years) };
  checks.push({
    id: 6,
    name: "Sample size",
    tier: "A",
    level: "W",
    status: insufficient ? "warn" : "pass",
    detail: insufficient
      ? years < 3
        ? `The test covers ${r1(years)} years; under 3 years is too short to judge.`
        : p.mode === "rules"
          ? `Only ${trades.length} trades over ${r1(years)} years: under 30 is too few to tell a pattern from luck.`
          : `Only ${decisions} rebalance dates: under 30 is too few to judge.`
      : `${trades.length} trades over ${r1(years)} years.`,
  });

  // 7. Benchmarks and null.
  const ewActive = bench.ew ? annual(dailyRets(sim.equity).map((x, i) => x - dailyRets(bench.ew!)[i]!)) : null;
  values.benchmarks = { active_pct: r2(activeAnnual), vs_equal_weight_pct: ewActive === null ? null : r2(ewActive), benchmark: spec.benchmark === "SPY" ? "SPY" : "the equal-weight universe" };
  let nullPct: number | null = null;
  let nullSkipped = "";
  let nulls: number[] | null = null;
  if (p.mode === "rules") {
    if (trades.length >= 5) {
      nulls = rulesNull(trades, prep, base.computed.universe, 50, seed);
      nullPct = percentileOf(mean(trades.map((t) => t.returnPct)), nulls);
    } else nullSkipped = "too few trades for a null";
  } else if (p.mode === "rank") {
    nulls = rankNull(check, prep, base, bench, 50, seed);
    nullPct = percentileOf(activeAnnual, nulls);
  } else if (p.mode === "weights") {
    nulls = weightsNull(check, prep, base, bench, 50, seed);
    if (nulls) nullPct = percentileOf(activeAnnual, nulls);
    else nullSkipped = "allocation, no timing claim";
  }
  values.null = { percentile: nullPct === null ? null : r1(nullPct), seeds: nulls?.length ?? 0, beaten: nullPct === null || !nulls ? null : Math.round((nullPct / 100) * nulls.length), kind: p.mode };
  checks.push({
    id: 7,
    name: "Benchmarks and null",
    tier: "A",
    level: "I",
    status: nullPct === null ? "info" : nullPct >= 90 ? "pass" : "warn",
    detail:
      (nullPct === null
        ? `Null comparison skipped: ${nullSkipped}.`
        : p.mode === "rules"
          ? `The average trade beat ${values.null.beaten} of ${nulls!.length} random versions with the same number of trades and holding periods.`
          : `The result beat ${values.null.beaten} of ${nulls!.length} random versions (${p.mode === "rank" ? "the same number of names picked at random" : "the timing shuffled in blocks of about a quarter"}).`) +
      (ewActive !== null ? ` Against holding the same list at equal weight: ${r2(ewActive)}% a year.` : ""),
  });

  // 8. Uncertainty.
  const boot = blockBootstrap(active, rng(seed ^ 0x5bd1e995), 20, 1000);
  const t = hacT(active);
  const lo = quantile(boot, 0.05) * 100;
  const hi = quantile(boot, 0.95) * 100;
  const k = boot.filter((x) => x > 0).length;
  values.active = { annual_pct: r2(activeAnnual), range_lo: r2(lo), range_hi: r2(hi), hac_t: r2(t) };
  values.bootstrap = { k, n: boot.length, k_of_n: `${k} of ${boot.length}` };
  checks.push({
    id: 8,
    name: "Uncertainty",
    tier: "A",
    level: "I",
    status: "info",
    detail: `Active return ${r2(activeAnnual)}% a year (90% range ${r2(lo)}% to ${r2(hi)}%, from a 20-session block bootstrap); above zero in ${k} of ${boot.length} resamples; HAC t of ${r2(t)}.`,
  });

  // 9. Costs x2 and break-even.
  const x2 = simulateSpec(check, prep, { costMultiplier: 2 });
  const x2Active = annual(activeSeries(spec, x2.sim.equity, bench));
  const turnoverYear = Array.from(sim.turnover).reduce((a, b) => a + b, 0) / Math.max(years, 1e-9);
  const avgEq = mean(Array.from(sim.equity));
  const costDrag = years > 0 ? (sim.costsPaid / avgEq / years) * 100 : 0;
  const modelledBps = turnoverYear > 0 ? (costDrag / 100 / turnoverYear) * 10_000 : 0;
  const breakEvenBps = turnoverYear > 0 ? (((activeAnnual + costDrag) / 100) / turnoverYear) * 10_000 : Infinity;
  const monthlyOneSided = (turnoverYear / 2 / 12) * 100;
  const costsPass = !(activeAnnual > 0) || x2Active > 0;
  // Costs matter when there is something to lose: a positive active return thin against costs, or heavy turnover.
  const costWarn = (activeAnnual > 0 && (!costsPass || (Number.isFinite(breakEvenBps) && breakEvenBps < 2 * modelledBps))) || monthlyOneSided > 50;
  values.costs = { x2_active_pct: r2(x2Active), break_even_bps: Number.isFinite(breakEvenBps) ? r1(breakEvenBps) : null, modelled_bps: r1(modelledBps), monthly_turnover_pct: r1(monthlyOneSided), drag_pct: r2(costDrag) };
  checks.push({
    id: 9,
    name: "Costs",
    tier: "A",
    level: "W",
    status: costWarn ? "warn" : "pass",
    detail: `At twice the modelled costs the active return is ${r2(x2Active)}% a year (${r2(activeAnnual)}% at modelled costs). Modelled cost ${r1(modelledBps)} bp per dollar traded; break-even about ${Number.isFinite(breakEvenBps) ? r1(breakEvenBps) : "n/a"} bp. One-sided turnover ${r1(monthlyOneSided)}% a month.`,
  });

  // 10. Delay.
  const delayed = simulateSpec(check, prep, { delay: 1 });
  const dActive = annual(activeSeries(spec, delayed.sim.equity, bench));
  const drop = activeAnnual > 0 ? ((activeAnnual - dActive) / activeAnnual) * 100 : null;
  const delayPass = drop === null || drop <= 50;
  values.delay = { active_pct: r2(dActive), drop_pct: drop === null ? null : r1(Math.max(0, drop)) };
  checks.push({
    id: 10,
    name: "Delay",
    tier: "A",
    level: "W",
    status: delayPass ? "pass" : "warn",
    detail: drop === null ? `Entering one session later gives ${r2(dActive)}% a year active.` : `Waiting one extra session removed ${r1(Math.max(0, drop))}% of the result (${r2(dActive)}% a year active).`,
  });

  // 12. Concentration shares.
  const yearsActive: { year: string; active: number }[] = [];
  {
    const dates = prep.panel.dates.slice(prep.startIndex, prep.endIndex + 1);
    let acc = 0;
    let y = dates[1]?.slice(0, 4) ?? "";
    active.forEach((a, i) => {
      const yy = dates[i + 1]!.slice(0, 4);
      if (yy !== y) {
        yearsActive.push({ year: y, active: acc });
        acc = 0;
        y = yy;
      }
      acc += a;
    });
    yearsActive.push({ year: y, active: acc });
  }
  const conc = concentration(trades, yearsActive);
  values.concentration = {
    top_ticker: conc.topTicker,
    top_ticker_share_pct: conc.topTickerShare === null ? null : r1(conc.topTickerShare),
    top5_trades_share_pct: conc.top5Share === null ? null : r1(conc.top5Share),
    best_year: conc.bestYear,
    best_year_share_pct: conc.bestYearShare === null ? null : r1(conc.bestYearShare),
  };
  const concParts: string[] = [];
  if (universe.length >= 3 && p.mode !== "weights" && conc.topTickerShare !== null && conc.topTickerShare > 50) concParts.push(`${conc.topTicker} made ${r1(conc.topTickerShare)}% of the profit.`);
  if (conc.top5Share !== null && conc.top5Share > 50) concParts.push(`The 5 best trades made ${r1(conc.top5Share)}% of the profit.`);
  if (conc.bestYearShare !== null && conc.bestYearShare > 50) concParts.push(`The best year (${conc.bestYear}) made ${r1(conc.bestYearShare)}% of the active return.`);
  checks.push({
    id: 12,
    name: "Concentration",
    tier: "A",
    level: "W",
    status: concParts.length ? "warn" : "pass",
    detail: concParts.length ? concParts.join(" ") : "No single ticker, handful of trades or year makes most of the result.",
  });

  // 16. Liquidity.
  values.liquidity = { over_adv: sim.overAdv, capacity_adv_pct: sim.maxAdvPct === null ? null : r2(sim.maxAdvPct), min_raw_price: sim.minRawPrice === null ? null : r2(sim.minRawPrice) };
  const liqWarn = sim.overAdv > 0 || (sim.minRawPrice !== null && sim.minRawPrice < 5);
  checks.push({
    id: 16,
    name: "Liquidity",
    tier: "A",
    level: "W",
    status: liqWarn ? "warn" : "pass",
    detail: liqWarn
      ? `${sim.overAdv} entries were above 1% of the stock's average daily dollar volume${sim.minRawPrice !== null && sim.minRawPrice < 5 ? `; the lowest price traded was $${r2(sim.minRawPrice)}` : ""}. Market impact is not modelled.`
      : `The largest position was ${sim.maxAdvPct === null ? "n/a" : `${r2(sim.maxAdvPct)}%`} of a day's average dollar volume.`,
  });

  // 17. Multiple testing.
  const dsr = deflatedSharpe(active, input.trials);
  values.multiple = { trials: input.trials, dsr: Number.isFinite(dsr) ? r2(dsr) : null };
  checks.push({
    id: 17,
    name: "Multiple testing",
    tier: "A",
    level: "I",
    status: input.trials > 1 && dsr < 0.8 ? "warn" : "info",
    detail: `Trial ${input.trials} of this strategy in this browser. Deflated Sharpe ratio of the active return: ${Number.isFinite(dsr) ? r2(dsr) : "n/a"} (the chance the true Sharpe is above what ${input.trials} ${input.trials === 1 ? "try" : "tries"} would give by luck).`,
  });

  const lab = evidenceLabel({
    insufficient,
    t,
    costsPass,
    delayPass,
    nullPct,
    dsr: Number.isFinite(dsr) ? dsr : 0,
    listUniverse: universe.length > 1 && p.mode !== "weights",
    activeVsEw: ewActive,
  });
  return finish(checks, values, lab);
}

function finish(checks: Check[], values: ReportValues, lab: { level: EvidenceLevel; reasons: string[] }): QualityReport {
  checks.sort((a, b) => a.id - b.id);
  const gated = checks.some((c) => c.status === "gate");
  return {
    tiers: ["A"],
    label: {
      level: gated ? "insufficient" : lab.level,
      title: gated ? "No result: a gate check failed" : EVIDENCE_TITLE[lab.level],
      heading: EVIDENCE_HEADING,
      subtitle: EVIDENCE_SUBTITLE,
      reasons: lab.reasons,
    },
    checks,
    flags: topFlags(checks, values),
    values,
  };
}

// ---------------------------------------------------------------------------
// Tier B

export type TierBResult = { checks: Check[]; values: ReportValues };

export function tierB(check: CheckedSpec, prep: Prepared, base: Sim, bench: Benchmarks, opts: { deadlineMs?: number } = {}): TierBResult {
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 20_000;
  const spec = check.spec;
  const seed = hash53(`${specHash(spec)}|B`);
  const checks: Check[] = [];
  const values: ReportValues = {};
  const active = activeSeries(spec, base.sim.equity, bench);
  const activeAnnual = annual(active);
  const p = spec.portfolio;
  const timeLeft = () => Date.now() - started < deadline;

  // 7 with 200 seeds.
  let nulls: number[] | null = null;
  if (p.mode === "rules" && base.sim.trades.length >= 5) nulls = rulesNull(base.sim.trades, prep, base.computed.universe, 200, seed);
  else if (p.mode === "rank") nulls = rankNull(check, prep, base, bench, 200, seed);
  else if (p.mode === "weights") nulls = weightsNull(check, prep, base, bench, 200, seed);
  if (nulls) {
    const stat = p.mode === "rules" ? mean(base.sim.trades.map((t) => t.returnPct)) : activeAnnual;
    const pct = percentileOf(stat, nulls);
    values.null_b = { percentile: Math.round(pct * 10) / 10, seeds: nulls.length, beaten: Math.round((pct / 100) * nulls.length) };
    checks.push({ id: 7, name: "Null comparison (200 seeds)", tier: "B", level: "I", status: pct >= 90 ? "pass" : "warn", detail: `The result beat ${values.null_b.beaten} of ${nulls.length} random versions.` });
  }

  // 11. Parameter neighbourhood.
  const params = Object.entries(spec.params).filter(([, pr]) => pr.max > pr.min).slice(0, 4);
  if (params.length && timeLeft()) {
    const neigh: { name: string; value: number; active: number }[] = [];
    for (const [name, pr] of params) {
      for (const f of [0.8, 1.2]) {
        let v = pr.value * f;
        if (pr.type === "int") v = Math.round(v);
        v = Math.min(pr.max, Math.max(pr.min, v));
        if (v === pr.value || !timeLeft()) continue;
        const s2 = structuredClone(spec);
        s2.params[name]!.value = v;
        const sim2 = simulateSpec(check, prep, {}, s2);
        neigh.push({ name, value: v, active: annual(activeSeries(spec, sim2.sim.equity, bench)) });
      }
    }
    if (neigh.length) {
      const med = median(neigh.map((x) => x.active));
      const q25 = quantile(neigh.map((x) => x.active), 0.25);
      const warn = (activeAnnual > 0 && med < activeAnnual * 0.5) || q25 < 0;
      values.neighbourhood = { median_pct: r2(med), q25_pct: r2(q25), runs: neigh.length, chosen_pct: r2(activeAnnual) };
      checks.push({
        id: 11,
        name: "Parameter neighbourhood",
        tier: "B",
        level: "W",
        status: warn ? "warn" : "pass",
        detail: `Moving each parameter 20% either way (${neigh.length} runs): median active return ${r2(med)}% a year, lowest quarter ${r2(q25)}%, against ${r2(activeAnnual)}% as chosen.`,
      });
    }
  }

  // 12. Leave one ticker out.
  const uni = base.computed.universe;
  if (uni.length >= 2 && uni.length <= 25 && p.mode !== "weights" && spec.universe.kind === "static" && timeLeft()) {
    const outs: { ticker: string; active: number }[] = [];
    for (const t of uni) {
      if (!timeLeft()) break;
      const s2 = structuredClone(spec);
      (s2.universe as { tickers: string[] }).tickers = uni.filter((x) => x !== t);
      if (s2.portfolio.mode === "rules") s2.portfolio.max_positions = Math.min(s2.portfolio.max_positions, uni.length - 1);
      const sim2 = simulateSpec(check, prep, {}, s2);
      outs.push({ ticker: t, active: annual(activeSeries(spec, sim2.sim.equity, bench)) });
    }
    const worst = [...outs].sort((a, b) => a.active - b.active)[0];
    const warn = worst !== undefined && activeAnnual > 0 && (worst.active <= 0 || worst.active < activeAnnual * 0.5);
    values.loo = { worst_ticker: worst?.ticker ?? null, worst_pct: worst ? r2(worst.active) : null, runs: outs.length };
    checks.push({
      id: 12,
      name: "Leave one ticker out",
      tier: "B",
      level: "W",
      status: warn ? "warn" : "pass",
      detail: worst ? `Leaving out ${worst.ticker} moves the active return to ${r2(worst.active)}% a year (from ${r2(activeAnnual)}%).` : "Not enough tickers to test.",
    });
  }

  // 13. Regimes: SPY above or below its 200-session average; volatility terciles.
  {
    const T = prep.panel.dates.length;
    const spy = prep.panel.col.get("SPY")!;
    const close = (t: number) => prep.panel.close[spy * T + t]!;
    const up: number[] = [];
    const down: number[] = [];
    const vols: number[] = [];
    for (let i = 0; i < active.length; i++) {
      const t = prep.startIndex + i; // decision known at the close before the return day
      let s = 0;
      let ok = t >= 199;
      if (ok) for (let q = t - 199; q <= t; q++) s += close(q);
      (ok && close(t) > s / 200 ? up : down).push(active[i]!);
      let v = 0;
      ok = t >= 21;
      if (ok) {
        const r: number[] = [];
        for (let q = t - 20; q <= t; q++) r.push(Math.log(close(q) / close(q - 1)));
        const m = mean(r);
        v = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1));
      }
      vols.push(v);
    }
    const q1 = quantile(vols, 1 / 3);
    const q2 = quantile(vols, 2 / 3);
    const terc: number[][] = [[], [], []];
    vols.forEach((v, i) => terc[v <= q1 ? 0 : v <= q2 ? 1 : 2]!.push(active[i]!));
    const total = active.reduce((a, b) => a + b, 0);
    const share = (xs: number[]) => (total > 0 ? (xs.reduce((a, b) => a + b, 0) / total) * 100 : null);
    const shares = [share(up), share(down), ...terc.map(share)];
    const warn = total > 0 && shares.some((s) => s !== null && s > 80);
    values.regimes = {
      above_200d_pct: r2(annual(up)),
      below_200d_pct: r2(annual(down)),
      low_vol_pct: r2(annual(terc[0]!)),
      mid_vol_pct: r2(annual(terc[1]!)),
      high_vol_pct: r2(annual(terc[2]!)),
    };
    checks.push({
      id: 13,
      name: "Regimes",
      tier: "B",
      level: "W",
      status: warn ? "warn" : "info",
      detail: `Active return a year with SPY above its 200-session average ${r2(annual(up))}%, below ${r2(annual(down))}%; in low, middle and high volatility thirds ${r2(annual(terc[0]!))}%, ${r2(annual(terc[1]!))}%, ${r2(annual(terc[2]!))}%.${warn ? " One regime gives more than 80% of the active return." : ""}`,
    });
  }
  return { checks, values };
}

export function mergeTierB(report: QualityReport, b: TierBResult): QualityReport {
  const checks = [...report.checks.filter((c) => !(c.tier === "B")), ...b.checks].sort((a, x) => a.id - x.id || (a.tier < x.tier ? -1 : 1));
  const values = { ...report.values, ...b.values };
  return { ...report, tiers: ["A", "B"], checks, values, flags: topFlags(checks, values) };
}

export { r2 };
export type { Targets };
