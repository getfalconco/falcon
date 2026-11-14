/**
 * Engine v2 (design 4.4): one simulator, two output shapes.
 *
 *   Signals (rules mode): entry/exit conditions per ticker per session. The
 *     simulator holds the state (flat or held, entry price, stop levels,
 *     sessions held). An entry triggers only after the entry rule has been
 *     false since the last exit ("edge"), or after a cooldown. Sizing happens
 *     at entry; no drift rebalancing while held.
 *   Targets (rank and weights modes): a weight per ticker per session, NaN =
 *     HOLD (leave the position as it is), 0 = flat, applied only on rebalance
 *     sessions. Between them only risk exits act.
 *
 * At each open, in order: risk exits that gap through, signal and max-hold
 * exits, rebalance to targets, new entries. During the day: resting stops,
 * trailing stops and take-profit orders (a bar touching both a stop and a
 * target fills the stop). At the close: mark to market, cash earns the
 * T-bill rate.
 *
 * Clocks: close (decided on close t, filled at open t+1) and preopen
 * (decided at 09:15 on t from bars up to t-1, filled at open t).
 *
 * `legacy` reproduces the v1 engine exactly (list-order ties, level re-entry,
 * fixed slippage, no cash rate, drift rebalancing, v1's order of fills).
 */

import { isPeriodEnd, isoToDay } from "./calendar";
import { costModel, type CostModel } from "./costs";
import type { Panel } from "./fsl/eval";
import { seededOrder } from "./util";

export type Signals = {
  kind: "signals";
  /** Universe columns x sessions (u * T + t), 1 = true. */
  entry: Float64Array;
  exit: Float64Array | null;
  /** Optional tie-break score (higher first unless order is asc). */
  score?: { values: Float64Array; order: "desc" | "asc" } | null;
};

export type Targets = {
  kind: "targets";
  /** Universe columns x sessions; NaN = hold. */
  target: Float64Array;
  /** 1 on decision sessions whose targets are traded at the next fill. */
  rebalance: Uint8Array;
};

export type StrategyOutput = Signals | Targets;

export type SimOptions = {
  universe: string[];
  startIndex: number;
  endIndex: number;
  clock: "close" | "preopen";
  maxPositions: number;
  sizing: "equal" | "inverse_vol" | { pct: number };
  reentry: "edge" | { cooldown_days: number } | "v1";
  tiebreak: "seeded" | "list_order";
  seed: string;
  risk: { stop_pct: number | null; trailing_pct: number | null; take_profit_pct: number | null; max_hold_days: number | null };
  commissionBps: number;
  spread: "auto" | number;
  /** v1 costs: fixed slippage with no floor. */
  noCostFloor: boolean;
  costMultiplier?: number;
  /** Daily cash return per session (null = 0%). */
  cashRate: Float64Array | null;
  capital: number;
  grossCap: number;
  /** v1 drift rebalancing in rules mode. */
  drift: "none" | "weekly" | "monthly";
  /** v1 order: open-gap stops after entries. */
  legacyOrder: boolean;
  /** Extra sessions between decision and fill (the delay check). */
  delay?: number;
};

export type ExitReasonV2 = "signal" | "stop_loss" | "trailing_stop" | "take_profit" | "max_holding" | "rebalance" | "end";

export type TradeV2 = {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  cost: number;
  proceeds: number;
  pnl: number;
  returnPct: number;
  sessionsHeld: number;
  exitReason: ExitReasonV2;
  /** Half-spread and commission paid on this trade's fills, dollars. */
  costsPaid: number;
  /** Entry notional as % of the 20-session average dollar volume. */
  advPct: number | null;
  /** Unadjusted price at entry. */
  rawEntry: number;
  entryIndex: number;
  exitIndex: number;
};

export type SimResult = {
  dates: string[];
  equity: Float64Array;
  /** Share of equity in positions at each close. */
  invested: Float64Array;
  /** Cash rate applied each session. */
  cashRate: Float64Array;
  trades: TradeV2[];
  /** Traded notional each session (buys plus sells) / equity. */
  turnover: Float64Array;
  costsPaid: number;
  skippedEntries: number;
  /** Rebalance sessions where at least one order was filled. */
  rebalances: number;
  /** Positions above 1% of ADV at entry. */
  overAdv: number;
  maxAdvPct: number | null;
  minRawPrice: number | null;
};

type Position = {
  u: number;
  shares: number;
  entryIdx: number;
  entryPrice: number;
  cost: number;
  proceeds: number;
  lastPrice: number;
  peak: number;
  costsPaid: number;
  advPct: number | null;
  rawEntry: number;
};

export function simulate(panel: Panel, out: StrategyOutput, o: SimOptions): SimResult {
  const T = panel.dates.length;
  const U = o.universe.length;
  const cols = o.universe.map((t) => {
    const c = panel.col.get(t);
    if (c === undefined) throw new Error(`No data column for ${t}.`);
    return c;
  });
  const costs: CostModel = costModel(panel, { spread: o.spread, commissionBps: o.commissionBps, noFloor: o.noCostFloor, multiplier: o.costMultiplier });
  const comm = costs.commission;
  const lag = (o.clock === "close" ? 1 : 0) + (o.delay ?? 0);
  const start = o.startIndex;
  const end = o.endIndex;
  const n = end - start + 1;

  const bar = (u: number, t: number) => {
    const k = cols[u]! * T + t;
    return panel.has[k] ? { open: panel.open[k]!, high: panel.high[k]!, low: panel.low[k]!, close: panel.close[k]! } : null;
  };
  const closeAt = (u: number, t: number) => panel.close[cols[u]! * T + t]!;

  let cash = o.capital;
  const positions = new Map<number, Position>();
  const trades: TradeV2[] = [];
  const equity = new Float64Array(n);
  const invested = new Float64Array(n);
  const turnover = new Float64Array(n);
  const cashRate = new Float64Array(n);
  let costsPaid = 0;
  let skippedEntries = 0;
  let rebalances = 0;
  let overAdv = 0;
  let maxAdvPct: number | null = null;
  let minRawPrice: number | null = null;
  let traded = 0;

  // Re-entry state per ticker.
  const armed = new Uint8Array(U).fill(1);
  const lastExit = new Int32Array(U).fill(-1_000_000);
  let pendingExit = new Map<number, ExitReasonV2>();
  let pendingDrift = false;
  // v1 re-entry reads "not held" on the decision close, before that close's exits are filled.
  const heldAtClose = new Uint8Array(U);

  const buy = (pos: Position, alloc: number, price: number, t: number) => {
    const hs = costs.halfSpread(cols[pos.u]!, t);
    const px = price * (1 + hs);
    const notional = alloc / (1 + comm);
    const shares = notional / px;
    const before = pos.shares;
    pos.entryPrice = before > 0 ? (pos.entryPrice * before + px * shares) / (before + shares) : px;
    pos.shares += shares;
    pos.cost += alloc;
    cash -= alloc;
    const paid = alloc - notional + shares * price * hs;
    pos.costsPaid += paid;
    costsPaid += paid;
    traded += alloc;
  };
  const sell = (pos: Position, shares: number, price: number, t: number): number => {
    const hs = costs.halfSpread(cols[pos.u]!, t);
    const px = price * (1 - hs);
    const net = shares * px * (1 - comm);
    pos.shares -= shares;
    pos.proceeds += net;
    cash += net;
    const paid = shares * price - net;
    pos.costsPaid += paid;
    costsPaid += paid;
    traded += shares * px;
    return px;
  };
  const close = (pos: Position, price: number, t: number, reason: ExitReasonV2, held: number) => {
    const shares = pos.shares;
    const px = sell(pos, shares, price, t);
    const pnl = pos.proceeds - pos.cost;
    trades.push({
      ticker: o.universe[pos.u]!,
      entryDate: panel.dates[pos.entryIdx]!,
      entryPrice: pos.entryPrice,
      exitDate: panel.dates[t]!,
      exitPrice: px,
      shares,
      cost: pos.cost,
      proceeds: pos.proceeds,
      pnl,
      returnPct: pos.cost > 0 ? (pnl / pos.cost) * 100 : 0,
      sessionsHeld: held,
      exitReason: reason,
      costsPaid: pos.costsPaid,
      advPct: pos.advPct,
      rawEntry: pos.rawEntry,
      entryIndex: pos.entryIdx,
      exitIndex: t,
    });
    positions.delete(pos.u);
    armed[pos.u] = 0;
    lastExit[pos.u] = t;
  };
  const open = (u: number, alloc: number, price: number, t: number) => {
    const c = cols[u]!;
    const adv = costs.adv(c, t);
    const raw = t > 0 ? panel.raw[c * T + t - 1]! : panel.raw[c * T + t]!;
    const pos: Position = {
      u,
      shares: 0,
      entryIdx: t,
      entryPrice: 0,
      cost: 0,
      proceeds: 0,
      lastPrice: price,
      peak: price,
      costsPaid: 0,
      advPct: adv > 0 ? (alloc / adv) * 100 : null,
      rawEntry: raw,
    };
    if (pos.advPct !== null) {
      if (pos.advPct > 1) overAdv++;
      maxAdvPct = Math.max(maxAdvPct ?? 0, pos.advPct);
    }
    if (Number.isFinite(raw)) minRawPrice = Math.min(minRawPrice ?? Infinity, raw);
    positions.set(u, pos);
    buy(pos, alloc, price, t);
  };
  const equityAtOpen = (t: number) => {
    let v = cash;
    positions.forEach((p) => {
      v += p.shares * (bar(p.u, t)?.open ?? p.lastPrice);
    });
    return v;
  };
  const weightFor = (u: number, d: number): number => {
    if (typeof o.sizing === "object") return o.sizing.pct / 100;
    const base = 1 / o.maxPositions;
    if (o.sizing === "equal") return base;
    const vols: number[] = [];
    let mine = NaN;
    for (let k = 0; k < U; k++) {
      const v = realizedVol(panel, cols[k]!, d, 63);
      if (Number.isFinite(v) && v > 0) {
        vols.push(v);
        if (k === u) mine = v;
      }
    }
    if (!Number.isFinite(mine) || !vols.length) return base;
    const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
    return base * Math.min(2, Math.max(0.25, avg / mine));
  };

  const riskGap = (t: number, includeToday: boolean) => {
    const { stop_pct, trailing_pct, take_profit_pct } = o.risk;
    if (stop_pct === null && trailing_pct === null && take_profit_pct === null) return;
    positions.forEach((pos) => {
      const b = bar(pos.u, t);
      if (!b) return;
      if (!includeToday && pos.entryIdx === t) return;
      if (pos.entryIdx === t) return;
      const stop = stopLevel(pos);
      const target = take_profit_pct !== null ? pos.entryPrice * (1 + take_profit_pct / 100) : null;
      if (stop !== null && b.open <= stop.level) return close(pos, b.open, t, stop.reason, t - pos.entryIdx + 1);
      if (target !== null && b.open >= target) return close(pos, b.open, t, "take_profit", t - pos.entryIdx + 1);
    });
  };
  const stopLevel = (pos: Position): { level: number; reason: ExitReasonV2 } | null => {
    const { stop_pct, trailing_pct } = o.risk;
    const fixed = stop_pct !== null ? pos.entryPrice * (1 - stop_pct / 100) : null;
    const trail = trailing_pct !== null ? pos.peak * (1 - trailing_pct / 100) : null;
    if (fixed === null && trail === null) return null;
    if (trail !== null && (fixed === null || trail > fixed)) return { level: trail, reason: "trailing_stop" };
    return { level: fixed!, reason: "stop_loss" };
  };

  for (let t = start; t <= end; t++) {
    const k = t - start;
    const d = t - lag; // the decision session filled at this open
    const decided = d >= start;

    // 1. Open: risk exits that gap through (design order).
    if (t > start && !o.legacyOrder) riskGap(t, false);

    // 2. Signal and max-hold exits decided earlier.
    if (t > start) {
      const still = new Map<number, ExitReasonV2>();
      pendingExit.forEach((reason, u) => {
        const pos = positions.get(u);
        if (!pos) return;
        const b = bar(u, t);
        if (!b) {
          still.set(u, reason);
          return;
        }
        close(pos, b.open, t, reason, t - pos.entryIdx);
      });
      pendingExit = still;
    }
    if (decided && out.kind === "signals" && out.exit && t > start) {
      positions.forEach((pos) => {
        if (pos.entryIdx > d) return; // entered after that decision
        if (out.exit![pos.u * T + d]! > 0) {
          const b = bar(pos.u, t);
          if (b) close(pos, b.open, t, "signal", t - pos.entryIdx);
          else pendingExit.set(pos.u, "signal");
        }
      });
    }

    // 3a. v1 drift rebalancing (legacy rules mode).
    if (pendingDrift && positions.size && t > start) {
      const eq = equityAtOpen(t);
      const target = (typeof o.sizing === "object" ? o.sizing.pct / 100 : 1 / o.maxPositions) * eq;
      const moves: { pos: Position; diff: number; open: number }[] = [];
      positions.forEach((pos) => {
        const b = bar(pos.u, t);
        if (!b || pendingExit.has(pos.u)) return;
        const diff = target - pos.shares * b.open;
        if (Math.abs(diff) > eq * 0.0025) moves.push({ pos, diff, open: b.open });
      });
      for (const m of moves) if (m.diff < 0) sell(m.pos, Math.min(m.pos.shares, -m.diff / m.open), m.open, t);
      for (const m of moves) if (m.diff > 0 && cash > 0) buy(m.pos, Math.min(m.diff, cash), m.open, t);
    }
    pendingDrift = false;

    // 3b. Rebalance to targets.
    if (out.kind === "targets" && decided && out.rebalance[d] && t > start - (lag === 0 ? 1 : 0)) {
      const eq = equityAtOpen(t);
      const w = new Float64Array(U).fill(NaN);
      let gross = 0;
      for (let u = 0; u < U; u++) {
        const v = out.target[u * T + d]!;
        if (Number.isFinite(v)) {
          w[u] = Math.max(0, Math.min(1, v));
          gross += w[u]!;
        }
      }
      // Weights above the gross cap in total are scaled down; held (NaN) positions count at their value.
      let heldValue = 0;
      positions.forEach((p) => {
        if (!Number.isFinite(w[p.u]!)) heldValue += p.shares * (bar(p.u, t)?.open ?? p.lastPrice);
      });
      const room = Math.max(0, o.grossCap - heldValue / Math.max(eq, 1e-9));
      const scale = gross > room ? room / gross : 1;
      let any = false;
      const sells: { u: number; value: number }[] = [];
      const buys: { u: number; value: number }[] = [];
      for (let u = 0; u < U; u++) {
        if (!Number.isFinite(w[u]!)) continue;
        const b = bar(u, t);
        if (!b) continue;
        const want = w[u]! * scale * eq;
        const pos = positions.get(u);
        const have = pos ? pos.shares * b.open : 0;
        const diff = want - have;
        if (want <= 1e-9 && pos) sells.push({ u, value: -Infinity });
        else if (Math.abs(diff) > eq * 0.001) (diff < 0 ? sells : buys).push({ u, value: diff });
      }
      for (const s of sells) {
        const pos = positions.get(s.u)!;
        const b = bar(s.u, t)!;
        any = true;
        if (s.value === -Infinity || pos.shares * b.open + s.value <= eq * 0.0005) close(pos, b.open, t, "rebalance", t - pos.entryIdx);
        else sell(pos, Math.min(pos.shares, -s.value / b.open), b.open, t);
      }
      for (const s of buys) {
        const b = bar(s.u, t)!;
        const alloc = Math.min(s.value, cash);
        if (alloc <= eq * 0.0005) continue;
        any = true;
        const pos = positions.get(s.u);
        if (pos) buy(pos, alloc, b.open, t);
        else open(s.u, alloc, b.open, t);
      }
      if (any) rebalances++;
    }

    // 4. New entries.
    if (out.kind === "signals" && decided && t > start - (lag === 0 ? 1 : 0)) {
      const cands: number[] = [];
      for (let u = 0; u < U; u++) {
        const on = out.entry[u * T + d]! > 0;
        if (!on) continue;
        if (positions.has(u)) continue;
        if (o.reentry === "v1" && heldAtClose[u]) continue;
        if (o.reentry === "edge" && !armed[u]) continue;
        if (typeof o.reentry === "object" && d - lastExit[u]! < o.reentry.cooldown_days) continue;
        cands.push(u);
      }
      if (cands.length) {
        let order: number[];
        if (out.score) {
          const sc = out.score;
          order = [...cands].sort((a, b) => {
            const x = sc.values[a * T + d]!;
            const y = sc.values[b * T + d]!;
            const nx = Number.isNaN(x);
            const ny = Number.isNaN(y);
            if (nx !== ny) return nx ? 1 : -1;
            if (x !== y) return sc.order === "desc" ? y - x : x - y;
            return o.universe[a]! < o.universe[b]! ? -1 : 1;
          });
        } else if (o.tiebreak === "list_order") order = cands;
        else {
          const byName = new Map(cands.map((u) => [o.universe[u]!, u]));
          order = seededOrder(Array.from(byName.keys()), o.seed, panel.dates[t]!).map((name) => byName.get(name)!);
        }
        const eq = equityAtOpen(t);
        for (const u of order) {
          const b = bar(u, t);
          if (!b || positions.has(u)) continue;
          const alloc = Math.min(weightFor(u, d) * eq, cash);
          if (positions.size >= o.maxPositions || alloc < eq * 0.001) {
            skippedEntries++;
            continue;
          }
          open(u, alloc, b.open, t);
        }
      }
    }

    // v1 order: open gaps are checked after entries, in the intraday pass.
    if (t > start && o.legacyOrder) riskGap(t, false);

    // 5. During the day: resting stops and targets.
    if (o.risk.stop_pct !== null || o.risk.trailing_pct !== null || o.risk.take_profit_pct !== null) {
      positions.forEach((pos) => {
        const b = bar(pos.u, t);
        if (!b) return;
        const stop = stopLevel(pos);
        const target = o.risk.take_profit_pct !== null ? pos.entryPrice * (1 + o.risk.take_profit_pct / 100) : null;
        const today = pos.entryIdx === t;
        if (o.legacyOrder && !today) {
          if (stop !== null && b.open <= stop.level) return close(pos, b.open, t, stop.reason, t - pos.entryIdx + 1);
          if (target !== null && b.open >= target) return close(pos, b.open, t, "take_profit", t - pos.entryIdx + 1);
        }
        if (stop !== null && b.low <= stop.level) return close(pos, stop.level, t, stop.reason, t - pos.entryIdx + 1);
        if (target !== null && b.high >= target) return close(pos, target, t, "take_profit", t - pos.entryIdx + 1);
      });
    }

    // 6. The close: mark to market; cash earns the T-bill rate.
    let inv = 0;
    positions.forEach((pos) => {
      const b = bar(pos.u, t);
      if (b) {
        pos.lastPrice = b.close;
        pos.peak = Math.max(pos.peak, b.close);
      } else pos.lastPrice = closeAt(pos.u, t) || pos.lastPrice;
      inv += pos.shares * pos.lastPrice;
    });
    const rate = o.cashRate ? o.cashRate[t] ?? 0 : 0;
    cashRate[k] = rate;
    if (rate && cash > 0) cash *= 1 + rate;
    if (t === end) {
      positions.forEach((pos) => close(pos, pos.lastPrice, t, "end", t - pos.entryIdx + 1));
      equity[k] = cash;
      invested[k] = 0;
    } else {
      const v = cash + inv;
      equity[k] = v;
      invested[k] = v > 0 ? inv / v : 0;
    }
    turnover[k] = equity[k]! > 0 ? traded / equity[k]! : 0;
    traded = 0;
    if (t === end) {
      // The final liquidation is not turnover the strategy chose.
      turnover[k] = 0;
      break;
    }

    // 7. On the close: max-hold exits and the re-entry state for later decisions.
    heldAtClose.fill(0);
    positions.forEach((pos) => (heldAtClose[pos.u] = 1));
    positions.forEach((pos) => {
      if (o.risk.max_hold_days !== null && t - pos.entryIdx + 1 >= o.risk.max_hold_days) pendingExit.set(pos.u, "max_holding");
    });
    if (out.kind === "signals" && o.reentry === "edge") {
      // The decision for the next fill reads entry at d' = t + 1 - lag; an exit re-arms after any false.
      const dn = t + 1 - lag;
      if (dn >= 0 && dn < T) for (let u = 0; u < U; u++) if (!(out.entry[u * T + dn]! > 0) && !positions.has(u)) armed[u] = 1;
    }
    if (o.drift !== "none" && positions.size) {
      const day = isoToDay(panel.dates[t]!);
      const next = t + 1 < T ? isoToDay(panel.dates[t + 1]!) : null;
      pendingDrift = next !== null ? periodOf(day, o.drift) !== periodOf(next, o.drift) : isPeriodEnd(day, o.drift);
    }
  }

  return {
    dates: panel.dates.slice(start, end + 1),
    equity,
    invested,
    cashRate,
    trades,
    turnover,
    costsPaid,
    skippedEntries,
    rebalances,
    overAdv,
    maxAdvPct,
    minRawPrice: minRawPrice === Infinity ? null : minRawPrice,
  };
}

function periodOf(day: number, every: "weekly" | "monthly"): string {
  if (every === "monthly") return new Date(day * 86_400_000).toISOString().slice(0, 7);
  return String(Math.floor((day + 3) / 7));
}

/** Annualized realized volatility of daily log returns over [t - n + 1, t]. */
export function realizedVol(panel: Panel, c: number, t: number, n: number): number {
  const T = panel.dates.length;
  if (t - n < 0) return NaN;
  const r: number[] = [];
  for (let q = t - n + 1; q <= t; q++) {
    const a = panel.close[c * T + q - 1]!;
    const b = panel.close[c * T + q]!;
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  if (r.length < n / 2) return NaN;
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  const v = r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}

/** Buy-and-hold of one ticker (the benchmark) or of a list at equal weight, same costs, same calendar. */
export function buyAndHold(
  panel: Panel,
  tickers: string[],
  start: number,
  end: number,
  opts: { capital: number; commissionBps: number; spread: "auto" | number; noCostFloor: boolean; cashRate: Float64Array | null },
): Float64Array {
  const T = panel.dates.length;
  const costs = costModel(panel, { spread: opts.spread, commissionBps: opts.commissionBps, noFloor: opts.noCostFloor });
  const comm = costs.commission;
  const n = end - start + 1;
  const out = new Float64Array(n);
  const slot = opts.capital / Math.max(1, tickers.length);
  const shares = new Float64Array(tickers.length);
  const cols = tickers.map((t) => panel.col.get(t) ?? -1);
  let cash = opts.capital;
  const bought = new Uint8Array(tickers.length);
  for (let t = start; t <= end; t++) {
    let value = 0;
    cols.forEach((c, i) => {
      if (c < 0) return;
      const k = c * T + t;
      if (!bought[i] && panel.has[k]) {
        // Bought at the first close in the window (the v1 benchmark convention).
        const hs = costs.halfSpread(c, Math.min(t + 1, T - 1));
        shares[i] = slot / (1 + comm) / (panel.close[k]! * (1 + hs));
        cash -= slot;
        bought[i] = 1;
      }
      if (bought[i]) {
        const px = panel.close[k]!;
        value += t === end ? shares[i]! * px * (1 - costs.halfSpread(c, Math.min(t, T - 1))) * (1 - comm) : shares[i]! * px;
      }
    });
    if (opts.cashRate && cash > 0) cash *= 1 + (opts.cashRate[t] ?? 0);
    out[t - start] = cash + value;
  }
  return out;
}
