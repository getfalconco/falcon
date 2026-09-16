import { useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  fetchLiveBrokerSnapshot,
  fetchPaperAccount,
  type PaperAccount,
} from "@/lib/brokers";
import {
  useDemoMode,
} from "@/lib/demo-mode";
import { getStockQuote } from "@/lib/stock-quote";
import { requireSupabase } from "@/lib/supabase";

const DAY_MS = 24 * 60 * 60 * 1000;
const INTRADAY_KEY = "falcon.networthIntraday";
const HISTORY_KEY = "falcon.networthHistory";

export type SeriesPoint = { t: number; value: number };
export type CloudSnapshot = { ts: string; value: number };

export function usePortfolioBalance(): { balance: number; balanceReady: boolean } {
  const demo = useDemoMode();
  const [realAccount, setRealAccount] = useState<PaperAccount | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [brokerageTotal, setBrokerageTotal] = useState(0);
  const [balanceReady, setBalanceReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [paper, live] = await Promise.all([
          fetchPaperAccount(),
          fetchLiveBrokerSnapshot().catch(() => ({
            connected: false,
            total: 0,
            accounts: [],
          })),
        ]);
        if (cancelled) return;
        setRealAccount(paper);
        setBrokerageTotal(live.total);
        setBalanceReady(true);
      } catch {
        if (!cancelled) {
          setRealAccount({ cash: 0, positions: {} });
          setBalanceReady(true);
        }
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Demo overlay replaces the paper book (desktop Ctrl+P). Live brokers stay
  // out of the headline so the fake book reads as a clean presentation.
  const account = demo?.account ?? realAccount;
  const liveBrokerage = demo ? 0 : brokerageTotal;

  const symbols = Object.keys(account?.positions ?? {})
    .sort()
    .join(",");

  useEffect(() => {
    const list = symbols ? symbols.split(",") : [];
    if (list.length === 0) {
      setPrices({});
      return;
    }
    let cancelled = false;

    const load = () => {
      void Promise.all(
        list.map(async (s) => {
          try {
            const q = await getStockQuote(s);
            return [s, q.price] as const;
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
        setPrices(next);
      });
    };

    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbols]);

  const positionsValue = Object.values(account?.positions ?? {}).reduce(
    (sum, p) =>
      sum + (prices[p.symbol] != null ? p.shares * prices[p.symbol]! : p.costUsd),
    0,
  );
  const cash = account?.cash ?? 0;
  const balance = cash + positionsValue + liveBrokerage;

  useEffect(() => {
    // Never persist demo balances into the real net-worth history.
    if (demo || !balanceReady || !Number.isFinite(balance)) return;
    void recordNetworth(balance);
    const id = setInterval(() => void recordNetworth(balance), 60_000);
    return () => clearInterval(id);
  }, [balance, balanceReady, demo]);

  return { balance, balanceReady };
}

export function usePaperPositions(): PaperAccount["positions"] {
  const demo = useDemoMode();
  const [positions, setPositions] = useState<PaperAccount["positions"]>({});

  useEffect(() => {
    if (demo) {
      setPositions(demo.account.positions);
      return;
    }
    let cancelled = false;
    void fetchPaperAccount()
      .then((paper) => {
        if (!cancelled) setPositions(paper?.positions ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [demo]);

  return positions;
}

async function recordNetworth(balance: number): Promise<void> {
  try {
    const now = Date.now();
    const raw = await AsyncStorage.getItem(INTRADAY_KEY);
    const parsed = raw ? (JSON.parse(raw) as { points?: SeriesPoint[] }) : null;
    const cutoff = now - DAY_MS;
    const points = (parsed?.points ?? []).filter(
      (p) => Number.isFinite(p?.t) && p.t >= cutoff && Number.isFinite(p?.value),
    );
    const minute = Math.floor(now / 60_000);
    if (points.length > 0 && Math.floor(points[points.length - 1].t / 60_000) === minute) {
      points[points.length - 1] = { t: now, value: balance };
    } else {
      points.push({ t: now, value: balance });
    }
    await AsyncStorage.setItem(INTRADAY_KEY, JSON.stringify({ points }));

    const hRaw = await AsyncStorage.getItem(HISTORY_KEY);
    const parsedHist = hRaw ? JSON.parse(hRaw) : [];
    const hist: Array<{ date: string; value: number }> = Array.isArray(parsedHist) ? parsedHist : [];
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const dayKey = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const idx = hist.findIndex((r) => r?.date === dayKey);
    if (idx >= 0) hist[idx] = { date: dayKey, value: balance };
    else hist.push({ date: dayKey, value: balance });
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  } catch {
    /* recording is best-effort */
  }
}

export async function readIntraday(): Promise<SeriesPoint[]> {
  try {
    const raw = await AsyncStorage.getItem(INTRADAY_KEY);
    const parsed = raw ? (JSON.parse(raw) as { points?: SeriesPoint[] }) : null;
    if (!Array.isArray(parsed?.points)) return [];
    const cutoff = Date.now() - DAY_MS;
    return parsed.points
      .filter((p) => Number.isFinite(p?.t) && p.t >= cutoff && Number.isFinite(p?.value))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

export async function readHistory(): Promise<Array<{ date: string; value: number }>> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p: { date?: string; value?: number }) =>
        typeof p?.date === "string" && Number.isFinite(p?.value),
    );
  } catch {
    return [];
  }
}

export async function fetchCloudSnapshots(days: number): Promise<CloudSnapshot[]> {
  try {
    const client = requireSupabase();
    const { data: auth } = await client.auth.getSession();
    if (!auth.session) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data, error } = await client
      .from("portfolio_snapshots")
      .select("ts,value")
      .gte("ts", cutoff.toISOString())
      .order("ts", { ascending: true })
      .limit(5000);
    if (error || !data) return [];

    return data
      .filter(
        (row): row is CloudSnapshot =>
          typeof row.ts === "string" && Number.isFinite(Number(row.value)),
      )
      .map((row) => ({ ts: row.ts, value: Number(row.value) }));
  } catch {
    return [];
  }
}

export function formatNetworth(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

export function useRecordedSeries(): {
  history: Array<{ date: string; value: number }>;
  intraday: SeriesPoint[];
  cloudSnaps: CloudSnapshot[];
} {
  const [history, setHistory] = useState<Array<{ date: string; value: number }>>([]);
  const [intraday, setIntraday] = useState<SeriesPoint[]>([]);
  const [cloudSnaps, setCloudSnaps] = useState<CloudSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all([readHistory(), readIntraday(), fetchCloudSnapshots(366)]).then(
        ([h, i, c]) => {
          if (cancelled) return;
          setHistory(h);
          setIntraday(i);
          setCloudSnaps(c);
        },
      );
    };
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return useMemo(() => ({ history, intraday, cloudSnaps }), [history, intraday, cloudSnaps]);
}
