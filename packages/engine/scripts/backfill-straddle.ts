/**
 * node --import tsx scripts/backfill-straddle.ts [--scope cards|all] [--last 8] [--since YYYY-MM-DD]
 *        [--price-only] [--cap 2] [--concurrency 8] [--out FILE] [--reuse FILE] [--write]
 *
 * Pre-earnings straddles for past releases in public.historical_events, bought
 * with the near-the-money on-demand method (apps/web lib/desk/tools/
 * iv-history.ts): one OPRA.PILLAR cbbo-1m snapshot at 15:45 New York (12:45 on
 * early closes; window [minute - 5, minute + 1)) of the session before the
 * reaction day (historical_events.event_date), of just the contracts that can
 * make the straddle, asked for by OSI symbol (stype_in raw_symbol): strikes on
 * a grid around that session's close (Yahoo, splits undone) for every weekday
 * from the reaction day to the Friday on or after it and the first monthly
 * expiry on or after it. Symbols never listed cost nothing. Then, with the
 * daily job's math (chains.ts computeOne): the put-call parity spot when
 * within 3% of the close, and earnings-straddle.ts: (call_mid + put_mid) /
 * spot at the strike nearest spot, first listed expiry on or after the
 * reaction day.
 *
 * Events: per ticker its `--last` (default 8) most recent releases; with
 * event_kind filled, only event_kind = 'earnings'; before that, every 8-K
 * (not 8-K/A) since `--since` (cards scope: the tickers of every stored
 * Sightings card).
 *
 * Spend: requests grouped by snapshot session (at most 2000 symbols each),
 * every one priced first with the free get_cost; nothing is bought unless the
 * total fits `--cap` (USD, default 2). Each purchase is recorded in
 * public.options_spend (caller "backfill-straddle@<run>") before its download;
 * a failed download gets a refund line. Bodies stay in the engine's Databento
 * file cache, so a rerun of the same requests is free; `--reuse FILE` (an
 * earlier run's --out) takes those events' results instead of buying them again.
 *
 * --write: the straddles become forecast_matchups rows (kind 'earnings',
 * method 'earnings_straddle'), scored on the reaction day's move beyond the
 * sector ETF (abnormal_return_d0; units 'abnormal'): Falcon's side the trailing
 * mean |abnormal d0| over the company's 4 to 8 earlier releases, the market's
 * the straddle; the raw d0 move is stored too (ratio and straddle P&L use it). Needs event_kind and stock_return_d0 filled (another job
 * writes them); refuses otherwise. Never writes historical_events.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../src/env.ts";
import { HOUR_MS, plainGet } from "../src/http.ts";
import { DatabentoClient, quotesAt } from "../src/options/client.ts";
import { requestKey, type RangeRequest, type SpendEntry } from "../src/options/cost.ts";
import { mapPool, snapshotMinute } from "../src/options/chains.ts";
import { earningsStraddle, releaseSessions, timeOfDayAt, type EarningsRelease, type EarningsStraddle } from "../src/options/earnings-straddle.ts";
import { discountToContinuous, dividendYieldOn, fetchDividends, type DividendHistory } from "../src/options/rates.ts";
import { pgOptionsStore } from "../src/options/store.ts";
import { definitionsFromRecords, osiRoot, recordsByRoot } from "../src/options/study-options.ts";
import { surfaceFeatures } from "../src/options/surface.ts";
import { addDays, isNyseSession, nyInstantMs } from "../src/study/abnormal.ts";
import { prevSession } from "../src/study/earnings-events.ts";
import { parseChart } from "../src/study/forward.ts";
import { buildEarningsMatchup, lastClosedSession } from "../src/study/scoreboard.ts";
import { creationRow, insertMatchups, outcomeRow, resolveMatchups } from "../src/study/scoreboard-store.ts";

const DATASET = "OPRA.PILLAR";
const SCHEMA = "cbbo-1m";
const LOOKBACK = 5;
const MAX_SYMBOLS = 2000;
const SOURCE = "OPRA.PILLAR cbbo-1m via Databento (backfill: near-the-money contracts by OSI symbol)";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const scrub = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");

/* ------------------------------------------------------------------ the request (pure) */

/** Strike grid around a close: a step every listed grid is a multiple of, and a band wide enough to hold a strike of the coarsest grid. Pure. */
export function straddleStrikes(close: number): number[] {
  const [step, hw] = close < 25 ? [0.5, Math.max(0.04 * close, 1.1)] : close < 200 ? [0.5, Math.max(0.03 * close, 2.6)] : close < 1000 ? [2.5, Math.max(0.03 * close, 5.1)] : [5, Math.max(0.03 * close, 10.1)];
  const out: number[] = [];
  for (let k = Math.ceil((close - hw) / step) * step; k <= close + hw + 1e-9; k += step) if (k > 0) out.push(Math.round(k * 1000) / 1000);
  return out;
}

const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();

/** Third Friday of the month of `d` (Thursday when that Friday is not a session). Pure. */
function monthly(d: string): string {
  const first = `${d.slice(0, 7)}-01`;
  const f = addDays(first, ((5 - weekday(first) + 7) % 7) + 14);
  return isNyseSession(f) ? f : addDays(f, -1);
}

/** Candidate expiries for a reaction session: every weekday to the Friday on or after it, and the first monthly on or after it. Pure. */
export function straddleExpiries(react: string): string[] {
  const out = new Set<string>();
  const toFri = (5 - weekday(react) + 7) % 7;
  for (let i = 0; i <= toFri; i++) {
    const d = addDays(react, i);
    if (weekday(d) >= 1 && weekday(d) <= 5) out.add(d);
  }
  let m = monthly(react);
  if (m < react) {
    const next = new Date(`${react.slice(0, 7)}-01T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    m = monthly(next.toISOString().slice(0, 10));
  }
  out.add(m);
  return [...out].sort();
}

/** OSI symbol: root padded to 6, yymmdd, C/P, strike x 1000 in 8 digits. Pure. */
export function osiSymbol(root: string, expiration: string, right: "C" | "P", strike: number): string {
  return `${root.padEnd(6, " ")}${expiration.slice(2, 4)}${expiration.slice(5, 7)}${expiration.slice(8, 10)}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/* ------------------------------------------------------------------ inputs */

type Ev = { id: string; ticker: string; event_date: string; filed_at: string; accession: string; sector_etf: string | null; event_kind: string | null; d0: number | null; etf_d0: number | null; abn_d0: number | null; price_source: string | null };
type Px = { close: Map<string, number>; splits: Array<{ date: string; ratio: number }> };

async function yahoo(ticker: string, from: string, to: string): Promise<Px | null> {
  const sym = ticker.replace(/\./g, "-");
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${addDays(to, 2)}T00:00:00Z`) / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`;
  try {
    const b = parseChart(JSON.parse(await plainGet(url, { maxAgeMs: 24 * HOUR_MS, staleOk: true })));
    return b ? { close: new Map(b.dates.map((d, i) => [d, b.close[i]!])), splits: b.splits } : null;
  } catch {
    return null;
  }
}

/** Yahoo's close is split-adjusted: undo every later split (strikes are in the prices of the day). */
function closeAsTraded(px: Px, date: string): number | null {
  const c = px.close.get(date);
  if (!(typeof c === "number" && c > 0)) return null;
  let f = 1;
  for (const s of px.splits) if (s.date > date) f *= s.ratio;
  return c * f;
}

/** The release as historical_events dates it: its acceptance instant, kept when it lands on the same reaction session. */
function releaseOf(e: Ev): EarningsRelease {
  const ms = Date.parse(e.filed_at);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const r: EarningsRelease = { date, time: timeOfDayAt(date, Number(get("hour")) * 60 + Number(get("minute"))) };
  const s = releaseSessions(r);
  return s.reactLatest === e.event_date && s.reactEarliest === e.event_date ? r : { date: e.event_date, time: "before_open" };
}

type Item = { ev: Ev; release: EarningsRelease; snap: string; close: number; symbols: string[] };
type Chunk = { snap: string; items: Item[]; req: RangeRequest; priced: number | null; cached: boolean; err?: string };
type Result = { key: string; ticker: string; event_date: string; accession: string; snap: string; straddle: EarningsStraddle | null; why?: string };

async function main(): Promise<number> {
  const url = env("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is not set");
  const scope = arg("scope") ?? "cards";
  const last = Number(arg("last") ?? 8);
  const since = arg("since") ?? "2024-05-01";
  const cap = Number(arg("cap") ?? 2);
  const priceOnly = flag("price-only");
  const conc = Number(arg("concurrency") ?? 8);
  const out = arg("out");
  const nowMs = Date.now();
  const lastClosed = lastClosedSession(nowMs);

  const db = new pg.Client({ connectionString: url, ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const ledger = pgOptionsStore(url);
  try {
    const kinds = Number((await db.query(`select count(*) as n from public.historical_events where event_kind is not null`)).rows[0].n);
    const d0s = Number((await db.query(`select count(*) as n from public.historical_events where stock_return_d0 is not null`)).rows[0].n);
    const tickers =
      scope === "cards"
        ? ((await db.query(`select distinct unnest(tickers) as t from public.sightings_cards`)).rows as Array<{ t: string }>).map((r) => r.t)
        : scope === "all"
          ? null
          : scope.split(",").map((t) => t.trim().toUpperCase());
    const evq = `select id::text, ticker, event_date::text, filed_at, accession, sector_etf, event_kind, stock_return_d0 as d0, etf_return_d0 as etf_d0, abnormal_return_d0 as abn_d0, price_source
      from public.historical_events
      where ${kinds ? "event_kind = 'earnings'" : "form = '8-K' and event_date >= $2"} and event_date <= $1 ${tickers ? `and ticker = any($${kinds ? 2 : 3}::text[])` : ""}
      order by ticker, event_date desc`;
    const params: unknown[] = [lastClosed];
    if (!kinds) params.push(since);
    if (tickers) params.push(tickers);
    const all = (await db.query(evq, params)).rows.map((r) => ({ ...r, filed_at: new Date(r.filed_at).toISOString() })) as Ev[];
    // Per ticker its `last` most recent (with event_kind) or everything since `since` (before it).
    const per = new Map<string, Ev[]>();
    for (const e of all) per.set(e.ticker, [...(per.get(e.ticker) ?? []), e]);
    let events = [...per.values()].flatMap((es) => (kinds ? es.slice(0, last) : es));
    // An earlier run's results (its --out): bought already, not asked again.
    const reused: Result[] = [];
    const reuse = arg("reuse");
    if (reuse) {
      const prior = new Map((JSON.parse(fs.readFileSync(reuse, "utf8")).results as Result[]).filter((r) => r.straddle || /no options listed|no quotes/.test(r.why ?? "")).map((r) => [r.key, r]));
      events = events.filter((e) => {
        const r = prior.get(`earn:${e.ticker}:${e.event_date}`);
        if (r) reused.push(r);
        return !r;
      });
      console.log(`backfill-straddle: ${reused.length} events reused from ${path.basename(reuse)}`);
    }
    console.log(`backfill-straddle: ${events.length} events, ${per.size} tickers (${kinds ? `event_kind = 'earnings', last ${last} each` : `event_kind not filled yet: every 8-K since ${since}`}); d0 filled on ${d0s} rows`);

    // Closes (splits undone) for the snapshot sessions.
    const items: Item[] = [];
    const skipped: Result[] = [];
    const tick = [...new Set(events.map((e) => e.ticker))];
    const minDate = events.reduce((a, e) => (e.event_date < a ? e.event_date : a), lastClosed);
    const pxs = await mapPool(tick, 8, (t) => yahoo(t, addDays(minDate, -20), lastClosed));
    const pxOf = new Map(tick.map((t, i) => [t, pxs[i]!]));
    for (const ev of events) {
      const release = releaseOf(ev);
      const { reactLatest, snapshotSession } = releaseSessions(release);
      const key = `earn:${ev.ticker}:${ev.event_date}`;
      const px = pxOf.get(ev.ticker);
      const close = px ? closeAsTraded(px, snapshotSession) : null;
      if (close === null) {
        skipped.push({ key, ticker: ev.ticker, event_date: ev.event_date, accession: ev.accession, snap: snapshotSession, straddle: null, why: "no Yahoo close for the snapshot session" });
        continue;
      }
      const root = osiRoot(ev.ticker);
      const symbols: string[] = [];
      for (const x of straddleExpiries(reactLatest)) for (const k of straddleStrikes(close)) for (const r of ["C", "P"] as const) symbols.push(osiSymbol(root, x, r, k));
      items.push({ ev, release, snap: snapshotSession, close, symbols });
    }

    // Requests: per snapshot session, events packed up to MAX_SYMBOLS symbols.
    const bySnap = new Map<string, Item[]>();
    for (const it of items) bySnap.set(it.snap, [...(bySnap.get(it.snap) ?? []), it]);
    const chunks: Chunk[] = [];
    for (const [snap, its] of [...bySnap].sort()) {
      const m = snapshotMinute(snap);
      const iso = (min: number) => new Date(nyInstantMs(snap, min)).toISOString();
      let cur: Item[] = [];
      const flush = () => {
        if (!cur.length) return;
        const symbols = [...new Set(cur.flatMap((i) => i.symbols))];
        chunks.push({ snap, items: cur, req: { dataset: DATASET, schema: SCHEMA, symbols, stype_in: "raw_symbol", start: iso(m - LOOKBACK), end: iso(m + 1) }, priced: null, cached: false });
        cur = [];
      };
      for (const it of its) {
        if (cur.reduce((a, i) => a + i.symbols.length, 0) + it.symbols.length > MAX_SYMBOLS) flush();
        cur.push(it);
      }
      flush();
    }
    const nSym = chunks.reduce((a, c) => a + c.req.symbols.length, 0);
    console.log(`backfill-straddle: ${items.length} events priced as ${chunks.length} requests (${nSym} symbols), ${skipped.length} without a close`);

    // Price everything first (free get_cost); cached bodies cost nothing.
    const client = new DatabentoClient();
    const t0 = Date.now();
    let done = 0;
    await mapPool(chunks, conc, async (c) => {
      if (client.guard.readCache(requestKey(c.req))) {
        c.cached = true;
        c.priced = 0;
      } else {
        try {
          c.priced = await client.getCost(c.req);
        } catch (err) {
          c.err = err instanceof Error ? err.message.slice(0, 200) : String(err);
        }
      }
      if (++done % 50 === 0) console.log(`  priced ${done}/${chunks.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
    });
    const total = chunks.reduce((a, c) => a + (c.priced ?? 0), 0);
    const refused = chunks.filter((c) => c.err);
    console.log(`backfill-straddle: get_cost total $${total.toFixed(4)} over ${chunks.length - refused.length} requests (${chunks.filter((c) => c.cached).length} cached, ${refused.length} refused: ${refused.slice(0, 3).map((c) => c.err).join(" | ")}) in ${Math.round((Date.now() - t0) / 1000)} s`);
    if (priceOnly) return 0;
    if (total > cap) {
      console.log(`backfill-straddle: $${total.toFixed(4)} is above the cap $${cap.toFixed(2)}; nothing bought`);
      return 1;
    }

    // Buy: options_spend line first, then the download (refund line when it fails).
    const caller = `backfill-straddle@${new Date(nowMs).toISOString().slice(0, 16)}Z`;
    let spent = 0;
    const results: Result[] = [...skipped, ...reused];
    const divs = new Map<string, Promise<DividendHistory | null>>();
    const irx = await yahoo("^IRX", addDays(minDate, -30), lastClosed);
    const rateOn = (d: string) => {
      let best: number | null = null;
      for (const [k, v] of irx?.close ?? []) if (k <= d && v > 0 && v < 25) best = v;
      return best === null ? 0.04 : discountToContinuous(best);
    };
    done = 0;
    await mapPool(chunks, conc, async (c) => {
      if (c.err) {
        for (const it of c.items) results.push({ key: `earn:${it.ev.ticker}:${it.ev.event_date}`, ticker: it.ev.ticker, event_date: it.ev.event_date, accession: it.ev.accession, snap: it.snap, straddle: null, why: /could (not )?be resolved/i.test(c.err) ? "no options listed" : `refused: ${c.err.slice(0, 80)}` });
        return;
      }
      let entry: SpendEntry | null = null;
      if (!c.cached) {
        if (spent + (c.priced ?? 0) > cap + 1e-9) {
          for (const it of c.items) results.push({ key: `earn:${it.ev.ticker}:${it.ev.event_date}`, ticker: it.ev.ticker, event_date: it.ev.event_date, accession: it.ev.accession, snap: it.snap, straddle: null, why: "cap" });
          return;
        }
        spent += c.priced ?? 0;
        entry = { at: new Date().toISOString(), kind: "charge", dataset: DATASET, schema: SCHEMA, symbols: { count: c.req.symbols.length, first: c.req.symbols.slice(0, 3) }, start: c.req.start, end: c.req.end, costUsd: c.priced ?? 0, caller, key: requestKey(c.req), note: `pre-earnings straddles, snapshot ${c.snap}, ${c.items.length} events` };
        await ledger.append([entry]);
      }
      let records: Array<Record<string, unknown>> = [];
      try {
        const res = await client.getRange<Record<string, unknown>>(c.req, { caller, maxCallUsd: 0.5, maxCallerUsd: cap, ...(c.priced !== null && !c.cached ? { pricedUsd: c.priced } : {}) });
        records = res.records;
      } catch (err) {
        if (entry) await ledger.append([{ ...entry, at: new Date().toISOString(), kind: "refund", costUsd: -entry.costUsd, note: `download failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}` }]);
        spent -= c.priced ?? 0;
        for (const it of c.items) results.push({ key: `earn:${it.ev.ticker}:${it.ev.event_date}`, ticker: it.ev.ticker, event_date: it.ev.event_date, accession: it.ev.accession, snap: it.snap, straddle: null, why: `download failed` });
        return;
      }
      const byRoot = recordsByRoot(records);
      for (const it of c.items) {
        const t = it.ev.ticker;
        const key = `earn:${t}:${it.ev.event_date}`;
        const rs = byRoot.get(osiRoot(t)) ?? [];
        if (!rs.length) {
          results.push({ key, ticker: t, event_date: it.ev.event_date, accession: it.ev.accession, snap: it.snap, straddle: null, why: "no quotes near the money" });
          continue;
        }
        if (!divs.has(t)) divs.set(t, fetchDividends(t.replace(/\./g, "-")).catch(() => null));
        const div = await divs.get(t)!;
        const minute = snapshotMinute(it.snap);
        const asOfMs = nyInstantMs(it.snap, minute);
        const defs = definitionsFromRecords(rs, t);
        const quotes = quotesAt(rs as never, asOfMs);
        // Dividends are split-adjusted, like Yahoo's close: the yield is a ratio, so the adjusted close goes with them.
        const adj = pxOf.get(t)?.close.get(it.snap);
        const q = div && adj ? (dividendYieldOn(div, it.snap, adj) ?? 0) : 0;
        const run = (spot: number) => surfaceFeatures({ underlying: t, date: it.snap, asOfMs, spot, rate: rateOn(it.snap), divYield: q, definitions: defs, quotes, moveDates: [] });
        let spot = it.close;
        let f = run(spot);
        const p = f.parityImpliedSpot;
        if (p !== null && Math.abs(p / spot - 1) < 0.03) {
          spot = p;
          f = run(spot);
        }
        const label = `${it.snap} ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")} ET`;
        const st = earningsStraddle(f.contracts, spot, it.release, { asOfMs, sourceMinute: label, source: SOURCE });
        results.push({ key, ticker: t, event_date: it.ev.event_date, accession: it.ev.accession, snap: it.snap, straddle: st, ...(st ? {} : { why: "no strike with a two-sided call and put" }) });
      }
      if (++done % 50 === 0) console.log(`  bought ${done}/${chunks.length}, $${spent.toFixed(4)}`);
    });
    const ok = results.filter((r) => r.straddle);
    console.log(`backfill-straddle: ${ok.length} straddles of ${results.length} events; spent $${spent.toFixed(4)} (cap $${cap.toFixed(2)}), recorded as ${caller}`);
    const why = new Map<string, number>();
    for (const r of results) if (!r.straddle) why.set(r.why ?? "?", (why.get(r.why ?? "?") ?? 0) + 1);
    console.log(`backfill-straddle: without a straddle: ${[...why].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify({ caller, spentUsd: spent, pricedUsd: total, results }, null, 1)}\n`);
    }

    if (flag("write")) {
      if (!kinds || !d0s) {
        console.log(`backfill-straddle: not writing matchups: event_kind filled on ${kinds} rows, stock_return_d0 on ${d0s} (both needed)`);
        return 0;
      }
      const n = await writeEarnings(db, ok);
      console.log(`backfill-straddle: forecast_matchups: ${n.inserted} earnings rows inserted (${n.existing} already there), ${n.resolved} resolved`);
    }
    return 0;
  } finally {
    await ledger.close();
    await db.end();
  }
}

/** Earnings matchups from straddles: Falcon's trailing mean |abnormal d0| over earlier event_kind = 'earnings' releases. */
export async function writeEarnings(db: pg.Client, straddles: readonly Result[]): Promise<{ inserted: number; existing: number; resolved: number }> {
  const tickers = [...new Set(straddles.map((r) => r.ticker))];
  const ev = (
    await db.query(
      `select ticker, event_date::text as d, accession, stock_return_d0 as raw, abnormal_return_d0 as abn, sector_etf, price_source from public.historical_events where event_kind = 'earnings' and ticker = any($1::text[]) order by event_date`,
      [tickers],
    )
  ).rows as Array<{ ticker: string; d: string; accession: string; raw: number | null; abn: number | null; sector_etf: string | null; price_source: string | null }>;
  const past = new Map<string, Array<{ date: string; pct: number | null }>>();
  for (const e of ev) past.set(e.ticker, [...(past.get(e.ticker) ?? []), { date: e.d, pct: e.abn === null ? null : e.abn * 100 }]);
  const evOf = new Map(ev.map((e) => [`${e.ticker}|${e.d}`, e]));
  const rows: Array<Record<string, unknown>> = [];
  const outcomes: Array<{ key: string; row: Record<string, unknown> }> = [];
  for (const r of straddles) {
    const e = evOf.get(`${r.ticker}|${r.event_date}`);
    if (!e || !r.straddle) continue;
    const m = buildEarningsMatchup(
      { ticker: r.ticker, eventDate: r.event_date, createdAt: r.straddle.as_of, realizedRawPct: e.raw === null ? null : e.raw * 100, realizedAbnPct: e.abn === null ? null : e.abn * 100, benchmark: e.sector_etf, window: "d0", units: "abnormal" },
      r.straddle,
      past.get(r.ticker) ?? [],
    );
    if (!m) continue;
    const prior = (past.get(r.ticker) ?? []).filter((p) => p.date < r.event_date && p.pct !== null).length;
    const row = creationRow(m, { eventId: e.accession, spot: r.straddle.spot, optionsSession: r.snap, straddle: r.straddle });
    row.falcon_sample = m.falconAbsPct === null ? null : Math.min(8, prior);
    rows.push(row);
    const o = outcomeRow(m, e.price_source);
    if (o) outcomes.push({ key: m.key, row: o });
  }
  const inserted = await insertMatchups(db, rows);
  const resolved = await resolveMatchups(db, outcomes);
  return { inserted: inserted.length, existing: rows.length - inserted.length, resolved };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(scrub(String(err instanceof Error ? err.message : err)));
      process.exit(1);
    },
  );
}
