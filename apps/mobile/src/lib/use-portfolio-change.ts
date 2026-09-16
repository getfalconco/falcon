import { useEffect, useMemo, useState } from "react";
import { fetchPaperAccount, type PaperPosition } from "@/lib/brokers";
import { useDemoMode } from "@/lib/demo-mode";
import { getStockChartRange, getStockQuote } from "@/lib/stock-quote";

/** The three windows the headline change cycles through. */
export const CHANGE_PERIODS = ["Daily", "Weekly", "All"] as const;
export type ChangePeriod = (typeof CHANGE_PERIODS)[number];

export type PortfolioChange = {
  /** Signed dollar move over the window. */
  amount: number;
  /** `amount` as a percentage of what the book was worth when the window opened. */
  pct: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 60_000;

/**
 * Change in the book over one window, measured on the positions only.
 *
 * Cash does not move, so the dollar figure is also the change in net worth;
 * leaving cash out of the denominator is what makes the percentage a return on
 * what is actually invested. "All" is therefore the same total P&L the assets
 * card headlines — the two numbers agree on purpose.
 *
 * Each window differs only in where it reads the opening price:
 *   Daily   the quote's own previous close
 *   Weekly  the last daily close at least 7 days back
 *   All     the position's cost basis
 */
export function usePortfolioChange(period: ChangePeriod): {
  change: PortfolioChange | null;
  ready: boolean;
} {
  const demo = useDemoMode();
  const [realPositions, setRealPositions] = useState<Record<string, PaperPosition> | null>(
    null,
  );
  const [quotes, setQuotes] = useState<Record<string, { price: number; change: number }>>({});
  const [weekAgo, setWeekAgo] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void fetchPaperAccount()
        .then((paper) => {
          if (!cancelled) setRealPositions(paper?.positions ?? {});
        })
        .catch(() => {
          if (!cancelled) setRealPositions({});
        });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const positions = demo ? demo.account.positions : realPositions;
  const symbols = Object.keys(positions ?? {}).sort();
  const symbolKey = symbols.join(",");

  useEffect(() => {
    const list = symbolKey ? symbolKey.split(",") : [];
    if (list.length === 0) {
      setQuotes({});
      return;
    }
    let cancelled = false;

    const load = () => {
      void Promise.all(
        list.map(async (s) => {
          try {
            const q = await getStockQuote(s);
            return [s, { price: q.price, change: q.change }] as const;
          } catch {
            return null;
          }
        }),
      ).then((entries) => {
        if (cancelled) return;
        const next: Record<string, { price: number; change: number }> = {};
        for (const e of entries) {
          if (e && Number.isFinite(e[1].price) && e[1].price > 0) next[e[0]] = e[1];
        }
        setQuotes(next);
      });
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbolKey]);

  // Only the weekly window needs history, so only it pays for the extra calls.
  useEffect(() => {
    const list = symbolKey ? symbolKey.split(",") : [];
    if (period !== "Weekly" || list.length === 0) return;
    let cancelled = false;

    const now = Date.now();
    const cutoff = now - 7 * DAY_MS;
    void Promise.all(
      list.map(async (s) => {
        try {
          // Three weeks back so holidays and long weekends still leave a close
          // on the far side of the cutoff.
          const pts = await getStockChartRange(
            s,
            Math.floor((now - 21 * DAY_MS) / 1000),
            Math.floor(now / 1000),
          );
          const before = pts.filter((p) => p.t <= cutoff);
          const pick = before.length > 0 ? before[before.length - 1] : pts[0];
          return pick ? ([s, pick.v] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const e of entries) {
        if (e && Number.isFinite(e[1]) && e[1] > 0) next[e[0]] = e[1];
      }
      setWeekAgo(next);
    });

    return () => {
      cancelled = true;
    };
  }, [symbolKey, period]);

  return useMemo(() => {
    if (positions === null) return { change: null, ready: false };

    const list = Object.values(positions);
    if (list.length === 0) return { change: { amount: 0, pct: 0 }, ready: true };

    const priced = list.filter((p) => quotes[p.symbol] != null);
    if (priced.length === 0) return { change: null, ready: false };

    let amount = 0;
    let opening = 0;
    for (const p of priced) {
      const q = quotes[p.symbol]!;
      const value = p.shares * q.price;
      if (period === "Daily") {
        amount += p.shares * q.change;
        opening += value - p.shares * q.change;
      } else if (period === "Weekly") {
        const then = weekAgo[p.symbol];
        if (then == null) return { change: null, ready: false };
        amount += value - p.shares * then;
        opening += p.shares * then;
      } else {
        amount += value - p.costUsd;
        opening += Math.abs(p.costUsd);
      }
    }

    const pct = opening > 1e-9 ? (amount / opening) * 100 : 0;
    return { change: { amount, pct }, ready: true };
  }, [positions, quotes, weekAgo, period]);
}
