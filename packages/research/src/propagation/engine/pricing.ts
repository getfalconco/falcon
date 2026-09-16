/**
 * §6 pricing check — the product's reason to exist. Pure and deterministic.
 *
 * For a tracked target: reference price = last regular close before the
 * event; realized = beta-adjusted residual move from that close to the last
 * price (raw move under the low-R² fallback, flagged); expected scale =
 * daily_vol_30d × tier scale; status by |realized| / expected against the
 * config thresholds — `priced` only in the transmitted direction, and a
 * meaningful move the other way is `contradicted`, never folded into either.
 * Beyond the horizon the status is `stale`. Untracked targets are `unknown`:
 * reported, never fabricated.
 */

import type { Direction } from "../../classifier/types.js";
import {
  isTradingDay,
  nextTradingDay,
  nyYmd,
  sessionTimes,
} from "../../tracker/calendar.js";
import type { DailyBar } from "../../tracker/types.js";
import type { PropagationPricingConfig } from "./config.js";
import type { Pricing, PropagationTier } from "./types.js";

/** What the host extracts from the Tracker for one tracked target. */
export type TargetQuantSnapshot = {
  ticker: string;
  /** Daily bars, oldest first (NY dates). */
  bars: DailyBar[];
  /** Benchmark bars aligned on the same dates (SPY). */
  benchBars: DailyBar[];
  beta: number | null;
  r2: number | null;
  vol30: number | null;
  /** Latest price (live quote or last close) and its instant. */
  lastPrice: number | null;
  lastPriceTs: string | null;
  /**
   * Benchmark price at the same instant as `lastPrice`, when the host can
   * derive one (live quant context); null → the benchmark's latest close is
   * used and the residual is flagged as close-to-close on the benchmark leg.
   */
  benchLastPrice: number | null;
  /**
   * Minute prints covering the event, newest last (Tracker `fetchIntradaySeries`).
   * When they reach back past `event_ts` the reference becomes the last print
   * BEFORE the event rather than the previous close — the only way to measure
   * the target's own reaction on the event's session instead of a day that
   * already contains it.
   */
  intraday?: Array<{ t: number; c: number }> | null;
  /** The benchmark's prints over the same window, for the residual leg. */
  benchIntraday?: Array<{ t: number; c: number }> | null;
};

export type PricingInputs = {
  snapshot: TargetQuantSnapshot | null;
  eventTs: string;
  now: string;
  tier: PropagationTier;
  direction: Direction;
  config: PropagationPricingConfig;
};

export const UNKNOWN_PRICING: Pricing = {
  status: "unknown",
  realized_resid_pct: null,
  expected_pct: null,
  basis: "none",
  reference_close_ts: null,
  reference_close: null,
  last_price: null,
  last_price_ts: null,
  realized_raw_pct: null,
  bench_move_pct: null,
  beta: null,
  ratio: null,
  sessions_elapsed: null,
  anchor: "close",
  since_event_pct: null,
  first_30m_pct: null,
  note: null,
};

function unknown(note: string): Pricing {
  return { ...UNKNOWN_PRICING, note };
}

/** UTC instant of the regular-session close on a trading day. */
export function closeInstant(ymd: string): Date | null {
  return sessionTimes(ymd)?.closeUtc ?? null;
}

/**
 * The last daily bar whose regular close happened strictly before `eventTs`:
 * bars on earlier NY dates, or the event day's own bar when the event landed
 * after that day's close (post-market / overnight release).
 */
export function referenceBar(bars: DailyBar[], eventTs: string): DailyBar | null {
  const event = new Date(eventTs);
  if (Number.isNaN(event.getTime())) return null;
  const eventDay = nyYmd(event);
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (bar.d < eventDay) return bar;
    if (bar.d === eventDay) {
      const close = closeInstant(bar.d);
      if (close && event.getTime() >= close.getTime()) return bar;
    }
  }
  return null;
}

/** Bars up to and including `day` — the latest close at or before a date. */
export function barOnOrBefore(bars: DailyBar[], day: string): DailyBar | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].d <= day) return bars[i];
  }
  return null;
}

/** Trading sessions that have opened after `refDay` up to and including `now`'s NY day. */
export function sessionsElapsed(refDay: string, now: string): number {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) return 0;
  const today = nyYmd(nowDate);
  let count = 0;
  let day = nextTradingDay(refDay);
  while (day <= today) {
    if (day === today) {
      // Today counts once its regular session has opened.
      const times = sessionTimes(day);
      if (times && nowDate.getTime() >= times.openUtc.getTime()) count += 1;
      break;
    }
    if (isTradingDay(day)) count += 1;
    day = nextTradingDay(day);
  }
  return count;
}

/** The last print at or before `instant`, or null when the series starts later. */
export function printBefore(
  prints: Array<{ t: number; c: number }> | null | undefined,
  instant: string,
): { t: number; c: number } | null {
  if (!prints || prints.length === 0) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  let best: { t: number; c: number } | null = null;
  for (const p of prints) {
    if (p.t > at) break;
    best = p;
  }
  return best;
}

/**
 * Move from the event instant to the last print inside the window, or null.
 * The base is the last print BEFORE the instant when there is one — the jump
 * across the event itself is the part that matters, and starting at the first
 * print after it would discard exactly that.
 */
export function moveSince(
  prints: Array<{ t: number; c: number }> | null | undefined,
  instant: string,
  withinMs?: number,
): number | null {
  if (!prints || prints.length === 0) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  const from = printBefore(prints, instant) ?? prints.find((p) => p.t >= at);
  if (!from || from.c <= 0) return null;
  const until = withinMs == null ? Number.POSITIVE_INFINITY : at + withinMs;
  let to: { t: number; c: number } | null = null;
  for (const p of prints) {
    if (p.t > until) break;
    if (p.t >= at) to = p;
  }
  return to ? to.c / from.c - 1 : null;
}

export function computePricing(inputs: PricingInputs): Pricing {
  const { snapshot, config } = inputs;
  if (!snapshot) return UNKNOWN_PRICING;
  if (!snapshot.bars.length) return unknown("no price history for the target");

  const ref = referenceBar(snapshot.bars, inputs.eventTs);
  if (!ref) return unknown("no regular close before the event in the target's history");
  // The event instant beats the previous close whenever the minute series
  // reaches it: on the event's own session the close-to-close reference
  // already contains the reaction we are trying to measure.
  const eventPrint = printBefore(snapshot.intraday, inputs.eventTs);
  const refClose = eventPrint ? eventPrint.c : ref.c;
  const refCloseTs = eventPrint ? new Date(eventPrint.t).toISOString() : (closeInstant(ref.d)?.toISOString() ?? null);

  // Last price: the live quote / latest close the host supplied, else the
  // last bar after the reference.
  let lastPrice = snapshot.lastPrice;
  let lastPriceTs = snapshot.lastPriceTs;
  if (lastPrice == null || !Number.isFinite(lastPrice)) {
    const last = snapshot.bars[snapshot.bars.length - 1];
    lastPrice = last.c;
    lastPriceTs = closeInstant(last.d)?.toISOString() ?? null;
  }
  const elapsed = sessionsElapsed(ref.d, inputs.now);

  const realizedRaw = refClose > 0 ? lastPrice / refClose - 1 : null;
  if (realizedRaw == null || !Number.isFinite(realizedRaw)) {
    return { ...unknown("reference close unusable"), reference_close: refClose, reference_close_ts: refCloseTs };
  }

  // Benchmark leg: same reference day; last = the host's same-instant price
  // when available, else the benchmark's latest close.
  const benchEventPrint = eventPrint ? printBefore(snapshot.benchIntraday, inputs.eventTs) : null;
  const benchRef = barOnOrBefore(snapshot.benchBars, ref.d);
  const benchLastBar = snapshot.benchBars[snapshot.benchBars.length - 1] ?? null;
  const benchLast =
    snapshot.benchLastPrice != null && Number.isFinite(snapshot.benchLastPrice)
      ? snapshot.benchLastPrice
      : (benchLastBar?.c ?? null);
  const benchBase = benchEventPrint ? benchEventPrint.c : (benchRef?.c ?? null);
  const benchMove =
    benchBase != null && benchLast != null && benchBase > 0 ? benchLast / benchBase - 1 : null;

  const notes: string[] = [];
  const beta = snapshot.beta;
  const r2 = snapshot.r2;
  const residualTrusted =
    beta != null && Number.isFinite(beta) && r2 != null && Number.isFinite(r2) && r2 >= config.lowR2Fallback;
  let basis: Pricing["basis"] = "raw";
  let realized = realizedRaw;
  if (residualTrusted && benchMove != null) {
    basis = "residual";
    realized = realizedRaw - (beta as number) * benchMove;
    if (snapshot.benchLastPrice == null && snapshot.lastPrice != null) {
      notes.push("benchmark leg measured close-to-close");
    }
  } else if (beta == null || r2 == null) {
    notes.push("no beta — raw move");
  } else if (!residualTrusted) {
    notes.push(`low R² (${r2.toFixed(2)}) — raw move`);
  } else {
    notes.push("no benchmark history — raw move");
  }

  const vol = snapshot.vol30;
  const scale = config.tierScale[inputs.tier] ?? 0.25;
  const expected = vol != null && Number.isFinite(vol) && vol > 0 ? vol * scale : null;

  const base: Pricing = {
    status: "unknown",
    realized_resid_pct: realized,
    expected_pct: expected,
    basis,
    reference_close_ts: refCloseTs,
    reference_close: refClose,
    last_price: lastPrice,
    last_price_ts: lastPriceTs,
    realized_raw_pct: realizedRaw,
    bench_move_pct: benchMove,
    beta: beta ?? null,
    ratio: null,
    sessions_elapsed: elapsed,
    anchor: eventPrint ? "event" : "close",
    since_event_pct: moveSince(snapshot.intraday, inputs.eventTs),
    first_30m_pct: moveSince(snapshot.intraday, inputs.eventTs, 30 * 60_000),
    note: null,
  };

  if (expected == null) {
    notes.push("no 30d volatility — expected scale incomputable");
    return { ...base, note: notes.join("; ") };
  }

  const ratio = Math.abs(realized) / expected;
  const verdict = classifyPricing({
    realized,
    expected,
    direction: inputs.direction,
    sessionsElapsed: elapsed,
    config,
  });
  if (verdict.note) notes.push(verdict.note);
  return { ...base, status: verdict.status, ratio, note: notes.length ? notes.join("; ") : null };
}

// ---------------------------------------------------------------------------
// The status decision, on its own (§6)
// ---------------------------------------------------------------------------

export type PricingVerdictInputs = {
  /** Residual (or raw) move from the reference close, signed. */
  realized: number;
  /** daily_vol_30d × tier scale, > 0. */
  expected: number;
  /** The transmitted direction — `unclear`/`mixed` means no expected sign. */
  direction: Direction;
  sessionsElapsed: number;
  config: PropagationPricingConfig;
};

/**
 * Pure status decision, shared by the live check and by replays of stored
 * runs. Sign matters over the whole ≥ openBelow band, not just at
 * pricedAtOrAbove: a target that moved meaningfully the wrong way has not
 * "partially absorbed" the event, it has contradicted it. Below openBelow the
 * sign is noise — nothing has happened yet, so the target stays `open`
 * whichever way it drifted. With no expected sign (`unclear`) contradiction is
 * undefined and the comparison is magnitude-only, as before.
 */
export function classifyPricing(inputs: PricingVerdictInputs): {
  status: Pricing["status"];
  note: string | null;
} {
  const { realized, expected, config } = inputs;
  if (inputs.sessionsElapsed > config.horizonSessions) {
    return {
      status: "stale",
      note: `${inputs.sessionsElapsed} sessions since the reference close (horizon ${config.horizonSessions})`,
    };
  }
  const ratio = Math.abs(realized) / expected;
  if (ratio < config.openBelow) return { status: "open", note: null };

  const sign = inputs.direction === "positive" ? 1 : inputs.direction === "negative" ? -1 : 0;
  if (sign === 0) {
    // Direction unclear/mixed: magnitudes only (§6) — no sign to contradict.
    return ratio >= config.pricedAtOrAbove
      ? { status: "priced", note: "direction unclear — magnitude comparison only" }
      : { status: "partial", note: null };
  }
  if (Math.sign(realized) !== sign) {
    return {
      status: "contradicted",
      note: `moved against the expected direction (expected ${inputs.direction}, realized ${(realized * 100).toFixed(2)}%)`,
    };
  }
  return ratio >= config.pricedAtOrAbove ? { status: "priced", note: null } : { status: "partial", note: null };
}

// ---------------------------------------------------------------------------
// Absorption curve (§11 calibration)
// ---------------------------------------------------------------------------

export type AbsorptionPoint = {
  /** Sessions since the reference close: 0 is the first one that could react. */
  session: number;
  /** NY trading date of the close. */
  date: string;
  close: number;
  /** Cumulative move from the reference close. */
  raw_pct: number;
  /** The benchmark's cumulative move over the same span. */
  bench_pct: number | null;
  /** raw − β·bench when both are available, else raw. */
  residual_pct: number;
  /** Signed travel against the expected scale: 1 = exactly the called move. */
  multiple: number | null;
};

export type AbsorptionInputs = {
  bars: DailyBar[];
  benchBars: DailyBar[];
  beta: number | null;
  /** daily_vol_30d × tier scale, as the run recorded it. */
  expectedPct: number | null;
  /** The transmitted direction; `unclear`/`mixed` compares magnitudes only. */
  direction: Direction;
  eventTs: string;
  /** Sessions to report, including session 0. */
  maxSessions?: number;
};

/**
 * How a target's reaction arrived, session by session — the answer to "was the
 * move over on day 0, or did it keep going". A run's pricing check is a single
 * instant; this is the shape behind it, and the evidence any change to the
 * 0.35 / 1.0 thresholds or the 3-session horizon has to rest on.
 *
 * Cumulative from the same reference close the pricing check used, so the last
 * point of an in-horizon curve reconciles with `realized_resid_pct`.
 */
export function absorptionCurve(inputs: AbsorptionInputs): AbsorptionPoint[] {
  const ref = referenceBar(inputs.bars, inputs.eventTs);
  if (!ref || ref.c <= 0) return [];
  const refIndex = inputs.bars.findIndex((b) => b.d === ref.d);
  if (refIndex < 0) return [];
  const benchRef = barOnOrBefore(inputs.benchBars, ref.d);
  const benchByDay = new Map(inputs.benchBars.map((b) => [b.d, b.c]));
  const sign =
    inputs.direction === "positive" ? 1 : inputs.direction === "negative" ? -1 : 0;
  const expected =
    inputs.expectedPct != null && Number.isFinite(inputs.expectedPct) && inputs.expectedPct > 0
      ? inputs.expectedPct
      : null;
  const max = inputs.maxSessions ?? 4;

  const out: AbsorptionPoint[] = [];
  for (let k = 0; k < max; k++) {
    const bar = inputs.bars[refIndex + 1 + k];
    if (!bar) break;
    const raw = bar.c / ref.c - 1;
    const benchClose = benchByDay.get(bar.d);
    const benchPct =
      benchRef && benchRef.c > 0 && benchClose != null ? benchClose / benchRef.c - 1 : null;
    const residual =
      inputs.beta != null && Number.isFinite(inputs.beta) && benchPct != null
        ? raw - inputs.beta * benchPct
        : raw;
    const travelled = sign === 0 ? Math.abs(residual) : residual * sign;
    out.push({
      session: k,
      date: bar.d,
      close: bar.c,
      raw_pct: raw,
      bench_pct: benchPct,
      residual_pct: residual,
      multiple: expected == null ? null : travelled / expected,
    });
  }
  return out;
}
