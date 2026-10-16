/**
 * The options-implied report move for upcoming reports, against the stock's
 * own report-day record (method: shared/implied-move.ts).
 *
 * Reads, per name: the listed expiries and the nearest chain (one read), the
 * expiry that covers the report and the one after it (one read each when they
 * are not the nearest), and the last reports' moves (the Stock tab's report
 * history: Yahoo's quarters, the 8-K item 2.02 filings and daily closes).
 *
 * Option snapshots are held in memory: a few minutes while the regular
 * session is open, and until the next open otherwise, so a closed market is
 * asked once. A failed read is held a few minutes at most (FAILED_TTL_MS),
 * so one timeout on a closed market does not blank the figure until the next
 * open. Every chain read is time limited in the market data service.
 *
 * Electron-free: the readers and the clock are injected.
 */

import type { OptionChainRead } from "../stock/market-data-service";
import { nyYmdOf } from "../../shared/earnings-time";
import {
  impliedFigure,
  latestOpenMs,
  moveHistory,
  pickExpiries,
  reportCover,
  sessionsAfter,
  sessionsThrough,
  snapshotFreshUntil,
  type ImpliedMove,
  type ImpliedRequestItem,
  type ReportMove,
} from "../../shared/implied-move";

export type ImpliedMoveDeps = {
  fetchChain: (symbol: string, expiry?: string) => Promise<OptionChainRead | null>;
  /** The last reports' moves (fractions, signed), any order; empty when none can be read. */
  reportMoves: (symbol: string) => Promise<ReportMove[]>;
  now?: () => number;
  concurrency?: number;
};

type Snapshot = { at: number; until: number; value: OptionChainRead | null; failed: boolean };

/** Snapshots kept at most; the oldest go first. */
const SNAPSHOT_CAP = 400;
/** A failed chain read is held this long at most before the name is asked again. */
export const FAILED_TTL_MS = 5 * 60_000;

export function createImpliedMoveService(deps: ImpliedMoveDeps) {
  const now = deps.now ?? Date.now;
  const concurrency = deps.concurrency ?? 3;
  const snapshots = new Map<string, Snapshot>();
  const inFlight = new Map<string, Promise<Snapshot>>();

  const chain = (symbol: string, expiry?: string): Promise<Snapshot> => {
    const key = `${symbol}|${expiry ?? ""}`;
    const hit = snapshots.get(key);
    if (hit && now() < hit.until) return Promise.resolve(hit);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async (): Promise<Snapshot> => {
      const at = now();
      let snap: Snapshot;
      try {
        snap = { at, until: snapshotFreshUntil(at), value: await deps.fetchChain(symbol, expiry), failed: false };
      } catch (err) {
        console.warn("[options] chain read failed:", symbol, expiry ?? "", err instanceof Error ? err.message : String(err));
        snap = { at, until: Math.min(snapshotFreshUntil(at), at + FAILED_TTL_MS), value: null, failed: true };
      }
      snapshots.delete(key);
      snapshots.set(key, snap);
      if (snapshots.size > SNAPSHOT_CAP) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) snapshots.delete(oldest);
      }
      return snap;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  };

  const one = async (req: ImpliedRequestItem): Promise<ImpliedMove | null> => {
    const nowMs = now();
    const today = nyYmdOf(nowMs);
    if (req.date < today) return null;
    const { reactionDay, coverFrom } = reportCover(req.date, req.time);

    const base = await chain(req.ticker);
    if (!base.value || base.value.expirations.length === 0) return null;
    const picked = pickExpiries(base.value.expirations, coverFrom, today);
    if (!picked) return null;

    const firstSnap = base.value.expiry === picked.first ? base : await chain(req.ticker, picked.first);
    const first = firstSnap.value;
    if (!first || first.expiry !== picked.first) return null;
    const nextSnap = picked.next ? await chain(req.ticker, picked.next) : null;
    const next = nextSnap?.value && nextSnap.value.expiry === picked.next ? nextSnap.value : null;

    const spot = first.spot ?? base.value.spot;
    if (spot === null) return null;
    const quotedAt = Math.min(firstSnap.at, nextSnap?.at ?? firstSnap.at);
    const sessionsToFirst = sessionsThrough(quotedAt, picked.first);
    const figure = impliedFigure({
      spot,
      first: { expiry: picked.first, calls: first.calls, puts: first.puts },
      next: next ? { expiry: picked.next!, calls: next.calls, puts: next.puts } : null,
      sessionsToFirst,
      sessionsToNext: next ? sessionsThrough(quotedAt, picked.next!) : null,
      extraSessions: sessionsAfter(reactionDay, picked.first),
      freshSinceMs: latestOpenMs(quotedAt),
    });
    if (!figure) return null;

    const moves = await deps.reportMoves(req.ticker).catch(() => [] as ReportMove[]);
    return {
      ticker: req.ticker,
      reportDate: req.date,
      reactionDay,
      spot,
      expiry: picked.first,
      nextExpiry: figure.adjusted ? picked.next : null,
      strike: figure.strike,
      straddle: figure.straddle,
      raw: figure.raw,
      move: figure.move,
      adjusted: figure.adjusted,
      sessions: sessionsToFirst,
      basis: figure.basis,
      quotedAt: new Date(quotedAt).toISOString(),
      history: moveHistory(moves, figure.move),
    };
  };

  const safeOne = (req: ImpliedRequestItem): Promise<ImpliedMove | null> =>
    one(req).catch((err) => {
      console.warn("[options] implied move failed:", req.ticker, err instanceof Error ? err.message : String(err));
      return null;
    });

  return {
    one: safeOne,
    async many(reqs: readonly ImpliedRequestItem[]): Promise<Record<string, ImpliedMove | null>> {
      const out: Record<string, ImpliedMove | null> = {};
      let next = 0;
      const worker = async () => {
        while (next < reqs.length) {
          const r = reqs[next++]!;
          out[r.ticker] = await safeOne(r);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, reqs.length)) }, worker));
      return out;
    },
  };
}

export type ImpliedMoveService = ReturnType<typeof createImpliedMoveService>;
