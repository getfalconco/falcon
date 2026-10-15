/**
 * Analyst estimate revisions per name (method: shared/estimate-revisions.ts).
 *
 * Reads Yahoo's `earningsTrend` once per name and holds the answer in memory:
 * thirty minutes while the regular session is open, and until the next open
 * otherwise, so a closed market is asked once. A failed read is held for a few
 * minutes, so a provider that is down is not asked again on every render. The
 * read itself is time limited in the market data service.
 *
 * Yahoo keeps no history of the revenue estimate, so each read records the
 * day's mean per period in `<dir>/revenue-history.json`; the 30 day revenue
 * change is shown once a reading from about a month back is on record.
 *
 * Electron-free: the reader, the directory and the clock are injected.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { nyYmdOf } from "../../shared/earnings-time";
import {
  buildEstimates,
  estimatesFreshUntil,
  readEarningsTrend,
  recordRevenue,
  type EstimateRevisions,
  type RevenuePoint,
} from "../../shared/estimate-revisions";

export type EstimatesDeps = {
  dir: string;
  /** Raw quoteSummary modules for one symbol; null when the provider has nothing; throws on a failed read. */
  fetchTrend: (symbol: string) => Promise<Record<string, unknown> | null>;
  now?: () => number;
  concurrency?: number;
};

type Entry = { until: number; value: EstimateRevisions | null; failed: boolean };

/** How long a failed read is held before the name is asked again. */
export const FAILED_TTL_MS = 5 * 60_000;
/** Names held in memory at most; the oldest go first. */
const ENTRY_CAP = 600;
/** Names kept in the revenue history file at most; the least recently read go first. */
const HISTORY_CAP = 1500;

type HistoryFile = Record<string, RevenuePoint[]>;

export function createEstimatesService(deps: EstimatesDeps) {
  const now = deps.now ?? Date.now;
  const concurrency = deps.concurrency ?? 3;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<EstimateRevisions | null>>();
  const file = path.join(deps.dir, "revenue-history.json");
  let history: Promise<HistoryFile> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const loadHistory = (): Promise<HistoryFile> => {
    if (!history) {
      history = fs
        .readFile(file, "utf8")
        .then((text) => {
          const parsed = JSON.parse(text) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HistoryFile) : {};
        })
        .catch(() => ({}));
    }
    return history;
  };

  const saveHistory = (all: HistoryFile): Promise<void> => {
    writing = writing
      .then(async () => {
        await fs.mkdir(deps.dir, { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(all), "utf8");
        await fs.rename(tmp, file);
      })
      .catch((err) => console.warn("[estimates] revenue history not saved:", err instanceof Error ? err.message : String(err)));
    return writing;
  };

  const read = async (ticker: string): Promise<EstimateRevisions | null> => {
    const at = now();
    const today = nyYmdOf(at);
    let entry: Entry;
    try {
      const rows = readEarningsTrend(await deps.fetchTrend(ticker));
      const all = await loadHistory();
      const before = all[ticker] ?? [];
      const kept = recordRevenue(before, today, rows);
      const value = buildEstimates(ticker, rows, kept, today, new Date(at).toISOString());
      if (JSON.stringify(kept) !== JSON.stringify(before)) {
        delete all[ticker];
        if (kept.length > 0) all[ticker] = kept;
        const names = Object.keys(all);
        for (const old of names.slice(0, Math.max(0, names.length - HISTORY_CAP))) delete all[old];
        void saveHistory(all);
      }
      entry = { until: estimatesFreshUntil(at), value, failed: false };
    } catch (err) {
      console.warn("[estimates] read failed:", ticker, err instanceof Error ? err.message : String(err));
      entry = { until: at + FAILED_TTL_MS, value: entries.get(ticker)?.value ?? null, failed: true };
    }
    entries.delete(ticker);
    entries.set(ticker, entry);
    if (entries.size > ENTRY_CAP) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return entry.value;
  };

  const one = (ticker: string): Promise<EstimateRevisions | null> => {
    const hit = entries.get(ticker);
    if (hit && now() < hit.until) return Promise.resolve(hit.value);
    const pending = inFlight.get(ticker);
    if (pending) return pending;
    const task = read(ticker).finally(() => inFlight.delete(ticker));
    inFlight.set(ticker, task);
    return task;
  };

  /** Each name's figures, `concurrency` reads at a time; a name without figures is null. */
  const many = async (tickers: readonly string[]): Promise<Record<string, EstimateRevisions | null>> => {
    const out: Record<string, EstimateRevisions | null> = {};
    let next = 0;
    const worker = async () => {
      while (next < tickers.length) {
        const t = tickers[next++]!;
        out[t] = await one(t);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));
    return out;
  };

  /** Resolves once pending history writes have landed (tests). */
  const flush = (): Promise<void> => writing;

  return { one, many, flush };
}

export type EstimatesService = ReturnType<typeof createEstimatesService>;
