/**
 * The options store: one row per ticker and session in Supabase
 * public.options_daily (migration apps/web/supabase/migrations/
 * 20261119_options_daily.sql), written by the daily universe job and by the
 * Sightings run, read by both (a chain is bought once a session) and by the
 * website's /api/options.
 *
 *   options_daily (ticker, as_of date, metrics jsonb, skip text, source, created_at)
 *
 * `metrics` (StoredMetrics, below) holds the card block without a hit's
 * history comparison (`block`, @falcon/ripple RippleOptions, with `ivPct`),
 * the numbers cards.ts needs to rebuild the block for any window (`raw`,
 * the term structure trimmed), and the IV percentile against the ticker's
 * own stored days. A row with `skip` set records why a chain was unusable
 * that session (no options listed, no quotes, poor chain), so it is not
 * bought again; it is never served. Its metrics are null, or on the session
 * before an earnings reaction only `{ earnings_straddle }` (SkipMetrics: a
 * chain too thin for the card block can still have the nearest-strike
 * straddle the scoreboard reads).
 *
 * Also the persistent spend ledger of the daily job, public.options_spend:
 * one row per Databento charge or refund line (the file ledger's lines,
 * cost.ts), so the monthly cap survives lost caches and fresh runners.
 */

import pg from "pg";
import type { RippleOptions } from "@falcon/ripple";
import { optionsBlock, type TickerOptions } from "./cards.ts";
import type { KnownEntry } from "./chains.ts";
import type { EarningsStraddle } from "./earnings-straddle.ts";
import type { SpendEntry } from "./cost.ts";

/** Stored days needed before an IV percentile is given. */
export const MIN_IV_DAYS = 20;
/** Calendar days of history kept (and read for the percentile). */
export const KEEP_DAYS = 92;
/** Term points kept: every expiry up to this many days, plus the first one past it (covers any window up to 60 sessions). */
export const TERM_KEEP_DAYS = 120;

export type StoredRaw = {
  asOf: string;
  spot: number;
  spotSource: TickerOptions["spotSource"];
  /** ATM IV 30 days, fraction. */
  iv: number;
  skew: number | null;
  cp: number | null;
  beta: number | null;
  vix: number | null;
  /** [expiration, days, ATM IV fraction]. */
  term: Array<[string, number, number]>;
};

export type StoredMetrics = {
  v: 1;
  block: RippleOptions;
  raw: StoredRaw;
  /** Percentile (0-100) of today's ATM IV among this ticker's stored days; null under MIN_IV_DAYS days. */
  ivPct: number | null;
  /** Stored days the percentile was taken over. */
  ivDays: number;
  /** On the session before an earnings reaction only: the ATM straddle (earnings-straddle.ts; study/scoreboard.ts reads it). */
  earnings_straddle?: EarningsStraddle;
};

/** The metrics of a skip row: only the pre-earnings straddle, when the thin chain had one. */
export type SkipMetrics = { earnings_straddle: EarningsStraddle };

/** A stored row back as a known entry: a record, or a skip (with its straddle when it kept one). Pure. */
export function knownFromRow(ticker: string, date: string, metrics: StoredMetrics | SkipMetrics | null, skip: string | null): KnownEntry {
  if (skip !== null || !metrics || !("raw" in metrics) || !metrics.raw) {
    const st = metrics?.earnings_straddle;
    return st ? { skip: skip ?? "unusable", earningsStraddle: st } : { skip: skip ?? "unusable" };
  }
  return fromMetrics(ticker, date, metrics);
}

/** What a skip entry stores in metrics: its straddle, or nothing. Pure. */
export function skipMetrics(e: { skip: string; earningsStraddle?: EarningsStraddle }): SkipMetrics | null {
  return e.earningsStraddle ? { earnings_straddle: e.earningsStraddle } : null;
}

const r4 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/** Expiries up to TERM_KEEP_DAYS, plus the first one past it. Pure. */
export function trimTerm<T extends { days: number }>(term: readonly T[]): T[] {
  const out: T[] = [];
  for (const p of term) {
    out.push(p);
    if (p.days > TERM_KEEP_DAYS) break;
  }
  return out;
}

/**
 * Percentile rank (0-100, rounded) of `x` among `history` (ties count half);
 * null with fewer than MIN_IV_DAYS values. Pure.
 */
export function ivPercentile(history: readonly number[], x: number): number | null {
  const h = history.filter((v) => Number.isFinite(v) && v > 0);
  if (h.length < MIN_IV_DAYS || !Number.isFinite(x)) return null;
  let below = 0;
  let equal = 0;
  for (const v of h) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return Math.round((100 * (below + equal / 2)) / h.length);
}

/** The stored metrics of a record, with its IV percentile against `ivHistory` (earlier sessions' ATM IV, fractions). Pure. */
export function toMetrics(t: TickerOptions, ivHistory: readonly number[] = []): StoredMetrics {
  const ivPct = ivPercentile(ivHistory, t.atmIv30);
  const block = optionsBlock(t);
  if (ivPct !== null) block.ivPct = ivPct;
  return {
    v: 1,
    block,
    raw: {
      asOf: t.asOf,
      spot: Math.round(t.spot * 1e4) / 1e4,
      spotSource: t.spotSource,
      iv: r4(t.atmIv30)!,
      skew: r4(t.skew),
      cp: r4(t.cpSpread),
      beta: r4(t.beta),
      vix: r4(t.vix),
      term: trimTerm(t.term).map((p) => [p.expiration, p.days, p.iv]),
    },
    ivPct,
    ivDays: ivHistory.length,
    ...(t.earningsStraddle ? { earnings_straddle: t.earningsStraddle } : {}),
  };
}

/** The record back from a stored row (what cards.ts builds blocks from). Pure. */
export function fromMetrics(ticker: string, date: string, m: StoredMetrics): TickerOptions {
  const r = m.raw;
  return {
    ticker,
    date,
    asOf: r.asOf,
    spot: r.spot,
    spotSource: r.spotSource,
    atmIv30: r.iv,
    skew: r.skew,
    cpSpread: r.cp,
    beta: r.beta,
    vix: r.vix,
    term: r.term.map(([expiration, days, iv]) => ({ expiration, days, iv })),
    ...(m.ivPct !== null && m.ivPct !== undefined ? { ivPct: m.ivPct } : {}),
    ...(m.earnings_straddle ? { earningsStraddle: m.earnings_straddle } : {}),
  };
}

export interface OptionsStore {
  /** What is stored for these tickers at the session `date` (records and skips). */
  known(date: string, tickers: readonly string[]): Promise<Map<string, KnownEntry>>;
  /** Upserts records and skips for `date`; records get their IV percentile from the stored history. Returns rows written. */
  save(date: string, entries: ReadonlyMap<string, KnownEntry>, source: string): Promise<number>;
  /** Deletes rows older than `keepDays` before `date`. Returns rows deleted. */
  prune(date: string, keepDays?: number): Promise<number>;
  close(): Promise<void>;
}

/** The persistent spend ledger (options_spend). */
export interface SpendLedgerStore {
  /** Sum of charges and refunds of callers starting with `prefix` in the UTC month of `nowMs`. */
  monthSpend(prefix: string, nowMs: number): Promise<number>;
  /** Appends ledger lines (idempotent: a line already there is skipped). Returns lines added. */
  append(entries: readonly SpendEntry[]): Promise<number>;
}

/** First instant of the UTC month of `nowMs` and of the next one. Pure. */
export function monthBounds(nowMs: number): { start: string; end: string } {
  const d = new Date(nowMs);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// ---------------------------------------------------------------------------
// In memory (tests, dry runs)

export function memoryOptionsStore(): OptionsStore & SpendLedgerStore & { rows: Map<string, { metrics: StoredMetrics | SkipMetrics | null; skip: string | null; source: string }>; spend: SpendEntry[] } {
  const rows = new Map<string, { metrics: StoredMetrics | SkipMetrics | null; skip: string | null; source: string }>();
  const spend: SpendEntry[] = [];
  const key = (t: string, d: string) => `${t}|${d}`;
  return {
    rows,
    spend,
    async known(date, tickers) {
      const out = new Map<string, KnownEntry>();
      for (const t of tickers) {
        const r = rows.get(key(t, date));
        if (!r) continue;
        out.set(t, knownFromRow(t, date, r.metrics, r.skip));
      }
      return out;
    },
    async save(date, entries, source) {
      let n = 0;
      for (const [t, e] of entries) {
        if ("skip" in e) rows.set(key(t, date), { metrics: skipMetrics(e), skip: e.skip, source });
        else {
          const hist = [...rows.entries()]
            .filter(([k, r]) => k.startsWith(`${t}|`) && k.split("|")[1]! < date && r.skip === null && r.metrics && "raw" in r.metrics)
            .map(([, r]) => (r.metrics as StoredMetrics).raw.iv);
          rows.set(key(t, date), { metrics: toMetrics(e, hist), skip: null, source });
        }
        n++;
      }
      return n;
    },
    async prune(date, keepDays = KEEP_DAYS) {
      const cutoff = new Date(Date.parse(`${date}T00:00:00Z`) - keepDays * 86_400_000).toISOString().slice(0, 10);
      let n = 0;
      for (const k of [...rows.keys()]) {
        if (k.split("|")[1]! < cutoff) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },
    async close() {},
    async monthSpend(prefix, nowMs) {
      const { start, end } = monthBounds(nowMs);
      return spend.filter((e) => e.caller.startsWith(prefix) && e.at >= start && e.at < end).reduce((s, e) => s + e.costUsd, 0);
    },
    async append(entries) {
      let n = 0;
      for (const e of entries) {
        if (spend.some((x) => x.caller === e.caller && x.key === e.key && x.kind === e.kind && x.at === e.at)) continue;
        spend.push(e);
        n++;
      }
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres (Supabase, DATABASE_URL)

function pgClient(databaseUrl: string): pg.Client {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(databaseUrl);
  return new pg.Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
}

export const UPSERT_OPTIONS_SQL = `insert into public.options_daily (ticker, as_of, metrics, skip, source)
  select * from unnest($1::text[], $2::date[], $3::jsonb[], $4::text[], $5::text[])
  on conflict (ticker, as_of) do update set
    metrics = excluded.metrics, skip = excluded.skip, source = excluded.source, updated_at = now()`;

/**
 * What the scoreboard needs priced every session (daily.ts coverageTickers):
 * ripple_forecasts rows young enough for an open window (63 sessions at most,
 * so the last 100 days) and the tickers of Sightings cards not marked stale.
 * Read-only.
 */
export async function readCoverage(databaseUrl: string, nowMs: number): Promise<{ forecasts: Array<{ created_at: string; ticker: string; window_days: number }>; cardTickers: string[] }> {
  const c = pgClient(databaseUrl);
  await c.connect();
  try {
    const since = new Date(nowMs - 100 * 86_400_000).toISOString();
    const f = await c.query<{ created_at: Date; ticker: string; window_days: number }>("select created_at, ticker, window_days from public.ripple_forecasts where created_at >= $1", [since]);
    const k = await c.query<{ t: string }>("select distinct unnest(tickers) as t from public.sightings_cards where not stale");
    return { forecasts: f.rows.map((r) => ({ created_at: new Date(r.created_at).toISOString(), ticker: r.ticker, window_days: Number(r.window_days) })), cardTickers: k.rows.map((r) => r.t) };
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** The store and the spend ledger on one Postgres connection (opened on first use). */
export function pgOptionsStore(databaseUrl: string): OptionsStore & SpendLedgerStore {
  let db: pg.Client | null = null;
  let opening: Promise<pg.Client> | null = null;
  // One connection however many callers ask at once (parallel batches store concurrently).
  const conn = (): Promise<pg.Client> => {
    if (db) return Promise.resolve(db);
    opening ??= (async () => {
      const c = pgClient(databaseUrl);
      try {
        await c.connect();
      } catch (err) {
        opening = null;
        throw err;
      }
      db = c;
      return c;
    })();
    return opening;
  };
  return {
    async known(date, tickers) {
      const out = new Map<string, KnownEntry>();
      if (!tickers.length) return out;
      const c = await conn();
      const res = await c.query<{ ticker: string; metrics: StoredMetrics | SkipMetrics | null; skip: string | null }>(
        "select ticker, metrics, skip from public.options_daily where as_of = $1 and ticker = any($2::text[])",
        [date, [...tickers]],
      );
      for (const r of res.rows) {
        out.set(r.ticker, knownFromRow(r.ticker, date, r.metrics, r.skip));
      }
      return out;
    },
    async save(date, entries, source) {
      if (!entries.size) return 0;
      const c = await conn();
      const records = [...entries].filter(([, e]) => !("skip" in e)).map(([t]) => t);
      const hist = new Map<string, number[]>();
      if (records.length) {
        const res = await c.query<{ ticker: string; iv: number | null }>(
          `select ticker, (metrics->'raw'->>'iv')::float8 as iv from public.options_daily
            where ticker = any($1::text[]) and as_of < $2::date and as_of >= $2::date - $3::int and skip is null`,
          [records, date, KEEP_DAYS],
        );
        for (const r of res.rows) if (r.iv !== null) hist.set(r.ticker, [...(hist.get(r.ticker) ?? []), Number(r.iv)]);
      }
      const t: string[] = [];
      const d: string[] = [];
      const m: Array<string | null> = [];
      const s: Array<string | null> = [];
      const src: string[] = [];
      for (const [ticker, e] of entries) {
        t.push(ticker);
        d.push(date);
        if ("skip" in e) {
          const sm = skipMetrics(e);
          m.push(sm ? JSON.stringify(sm) : null);
          s.push(e.skip.slice(0, 300));
        } else {
          m.push(JSON.stringify(toMetrics(e, hist.get(ticker) ?? [])));
          s.push(null);
        }
        src.push(source);
      }
      const res = await c.query(UPSERT_OPTIONS_SQL, [t, d, m, s, src]);
      return res.rowCount ?? t.length;
    },
    async prune(date, keepDays = KEEP_DAYS) {
      const c = await conn();
      const res = await c.query("delete from public.options_daily where as_of < $1::date - $2::int", [date, keepDays]);
      return res.rowCount ?? 0;
    },
    async close() {
      const c = db ?? (opening ? await opening.catch(() => null) : null);
      db = null;
      opening = null;
      if (c) await c.end().catch(() => undefined);
    },
    async monthSpend(prefix, nowMs) {
      const c = await conn();
      const { start, end } = monthBounds(nowMs);
      const res = await c.query<{ s: string | null }>(
        "select coalesce(sum(cost_usd), 0)::text as s from public.options_spend where starts_with(caller, $1) and at >= $2 and at < $3",
        [prefix, start, end],
      );
      return Number(res.rows[0]?.s ?? 0);
    },
    async append(entries) {
      if (!entries.length) return 0;
      const c = await conn();
      const res = await c.query(
        `insert into public.options_spend (at, caller, kind, dataset, schema, symbols, start_at, end_at, cost_usd, key, note)
         select * from unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::float8[], $10::text[], $11::text[])
         on conflict (caller, key, kind, at) do nothing`,
        [
          entries.map((e) => e.at),
          entries.map((e) => e.caller),
          entries.map((e) => e.kind),
          entries.map((e) => e.dataset),
          entries.map((e) => e.schema),
          entries.map((e) => e.symbols.count),
          entries.map((e) => e.start),
          entries.map((e) => e.end),
          entries.map((e) => e.costUsd),
          entries.map((e) => e.key),
          entries.map((e) => e.note ?? null),
        ],
      );
      return res.rowCount ?? 0;
    },
  };
}
