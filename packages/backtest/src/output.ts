/**
 * Spec + prepared data -> StrategyOutput (Signals | Targets) through the FSL
 * evaluator. Pure. Also the run options the simulator needs from a spec.
 */

import { isPeriodEnd, isoToDay } from "./calendar";
import { Evaluator, type EvalEnv, type Evaluated } from "./fsl/eval";
import type { Prepared } from "./prepare";
import type { SimOptions, StrategyOutput } from "./simulate";
import { realizedVol } from "./simulate";
import { resolvedParams, specHash, universeTickers, type StrategySpecV2 } from "./spec";

export function evalEnv(spec: StrategySpecV2, prep: Prepared, overrides: Partial<EvalEnv> = {}): EvalEnv {
  return {
    panel: prep.panel,
    universe: universeTickers(spec),
    params: resolvedParams(spec),
    defs: spec.defs,
    tbill: prep.tbill,
    clock: spec.portfolio.mode === "rules" ? spec.portfolio.clock : "close",
    events: prep.events,
    ...overrides,
  };
}

/** A formula's value as a universe-wide series (market and constant values broadcast). */
export function asSeries(v: Evaluated, U: number, T: number): Float64Array {
  if (v.shape === "series") return v.value;
  const out = new Float64Array(U * T);
  for (let u = 0; u < U; u++) {
    if (v.shape === "const") out.fill(v.value, u * T, (u + 1) * T);
    else out.set(v.value, u * T);
  }
  return out;
}

export function asMarket(v: Evaluated, T: number): Float64Array {
  if (v.shape === "const") return new Float64Array(T).fill(v.value);
  if (v.shape === "market") return v.value;
  return v.value.slice(0, T);
}

/** Decision sessions that trade targets: period ends, plus the first session (initial allocation). */
export function rebalanceFlags(prep: Prepared, every: StrategySpecV2["rebalance"]): Uint8Array {
  const T = prep.panel.dates.length;
  const out = new Uint8Array(T);
  for (let t = prep.startIndex; t < T; t++) out[t] = isPeriodEnd(isoToDay(prep.panel.dates[t]!), every) ? 1 : 0;
  out[prep.startIndex] = 1;
  return out;
}

export type ComputedOutput = { output: StrategyOutput; universe: string[] };

export function computeOutput(spec: StrategySpecV2, prep: Prepared, weightOrder: string[] | null, overrides: Partial<EvalEnv> = {}): ComputedOutput {
  const env = evalEnv(spec, prep, overrides);
  const T = prep.panel.dates.length;
  const universe = env.universe;
  const U = universe.length;
  const ev = new Evaluator(env);
  const p = spec.portfolio;
  const cols = universe.map((t) => prep.panel.col.get(t)!);
  const lagHas = env.clock === "preopen" ? 1 : 0;
  const hasAt = (u: number, t: number) => t - lagHas >= 0 && prep.panel.has[cols[u]! * T + t - lagHas] === 1;
  const filter = spec.universe.kind === "rule" && spec.universe.filter ? asSeries(ev.run(spec.universe.filter), U, T) : null;

  if (p.mode === "rules") {
    const entry = asSeries(ev.run(p.entry), U, T).slice();
    const exit = p.exit ? asSeries(ev.run(p.exit), U, T).slice() : null;
    for (let u = 0; u < U; u++) {
      for (let t = 0; t < T; t++) {
        const i = u * T + t;
        // A condition is false on a session where the ticker has no bar (v1 rule).
        if (!hasAt(u, t)) {
          entry[i] = 0;
          if (exit) exit[i] = 0;
        } else {
          entry[i] = entry[i]! > 0 && (!filter || filter[i]! > 0) ? 1 : 0;
          if (exit) exit[i] = exit[i]! > 0 ? 1 : 0;
        }
      }
    }
    const score = p.tiebreak !== "seeded" ? { values: asSeries(ev.run(p.tiebreak.by), U, T), order: p.tiebreak.order } : null;
    return { output: { kind: "signals", entry, exit, score }, universe };
  }

  if (p.mode === "rank") {
    const score = asSeries(ev.run(p.score), U, T);
    const keep = p.filter ? asSeries(ev.run(p.filter), U, T) : null;
    const reb = rebalanceFlags(prep, spec.rebalance);
    const target = new Float64Array(U * T).fill(NaN);
    const n =
      "n" in p.select ? (typeof p.select.n === "number" ? p.select.n : Math.round(env.params[p.select.n.slice(1)] ?? 1)) : null;
    for (let t = 0; t < T; t++) {
      if (!reb[t]) continue;
      const ok: number[] = [];
      for (let u = 0; u < U; u++) {
        const i = u * T + t;
        if (Number.isFinite(score[i]!) && hasAt(u, t) && (!keep || keep[i]! > 0) && (!filter || filter[i]! > 0)) ok.push(u);
      }
      ok.sort((a, b) => {
        const d = score[a * T + t]! - score[b * T + t]!;
        if (d !== 0) return p.order === "desc" ? -d : d;
        return universe[a]! < universe[b]! ? -1 : 1;
      });
      let chosen: number[];
      if (n !== null) chosen = ok.slice(0, n);
      else {
        // Quantile [lo, hi] of the ranking, measured from the preferred end.
        const [lo, hi] = (p.select as { quantile: [number, number] }).quantile;
        const m = ok.length;
        chosen = ok.filter((_, r) => {
          const q = m > 1 ? 1 - r / (m - 1) : 1;
          return q >= lo && q <= hi;
        });
      }
      const w = new Map<number, number>();
      if (p.weighting === "equal" || !chosen.length) chosen.forEach((u) => w.set(u, 1));
      else if (p.weighting === "score") {
        chosen.forEach((u) => {
          const s = score[u * T + t]!;
          w.set(u, Math.max(0, p.order === "desc" ? s : -s));
        });
        if (Array.from(w.values()).every((x) => x <= 0)) chosen.forEach((u) => w.set(u, 1));
      } else {
        chosen.forEach((u) => {
          const v = realizedVol(prep.panel, cols[u]!, t, 63);
          w.set(u, Number.isFinite(v) && v > 0 ? 1 / v : 0);
        });
        if (Array.from(w.values()).every((x) => x <= 0)) chosen.forEach((u) => w.set(u, 1));
      }
      const total = Array.from(w.values()).reduce((a, b) => a + b, 0);
      for (let u = 0; u < U; u++) target[u * T + t] = total > 0 ? (w.get(u) ?? 0) / total : 0;
    }
    return { output: { kind: "targets", target, rebalance: reb }, universe };
  }

  if (p.mode === "weights") {
    const order = weightOrder ?? Object.keys(p.weights);
    const weights = new Map<string, Float64Array>();
    const wenv: EvalEnv = { ...env, universe: [], weights };
    const wev = new Evaluator(wenv);
    for (const t of order) weights.set(t, asMarket(wev.run(p.weights[t]!), T));
    const reb = rebalanceFlags(prep, spec.rebalance);
    const target = new Float64Array(U * T).fill(NaN);
    universe.forEach((t, u) => {
      const w = weights.get(t)!;
      for (let d = 0; d < T; d++) if (reb[d]) target[u * T + d] = w[d]!;
    });
    return { output: { kind: "targets", target, rebalance: reb }, universe };
  }
  throw new Error("Event-study specs are measured, not simulated.");
}

/** Simulator options from a spec. */
export function simOptions(spec: StrategySpecV2, prep: Prepared, universe: string[], extra: Partial<SimOptions> = {}): SimOptions {
  const p = spec.portfolio;
  const legacy = spec.legacy;
  return {
    universe,
    startIndex: prep.startIndex,
    endIndex: prep.endIndex,
    clock: p.mode === "rules" ? p.clock : "close",
    maxPositions: p.mode === "rules" ? p.max_positions : universe.length,
    sizing: p.mode === "rules" ? p.sizing : "equal",
    reentry: legacy ? "v1" : p.mode === "rules" ? p.reentry : "edge",
    tiebreak: legacy ? "list_order" : "seeded",
    seed: specHash(spec),
    risk: spec.risk,
    commissionBps: spec.execution.commission_bps,
    spread: spec.execution.spread,
    noCostFloor: Boolean(legacy),
    cashRate: legacy || spec.cash === "zero" ? null : prep.tbill,
    capital: spec.capital,
    grossCap: spec.execution.gross_cap,
    drift: legacy ? legacy.drift : "none",
    legacyOrder: Boolean(legacy),
    ...extra,
  };
}
