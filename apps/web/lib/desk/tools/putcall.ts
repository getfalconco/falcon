/**
 * Put/call volume and open interest of one underlying's options for
 * falcon_options' summary (iv.ts buys them; this file is pure).
 *
 * Sources (OPRA.PILLAR, parent symbology, priced with get_cost first; measured
 * 2026-11-16 for the 2026-11-13 session):
 *   - Open interest: `statistics` stat_type 9 before a session's open (OPRA
 *     broadcasts it at 06:30:00-06:30:05 New York, one identical record per
 *     exchange): the positions after the previous session's close. SOUN
 *     $0.005, AAPL $0.043, SPY $0.163. Read from a 90-second window around
 *     06:30 (the same price; Databento serves it in ~2.5 s where the whole
 *     pre-open window takes over a minute), the whole pre-open when that
 *     window is empty.
 *   - Volume: `ohlcv-1d` of one session (one bar per contract per exchange,
 *     summed). SOUN $0.035, AAPL $0.345, SPY $1.25. The cheaper end-of-day
 *     `statistics` cleared volume (stat_type 6) is not used: only 12 of the 20
 *     OPRA exchanges send it (SOUN 2026-11-13: 13,952 of 25,847 contracts).
 *     `trades` is dearer still (SPY $24).
 * Request ohlcv-1d one day at a time (a multi-day request is priced far higher).
 */

import { osiRoot, parseOsi } from "../../../../../packages/engine/src/options/study-options.ts";
import { addDays, nyInstantMs, nyseSessions } from "../../../../../packages/engine/src/study/abnormal.ts";
import { num, tsMs, type RangeRequest } from "../../databento/client";
import { round } from "./util";

export const PC_DATASET = "OPRA.PILLAR";
export const OI_SCHEMA = "statistics";
export const VOLUME_SCHEMA = "ohlcv-1d";
/** Databento StatType for open interest. */
export const STAT_OPEN_INTEREST = 9;
/** The open-interest window, [06:29:30, 06:31:00) New York (minutes; the start has 30 s added). */
const OI_FROM_MIN = 6 * 60 + 29;
const OI_TO_MIN = 6 * 60 + 31;
/** Contracts listed in `largest`. */
export const TOP_OI = 3;

export const PUT_CALL_MEANING =
  "Put/call ratio = put contracts / call contracts (volume of one session; open interest = positions still open). A high ratio often reflects hedging of stock holdings or income strategies, not necessarily a bearish bet; a low one is not necessarily bullish. Compare it with the name's usual level rather than reading it alone.";

export type Right = "C" | "P";
export type PcRow = { expiration: string; strike: number; right: Right; n: number };

/* ------------------------------------------------------------------ plan */

export type PcPlan = {
  key: string;
  /** Open interest published before `date`'s open: positions after `after`'s close (`req` around 06:30, `wide` midnight to the open). */
  oi: { req: RangeRequest; wide: RangeRequest | null; date: string; after: string } | null;
  /** Volume of one whole session. */
  volume: { req: RangeRequest; session: string } | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Which open interest and volume to read at `nowMs`: the latest session whose
 * 06:30 New York open-interest broadcast Databento has, and the latest whole
 * session with an ohlcv-1d bar. `statsEndMs` / `ohlcvEndMs` are
 * the schemas' available ends (null when unknown: then the clock decides). Pure.
 */
export function putCallPlan(t: string, nowMs: number, statsEndMs: number | null, ohlcvEndMs: number | null): PcPlan {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const sessions = nyseSessions(addDays(today, -14), today);
  const symbols = [`${osiRoot(t)}.OPT`];
  const base = { dataset: PC_DATASET, symbols, stype_in: "parent" as const };
  let oi: PcPlan["oi"] = null;
  const statsCap = Math.min(nowMs, statsEndMs ?? Number.POSITIVE_INFINITY);
  for (let i = sessions.length - 1; i >= 1 && !oi; i--) {
    const d = sessions[i]!;
    const end = nyInstantMs(d, OI_TO_MIN);
    const open = nyInstantMs(d, 9 * 60 + 30);
    if (end <= statsCap)
      oi = {
        req: { ...base, schema: OI_SCHEMA, start: iso(nyInstantMs(d, OI_FROM_MIN) + 30_000), end: iso(end) },
        wide: open <= statsCap ? { ...base, schema: OI_SCHEMA, start: iso(nyInstantMs(d, 0)), end: iso(open) } : null,
        date: d,
        after: sessions[i - 1]!,
      };
  }
  let volume: PcPlan["volume"] = null;
  for (let i = sessions.length - 1; i >= 0 && !volume; i--) {
    const d = sessions[i]!;
    const next = addDays(d, 1);
    // A day's bar is whole once Databento's range passes it; with no range, the next morning (12:00 UTC).
    const ok = ohlcvEndMs !== null ? Date.parse(`${next}T00:00:00Z`) <= Math.min(ohlcvEndMs, nowMs) : Date.parse(`${next}T12:00:00Z`) <= nowMs;
    if (ok) volume = { req: { ...base, schema: VOLUME_SCHEMA, start: d, end: next }, session: d };
  }
  return { key: `${t}|oi:${oi?.date ?? "-"}|vol:${volume?.session ?? "-"}`, oi, volume };
}

/* ------------------------------------------------------------------ parsing */

type Rec = Record<string, unknown>;
const hdOf = (r: Rec) => ((r.hd as Rec | undefined) ?? r) as Rec;

/** The standard contract a record is about (adjusted roots such as "AAPL1" are left out, as the IV chain does). */
function contractOf(r: Rec, root: string): { expiration: string; strike: number; right: Right } | null {
  const p = parseOsi(String(r.symbol ?? ""));
  if (!p || p.root !== root) return null;
  return { expiration: p.expiration, strike: p.strike, right: p.right };
}

/**
 * Open interest per contract from statistics records: stat_type 9, `quantity`.
 * OPRA repeats it once per exchange; the latest record per instrument wins
 * (engine client.ts parseOpenInterest). Pure.
 */
export function oiFromStatistics(records: ReadonlyArray<Rec>, t: string): PcRow[] {
  const root = osiRoot(t);
  const best = new Map<number, { ts: number; row: PcRow }>();
  for (const r of records) {
    if (Number(r.stat_type) !== STAT_OPEN_INTEREST) continue;
    const q = num(r.quantity);
    if (q === null || q < 0 || q > 2_000_000_000) continue;
    const c = contractOf(r, root);
    const id = Number(hdOf(r).instrument_id);
    if (!c || !Number.isFinite(id)) continue;
    const ts = tsMs(r.ts_recv) ?? tsMs(hdOf(r).ts_event) ?? 0;
    const prev = best.get(id);
    if (!prev || ts >= prev.ts) best.set(id, { ts, row: { ...c, n: q } });
  }
  return [...best.values()].map((b) => b.row);
}

/** Session volume per contract from ohlcv-1d records: one bar per exchange, summed. Pure. */
export function volumeFromOhlcv(records: ReadonlyArray<Rec>, t: string): PcRow[] {
  const root = osiRoot(t);
  const by = new Map<number, PcRow>();
  for (const r of records) {
    const v = num(r.volume);
    if (v === null || v < 0) continue;
    const c = contractOf(r, root);
    const id = Number(hdOf(r).instrument_id);
    if (!c || !Number.isFinite(id)) continue;
    const prev = by.get(id);
    if (prev) prev.n += v;
    else by.set(id, { ...c, n: v });
  }
  return [...by.values()];
}

/* ------------------------------------------------------------------ figures */

export type PcTotals = { calls: number; puts: number; ratio: number | null };

/** Call and put totals and puts / calls (2 decimals; null with no calls). Pure. */
export function putCallTotals(rows: readonly PcRow[]): PcTotals {
  let calls = 0;
  let puts = 0;
  for (const r of rows) {
    if (r.right === "C") calls += r.n;
    else puts += r.n;
  }
  return { calls, puts, ratio: calls > 0 ? round(puts / calls, 2) : null };
}

/** The `n` contracts with the most open interest as [expiration, strike, C/P, contracts]. Pure. */
export function largestOi(rows: readonly PcRow[], n = TOP_OI): Array<[string, number, Right, number]> {
  return [...rows]
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.expiration.localeCompare(b.expiration) || a.strike - b.strike)
    .slice(0, n)
    .map((r) => [r.expiration, r.strike, r.right, r.n]);
}

/* ------------------------------------------------------------------ result */

export type PutCall = {
  oi: (PcTotals & { date: string; after: string; largest: Array<[string, number, Right, number]> }) | null;
  volume: (PcTotals & { session: string }) | null;
  /** USD bought for this answer (0 when every piece was already bought). */
  costUsd: number;
  notes: string[];
};

/** A piece's figures. Pure. */
export function oiFigures(rows: readonly PcRow[], date: string, after: string): NonNullable<PutCall["oi"]> {
  return { ...putCallTotals(rows), date, after, largest: largestOi(rows) };
}

/** The summary's `putCall` block. Pure. */
export function shapePutCall(pc: PutCall) {
  if (!pc.oi && !pc.volume) return { volume: null, openInterest: null, notes: pc.notes };
  return {
    ...(pc.volume ? { volume: { session: pc.volume.session, calls: pc.volume.calls, puts: pc.volume.puts, ratio: pc.volume.ratio } } : { volume: null }),
    ...(pc.oi
      ? {
          openInterest: {
            asOf: `${pc.oi.date} pre-open (positions after the ${pc.oi.after} close)`,
            calls: pc.oi.calls,
            puts: pc.oi.puts,
            ratio: pc.oi.ratio,
            largest: pc.oi.largest,
            largestColumns: ["expiration", "strike", "C/P", "contracts"],
          },
        }
      : { openInterest: null }),
    data: pc.costUsd === 0 ? "on demand (already bought, free)" : `on demand, $${pc.costUsd.toFixed(4)}`,
    meaning: PUT_CALL_MEANING,
    ...(pc.notes.length ? { notes: pc.notes } : {}),
  };
}
