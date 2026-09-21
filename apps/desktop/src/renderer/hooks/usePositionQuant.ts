import { useEffect, useState } from "react";

/**
 * The tracker's quant read of each held name — beta, volatility, momentum,
 * the residual of today's move, distance to the 52-week marks — plus how many
 * sessions away its next earnings print is. Polled slowly: these move once a
 * day, not once a tick.
 */

export type PositionQuant = {
  /** 90-day beta to the benchmark. */
  beta: number | null;
  /** How much of the name's daily movement that beta explains, 0 to 1. */
  betaR2: number | null;
  /** Daily volatility over 30 days, in percent. */
  vol30: number | null;
  /** 20-day momentum, in percent. */
  mom20: number | null;
  /** Today's move with beta × market taken out, in standard deviations. */
  residZ: number | null;
  /** Percent below the 52-week high (≤ 0) and above the 52-week low (≥ 0). */
  fromHigh: number | null;
  fromLow: number | null;
  /** Trading sessions until the next scheduled earnings; null when unknown. */
  earningsIn: number | null;
};

const POLL_MS = 60_000;

/** Weekdays from today (exclusive) to `dueAt` (inclusive) — sessions, roughly. */
function sessionsUntil(dueAt: string): number | null {
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  if (due < today) return null;
  let n = 0;
  const d = new Date(today);
  while (d < due) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return n;
}

async function quantOf(symbol: string): Promise<PositionQuant> {
  const out: PositionQuant = {
    beta: null,
    betaR2: null,
    vol30: null,
    mom20: null,
    residZ: null,
    fromHigh: null,
    fromLow: null,
    earningsIn: null,
  };
  try {
    const q = await window.meridian?.getTrackerQuant?.(symbol);
    if (q?.ok) {
      out.beta = q.quant.beta_90d;
      out.betaR2 = q.quant.r_squared;
      out.vol30 = q.quant.daily_vol_30d;
      out.mom20 = q.quant.momentum_20d;
      out.residZ = q.quant.residual_zscore;
      out.fromHigh = q.quant.pct_from_52w_high;
      out.fromLow = q.quant.pct_from_52w_low;
    }
  } catch {
    /* the tracker may not know the name yet */
  }
  try {
    const s = await window.meridian?.getTrackerTickerState?.(symbol);
    if (s?.ok) {
      const next = s.state.scheduledEarnings
        .map((e) => sessionsUntil(e.dueAt))
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b)[0];
      out.earningsIn = next ?? null;
    }
  } catch {
    /* no schedule known */
  }
  return out;
}

/**
 * @param symbolsKey comma-joined, sorted symbols — a stable effect dependency.
 */
export function usePositionQuant(symbolsKey: string): Record<string, PositionQuant> {
  const [quant, setQuant] = useState<Record<string, PositionQuant>>({});

  useEffect(() => {
    const list = symbolsKey ? symbolsKey.split(",").filter(Boolean) : [];
    if (list.length === 0) {
      setQuant({});
      return;
    }
    let cancelled = false;
    const load = () => {
      void Promise.all(list.map(async (s) => [s, await quantOf(s)] as const)).then((entries) => {
        if (cancelled) return;
        setQuant((prev) => {
          // Merge, and drop what is no longer held.
          const next: Record<string, PositionQuant> = {};
          for (const s of list) if (prev[s]) next[s] = prev[s];
          for (const [s, q] of entries) next[s] = q;
          return next;
        });
      });
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbolsKey]);

  return quant;
}
