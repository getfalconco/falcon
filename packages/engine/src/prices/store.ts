/**
 * The price store: Supabase public.prices_daily (unadjusted daily OHLCV per
 * ticker and session) and public.prices_splits (detected or hand-entered
 * share splits), migration apps/web/supabase/migrations/20261120_prices_daily.sql.
 * Written by the daily prices job (daily.ts), read by the website's
 * /api/prices and lib/prices-api.ts.
 *
 * The spend ledger is the options jobs' public.options_spend (callers
 * prices-daily@... / prices-backfill@...), reached through
 * options/store.ts SpendLedgerStore.
 */

import pg from "pg";

export type PriceRow = { ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number; source: string };

export type DayBar = { date: string; open: number; high: number; low: number; close: number; volume: number };

export type Split = { ticker: string; date: string; ratio: number; detail: string };

export interface PricesStore {
  /** Rows stored per session date in [from, to] (inclusive). */
  countByDate(from: string, to: string): Promise<Map<string, number>>;
  /** Upserts rows (idempotent on ticker, date). Returns rows written. */
  save(rows: readonly PriceRow[]): Promise<number>;
  /** Stored bars per ticker in [from, to], oldest first (only `tickers` when given). */
  bars(from: string, to: string, tickers?: readonly string[]): Promise<Map<string, DayBar[]>>;
  /** Upserts detected splits; rows entered by hand (source other than 'detected') are kept. Returns rows written. */
  saveSplits(splits: readonly Split[]): Promise<number>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In memory (tests, dry runs)

export function memoryPricesStore(): PricesStore & { rows: Map<string, PriceRow>; splits: Map<string, Split & { source: string }> } {
  const rows = new Map<string, PriceRow>();
  const splits = new Map<string, Split & { source: string }>();
  return {
    rows,
    splits,
    async countByDate(from, to) {
      const out = new Map<string, number>();
      for (const r of rows.values()) if (r.date >= from && r.date <= to) out.set(r.date, (out.get(r.date) ?? 0) + 1);
      return out;
    },
    async save(list) {
      for (const r of list) rows.set(`${r.ticker}|${r.date}`, { ...r });
      return list.length;
    },
    async bars(from, to, tickers) {
      const want = tickers ? new Set(tickers) : null;
      const out = new Map<string, DayBar[]>();
      for (const r of [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
        if (r.date < from || r.date > to || (want && !want.has(r.ticker))) continue;
        if (!out.has(r.ticker)) out.set(r.ticker, []);
        out.get(r.ticker)!.push({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
      }
      return out;
    },
    async saveSplits(list) {
      let n = 0;
      for (const s of list) {
        const k = `${s.ticker}|${s.date}`;
        const prev = splits.get(k);
        if (prev && prev.source !== "detected") continue;
        splits.set(k, { ...s, source: "detected" });
        n++;
      }
      return n;
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// Postgres (Supabase, DATABASE_URL)

function pgClient(databaseUrl: string): pg.Client {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(databaseUrl);
  return new pg.Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
}

export const UPSERT_PRICES_SQL = `insert into public.prices_daily (ticker, date, open, high, low, close, volume, source)
  select * from unnest($1::text[], $2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::int8[], $8::text[])
  on conflict (ticker, date) do update set
    open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
    volume = excluded.volume, source = excluded.source, updated_at = now()`;

export const UPSERT_SPLITS_SQL = `insert into public.prices_splits (ticker, date, ratio, source, detail)
  select t, d, r, 'detected', x from unnest($1::text[], $2::date[], $3::float8[], $4::text[]) as u(t, d, r, x)
  on conflict (ticker, date) do update set ratio = excluded.ratio, detail = excluded.detail, updated_at = now()
  where public.prices_splits.source = 'detected'`;

/** Rows a single insert carries (parameters stay a few MB). */
const SAVE_CHUNK = 20_000;

export function pgPricesStore(databaseUrl: string): PricesStore {
  let db: pg.Client | null = null;
  const conn = async (): Promise<pg.Client> => {
    if (db) return db;
    const c = pgClient(databaseUrl);
    await c.connect();
    db = c;
    return c;
  };
  return {
    async countByDate(from, to) {
      const c = await conn();
      const res = await c.query<{ d: string; n: string }>(
        "select date::text as d, count(*)::text as n from public.prices_daily where date >= $1::date and date <= $2::date group by date",
        [from, to],
      );
      return new Map(res.rows.map((r) => [r.d, Number(r.n)]));
    },
    async save(list) {
      if (!list.length) return 0;
      const c = await conn();
      let n = 0;
      for (let i = 0; i < list.length; i += SAVE_CHUNK) {
        const part = list.slice(i, i + SAVE_CHUNK);
        const res = await c.query(UPSERT_PRICES_SQL, [
          part.map((r) => r.ticker),
          part.map((r) => r.date),
          part.map((r) => r.open),
          part.map((r) => r.high),
          part.map((r) => r.low),
          part.map((r) => r.close),
          part.map((r) => Math.round(r.volume)),
          part.map((r) => r.source),
        ]);
        n += res.rowCount ?? part.length;
      }
      return n;
    },
    async bars(from, to, tickers) {
      const c = await conn();
      // date as text: node-pg would turn a date into a local-midnight Date.
      const res = await c.query<{ ticker: string; d: string; open: number; high: number; low: number; close: number; volume: string }>(
        `select ticker, date::text as d, open, high, low, close, volume::text as volume from public.prices_daily
          where date >= $1::date and date <= $2::date ${tickers ? "and ticker = any($3::text[])" : ""}
          order by ticker, date`,
        tickers ? [from, to, [...tickers]] : [from, to],
      );
      const out = new Map<string, DayBar[]>();
      for (const r of res.rows) {
        if (!out.has(r.ticker)) out.set(r.ticker, []);
        out.get(r.ticker)!.push({ date: r.d, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) });
      }
      return out;
    },
    async saveSplits(list) {
      if (!list.length) return 0;
      const c = await conn();
      const res = await c.query(UPSERT_SPLITS_SQL, [list.map((s) => s.ticker), list.map((s) => s.date), list.map((s) => s.ratio), list.map((s) => s.detail.slice(0, 300))]);
      return res.rowCount ?? 0;
    },
    async close() {
      const c = db;
      db = null;
      if (c) await c.end().catch(() => undefined);
    },
  };
}
