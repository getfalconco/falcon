import { useEffect, useMemo, useState } from "react";
import { usePortfolioValuation } from "@/hooks/usePortfolioBalance";
import { demoValueSeries, useDemoMode } from "@/lib/demo-mode";
import { paperScopeKey, readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import {
  heldClasses,
  periodReturn,
  periodStart,
  valueAt,
  type HeldClass,
  type ReturnPeriod,
  type ValuePoint,
} from "@/lib/portfolio-return";
import { supabase } from "@/lib/supabase";

/**
 * What the Portfolio return card shows, from the same record the Net worth
 * chart draws: the daily closes this device kept, the worker's snapshots in
 * the cloud, and the live balance as the end point.
 *
 * The cloud is asked for three single rows, not a series: the first snapshot
 * ever (how old the record is), and the snapshots either side of the window's
 * opening. The worker writes every few seconds, so a series covering three
 * years would be millions of rows; three rows answer the question.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type PortfolioReturnView = {
  /** Gain in dollars over the window, net of any flows the data can separate. */
  gain: number;
  /** As a fraction; null when there is no positive starting value. */
  ratio: number | null;
  /** When the window actually opens: the later of its calendar start and the first record. */
  startAt: number;
  /** True when the record starts after the window would: the line then says "since". */
  clipped: boolean;
  /** The first record of all, for the default window. */
  firstAt: number | null;
  /** False while a brokerage is linked: money moved there is not visible, so the figure is a change, not a return. */
  flowsKnown: boolean;
  classes: HeldClass[];
};

function readHistory(): ValuePoint[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(paperScopeKey("networthHistory")) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const out: ValuePoint[] = [];
    for (const p of parsed as Array<{ date?: unknown; value?: unknown }>) {
      if (typeof p?.date !== "string" || typeof p.value !== "number" || !Number.isFinite(p.value)) continue;
      // Stamped at noon, as the chart reads them: one number for a whole session.
      const t = new Date(`${p.date}T12:00:00`).getTime();
      if (Number.isFinite(t) && p.value > 0) out.push({ t, value: p.value });
    }
    return out;
  } catch {
    return [];
  }
}

type SnapRow = { ts: string; value: number | string };

async function oneSnapshot(build: (q: any) => any): Promise<ValuePoint | null> {
  if (!supabase) return null;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return null;
    const { data, error } = await build(supabase.from("portfolio_snapshots").select("ts,value")).limit(1);
    const row = (error ? null : (data as SnapRow[] | null)?.[0]) ?? null;
    if (!row) return null;
    const t = new Date(row.ts).getTime();
    const value = Number(row.value);
    return Number.isFinite(t) && Number.isFinite(value) && value > 0 ? { t, value } : null;
  } catch {
    return null;
  }
}

/** The cloud's first snapshot, and the ones either side of `at`. */
function useCloudAnchors(at: number | null): ValuePoint[] {
  const [first, setFirst] = useState<ValuePoint | null>(null);
  const [around, setAround] = useState<ValuePoint[]>([]);

  useEffect(() => {
    let live = true;
    void oneSnapshot((q) => q.order("ts", { ascending: true })).then((p) => {
      if (live) setFirst(p);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (at == null) return;
    let live = true;
    const iso = new Date(at).toISOString();
    void Promise.all([
      oneSnapshot((q) => q.lte("ts", iso).order("ts", { ascending: false })),
      oneSnapshot((q) => q.gte("ts", iso).order("ts", { ascending: true })),
    ]).then((pts) => {
      if (live) setAround(pts.filter((p): p is ValuePoint => p != null));
    });
    return () => {
      live = false;
    };
  }, [at]);

  return useMemo(() => (first ? [first, ...around] : around), [first, around]);
}

function useBrokerageLinked(): boolean {
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    let live = true;
    void window.meridian
      ?.getBrokerageNetWorth?.()
      .then((res) => {
        if (live && res?.ok && res.networth.connected && res.networth.accounts.length > 0) setLinked(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return linked;
}

/** Days a demo window spans: "All" stands for a little over three years. */
function demoDays(period: ReturnPeriod, now: number): number {
  return Math.max(1, (now - periodStart(period, now, now - 1100 * DAY_MS)) / DAY_MS);
}

export function usePortfolioReturn(period: ReturnPeriod): PortfolioReturnView {
  const demo = useDemoMode();
  const { value: balance } = usePortfolioValuation();
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);
  const brokerage = useBrokerageLinked();

  // Read once per mount and whenever the book changes: the recorder appends
  // at most one row a day, so this does not need a poll.
  const history = useMemo(() => readHistory(), [account]);
  const now = useMemo(() => Date.now(), [period, account]);
  const localFirst = history.reduce<number | null>((m, p) => (m == null || p.t < m ? p.t : m), null);

  const windowStart = period === "All" ? null : periodStart(period, now, null);
  const cloud = useCloudAnchors(demo ? null : windowStart);

  return useMemo<PortfolioReturnView>(() => {
    const classes = heldClasses({
      cash: account.cash,
      positions: Object.values(account.positions).map((p) => ({ symbol: p.symbol, value: p.costUsd })),
      brokerage: !demo && brokerage,
    });

    if (demo) {
      const firstAt = now - 1100 * DAY_MS;
      const series = demoValueSeries(demo.seed, demoDays(period, now), balance);
      const startAt = periodStart(period, now, firstAt);
      const start = series[0]?.value ?? balance;
      const r = periodReturn({ startValue: start, endValue: balance, startAt, endAt: now });
      return { ...r, startAt, clipped: false, firstAt, flowsKnown: true, classes };
    }

    const points: ValuePoint[] = [...history, ...cloud, { t: now, value: balance }];
    const firstAt = points.reduce<number | null>((m, p) => (m == null || p.t < m ? p.t : m), localFirst);
    const want = periodStart(period, now, firstAt);
    const start = valueAt(points, want) ?? { t: now, value: balance };
    const startAt = Math.max(want, start.t <= want ? want : start.t);
    const r = periodReturn({ startValue: start.value, endValue: balance, startAt, endAt: now });
    return {
      ...r,
      startAt,
      clipped: period === "All" || start.t > want,
      firstAt,
      flowsKnown: !brokerage,
      classes,
    };
  }, [demo, account, brokerage, balance, history, cloud, now, period, localFirst]);
}
