/**
 * node --import tsx scripts/scoreboard.ts [--out FILE] [--now ISO] [--write]
 *
 * The scoreboard (src/study/scoreboard.ts) from what is stored today, in
 * memory: every ripple_forecasts row paired with the options market's number
 * of its creation session (options_daily, else the Sightings card's own
 * block), plus earnings releases with a stored pre-earnings straddle
 * (options_daily.metrics.earnings_straddle, once the daily job writes it).
 * Realized moves for matchups whose horizon has closed come from Yahoo
 * adjusted closes (stock and its SPDR sector ETF from historical_events, SPY
 * otherwise). Also the storage audit: sessions stored since 2026-11-13 and
 * which forecast / card tickers had no stored row on their base session.
 *
 * Read-only by default: one connection in a read-only transaction
 * (default_transaction_read_only), no Databento call, nothing written to the
 * database. With --out, the matchups, the summary and the audit go to JSON.
 *
 * --write (scoreboard-store.ts): every matchup built here is inserted into
 * public.forecast_matchups (`on conflict (key) do nothing`: a row's Falcon and
 * market columns are frozen at the first write), matured ones get their
 * outcome and scores (only while resolved_at is null), and stored earnings
 * rows from the straddle backfill (scripts/backfill-straddle.ts) are resolved
 * from historical_events' d0 columns once those are filled. Nothing else is
 * written; no Databento call.
 */

import fs from "node:fs";
import pg from "pg";
import { env } from "../src/env.ts";
import { plainGet, HOUR_MS } from "../src/http.ts";
import { addDays, nyseSessions } from "../src/study/abnormal.ts";
import { parseChart } from "../src/study/forward.ts";
import { creationRow, insertMatchups, matchupFromRow, outcomeRow, resolveMatchups, type MatchupExtra } from "../src/study/scoreboard-store.ts";
import {
  buildEarningsMatchup,
  buildForecastMatchup,
  calendarDays,
  firstForecasts,
  interpolatedImpliedMove,
  lastClosedSession,
  movePct,
  summarize,
  type EarningsStraddle,
  type ForecastRowIn,
  type HitInfo,
  type Matchup,
  type StoredOptionsIn,
} from "../src/study/scoreboard.ts";

const AUDIT_FROM = "2026-11-13";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

const ymd = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

async function closes(ticker: string, from: string, to: string): Promise<Map<string, number> | null> {
  const sym = ticker.replace(/\./g, "-");
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${addDays(to, 1)}T00:00:00Z`) / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  try {
    const b = parseChart(JSON.parse(await plainGet(url, { maxAgeMs: 6 * HOUR_MS })));
    return b ? new Map(b.dates.map((d, i) => [d, b.adjClose[i]!])) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const url = env("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 1;
  }
  const nowMs = arg("now") ? Date.parse(arg("now")!) : Date.now();
  const lastClosed = lastClosedSession(nowMs);
  const write = process.argv.includes("--write");
  const db = new pg.Client({ connectionString: url, ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? false : { rejectUnauthorized: false }, ...(write ? {} : { options: "-c default_transaction_read_only=on" }) });
  await db.connect();
  await db.query(write ? "begin" : "begin transaction read only");
  try {
    const ledgerRows = (await db.query(`select id, created_at, event_id, card_id, ticker, tier, family, sign_pred, window_days, published, model_version, covariates from public.ripple_forecasts order by id`)).rows.map(
      (r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }) as ForecastRowIn,
    );
    const forecasts = firstForecasts(ledgerRows);
    const cards = (await db.query(`select id, generated_at, tickers, card from public.sightings_cards`)).rows as Array<{ id: string; generated_at: Date; tickers: string[]; card: { hits?: Array<HitInfo & { ticker: string }> } }>;
    const hitOf = new Map<string, HitInfo>();
    for (const c of cards) for (const h of c.card.hits ?? []) hitOf.set(`${c.id}|${h.ticker}`, h);

    const optRows = (await db.query(`select ticker, as_of::text as session, skip, metrics from public.options_daily where as_of >= $1 order by as_of`, [addDays(AUDIT_FROM, -10)])).rows as Array<{
      ticker: string;
      session: string;
      skip: string | null;
      metrics: { raw?: { asOf: string; spot: number; iv: number; skew: number | null; beta: number | null; vix: number | null; term: Array<[string, number, number]> }; earnings_straddle?: EarningsStraddle } | null;
    }>;
    const byTicker = new Map<string, typeof optRows>();
    for (const r of optRows) byTicker.set(r.ticker, [...(byTicker.get(r.ticker) ?? []), r]);
    /** Latest usable stored snapshot at or before `base`, within 5 sessions. */
    const optFor = (t: string, base: string): StoredOptionsIn | null => {
      const rows = (byTicker.get(t) ?? []).filter((r) => r.session <= base && r.session >= addDays(base, -8) && !r.skip && r.metrics?.raw);
      const r = rows[rows.length - 1];
      return r ? { session: r.session, ...r.metrics!.raw! } : null;
    };

    // Benchmarks: the ticker's SPDR sector ETF from historical_events, else SPY.
    const etfRows = (await db.query(`select distinct on (ticker) ticker, sector_etf from public.historical_events where sector_etf is not null order by ticker, event_date desc`)).rows as Array<{ ticker: string; sector_etf: string }>;
    const etfOf = new Map(etfRows.map((r) => [r.ticker, r.sector_etf]));

    // ---------------------------------------------------------------- forecasts
    const matchups: Matchup[] = [];
    /** What each matchup's row carries beyond the Matchup (written with --write). */
    const extras = new Map<string, MatchupExtra & { priceSource?: string | null; sample?: number | null }>();
    const priceCache = new Map<string, Promise<Map<string, number> | null>>();
    const px = (t: string) => {
      if (!priceCache.has(t)) priceCache.set(t, closes(t, addDays(AUDIT_FROM, -20), lastClosed));
      return priceCache.get(t)!;
    };
    const auditRows: Array<{ key: string; ticker: string; base: string; status: string }> = [];
    for (const f of forecasts) {
      const hit = hitOf.get(`${f.card_id}|${f.ticker}`) ?? null;
      let m = buildForecastMatchup(f, hit, optFor(f.ticker, lastClosedSession(Date.parse(f.created_at))));
      const stored = (byTicker.get(f.ticker) ?? []).find((r) => r.session === m.baseDate);
      auditRows.push({ key: m.key, ticker: f.ticker, base: m.baseDate, status: stored ? (stored.skip ? `skip: ${stored.skip}` : "stored") : "absent" });
      if (m.exitDate <= lastClosed && (m.marketRawPct !== null || write)) {
        const bench = etfOf.get(f.ticker) ?? "SPY";
        const [a, b] = await Promise.all([px(f.ticker), px(bench)]);
        const raw = a ? movePct(a, m.baseDate, m.exitDate) : null;
        const bp = b ? movePct(b, m.baseDate, m.exitDate) : null;
        m = buildForecastMatchup(f, hit, optFor(f.ticker, m.baseDate), { rawPct: raw, benchPct: bp, benchmark: bench });
      }
      matchups.push(m);
      extras.set(m.key, forecastExtra(f, hit, m, optFor(f.ticker, m.baseDate)));
    }

    // ---------------------------------------------------------------- earnings (needs earnings_straddle in options_daily)
    const cols = new Set((await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'historical_events'`)).rows.map((r) => r.column_name as string));
    const straddleRows = optRows.filter((r) => r.metrics?.earnings_straddle);
    let earningsNote = `no options_daily row carries earnings_straddle yet (${optRows.length} rows read)`;
    if (straddleRows.length) {
      const kindFilter = cols.has("event_kind") ? `and event_kind = 'earnings'` : "";
      const d0 = cols.has("stock_return_d0") ? "stock_return_d0" : "stock_return_d0_d1";
      const ab0 = cols.has("abnormal_return_d0") ? "abnormal_return_d0" : "abnormal_return_d0_d1";
      const ev = (await db.query(`select ticker, event_date::text as d, ${d0} as raw, ${ab0} as abn, sector_etf from public.historical_events where event_date >= $1 ${kindFilter} order by event_date`, [addDays(AUDIT_FROM, -3650)])).rows as Array<{ ticker: string; d: string; raw: number | null; abn: number | null; sector_etf: string | null }>;
      const past = new Map<string, Array<{ date: string; pct: number | null }>>();
      // Scored beyond the sector ETF (the abnormal reaction), as the straddle backfill's rows.
      for (const e of ev) past.set(e.ticker, [...(past.get(e.ticker) ?? []), { date: e.d, pct: e.abn === null ? null : e.abn * 100 }]);
      let n = 0;
      for (const e of ev.filter((x) => x.d > AUDIT_FROM)) {
        const prev = nyseSessions(addDays(e.d, -7), addDays(e.d, -1)).pop();
        const row = straddleRows.find((r) => r.ticker === e.ticker && r.session === prev);
        const m = row && buildEarningsMatchup({ ticker: e.ticker, eventDate: e.d, realizedRawPct: e.raw === null ? null : e.raw * 100, realizedAbnPct: e.abn === null ? null : e.abn * 100, benchmark: e.sector_etf, window: d0 === "stock_return_d0" ? "d0" : "d0_d1", units: "abnormal" }, row.metrics!.earnings_straddle!, past.get(e.ticker) ?? []);
        if (m) {
          matchups.push(m);
          extras.set(m.key, { eventId: e.d ? `${e.ticker}:${e.d}` : null, spot: row.metrics!.earnings_straddle!.spot, optionsSession: row.session, straddle: row.metrics!.earnings_straddle });
          n++;
        }
      }
      earningsNote = `${straddleRows.length} straddles stored, ${n} earnings matchups built`;
    }

    // ---------------------------------------------------------------- storage audit
    const sessions = (await db.query(`select as_of::text as d, count(*) filter (where skip is null) as ok, count(*) filter (where skip is not null) as skips, min(created_at) as first from public.options_daily where as_of >= $1 group by 1 order by 1`, [AUDIT_FROM])).rows;
    const expected = nyseSessions(AUDIT_FROM, lastClosed);
    const have = new Set(sessions.map((s) => s.d as string));
    const cardTickers = [...new Set(cards.flatMap((c) => c.tickers))].sort();
    const cardAudit = cardTickers.map((t) => {
      const c = cards.filter((x) => x.tickers.includes(t)).map((x) => lastClosedSession(new Date(x.generated_at).getTime()));
      const base = c.sort().pop()!;
      const r = (byTicker.get(t) ?? []).find((x) => x.session === base);
      return { ticker: t, base, status: r ? (r.skip ? "skip" : "stored") : "absent" };
    });

    const summary = summarize(matchups);
    const audit = {
      lastClosed,
      expectedSessions: expected,
      storedSessions: sessions.map((s) => ({ session: s.d, ok: Number(s.ok), skips: Number(s.skips), firstWritten: new Date(s.first).toISOString() })),
      missingSessions: expected.filter((d) => !have.has(d)),
      forecasts: {
        ledgerRows: ledgerRows.length,
        rows: auditRows.length,
        tickers: new Set(auditRows.map((r) => r.ticker)).size,
        byStatus: Object.fromEntries(["stored", "absent", "skip"].map((s) => [s, new Set(auditRows.filter((r) => r.status.startsWith(s)).map((r) => r.ticker)).size])),
        absent: [...new Set(auditRows.filter((r) => r.status === "absent").map((r) => r.ticker))].sort(),
      },
      cards: { tickers: cardTickers.length, absent: cardAudit.filter((c) => c.status === "absent").map((c) => `${c.ticker}@${c.base}`), skip: cardAudit.filter((c) => c.status === "skip").map((c) => c.ticker) },
      earnings: earningsNote,
    };
    const market = {
      termInterp: matchups.filter((m) => m.kind === "forecast" && m.marketMethod === "term_interp" && m.marketRawPct !== null).length,
      cardBlock: matchups.filter((m) => m.marketMethod === "card_block").length,
      none: matchups.filter((m) => m.kind === "forecast" && m.marketRawPct === null).length,
      falconSize: matchups.filter((m) => m.falconAbsPct !== null).length,
      byHorizon: Object.fromEntries([5, 20, 63].map((L) => [L, matchups.filter((m) => m.horizonSessions === L).length])),
      exits: [...new Set(matchups.map((m) => m.exitDate))].sort(),
    };
    let written: Record<string, number> | null = null;
    if (write) {
      // Creation rows (frozen once written), then outcomes of the matured ones, then the backfill's earnings rows.
      const rows = matchups.map((m) => {
        const x = extras.get(m.key) ?? {};
        const r = creationRow(m, x);
        r.falcon_sample = x.sample ?? null;
        return r;
      });
      const inserted = await insertMatchups(db, rows);
      const outcomes = matchups.flatMap((m) => {
        const o = outcomeRow(m, m.benchmark ? "yahoo" : null);
        return o ? [{ key: m.key, row: o }] : [];
      });
      const resolved = await resolveMatchups(db, outcomes);
      const earnResolved = await resolveStoredEarnings(db, lastClosed, cols);
      written = { built: rows.length, inserted: inserted.length, alreadyStored: rows.length - inserted.length, resolved, earningsResolved: earnResolved };
    }
    console.log(JSON.stringify({ audit, market, summary, ...(written ? { written } : {}) }, null, 2));
    const out = arg("out");
    if (out) fs.writeFileSync(out, `${JSON.stringify({ audit, market, summary, matchups, ...(written ? { written } : {}) }, null, 2)}\n`);
    await db.query("commit");
    return 0;
  } finally {
    await db.end();
  }
}

/** The extra row columns of a forecast matchup: ids, the market's interpolation inputs, the record's sample. */
function forecastExtra(f: ForecastRowIn, hit: HitInfo | null, m: Matchup, opt: StoredOptionsIn | null): MatchupExtra & { sample?: number | null } {
  const x: MatchupExtra & { sample?: number | null } = { forecastId: f.id, eventId: f.event_id, cardId: f.card_id, modelVersion: f.model_version ?? null };
  if (m.falconSource === "record") x.sample = hit?.history?.events?.length ?? hit?.history?.sample ?? hit?.options?.matched?.sample ?? null;
  if (m.marketMethod === "term_interp" && m.marketRawPct !== null && opt) {
    const shift = calendarDays(opt.session, m.baseDate);
    const term = opt.term.map(([expiration, days, iv]) => ({ expiration, days: days - shift, iv })).filter((p) => p.days > 0);
    const mv = interpolatedImpliedMove({ date: m.baseDate, term, beta: opt.beta, vix: opt.vix }, m.horizonSessions);
    Object.assign(x, { marketIv: mv?.iv ?? null, marketInterp: mv?.method ?? null, atmIv30: opt.iv, skew: opt.skew, spot: opt.spot, beta: opt.beta, vix: opt.vix, optionsSession: opt.session });
  } else if (m.marketMethod === "card_block" && hit?.options) {
    Object.assign(x, { atmIv30: typeof hit.options.atmIv === "number" ? hit.options.atmIv / 100 : null, skew: hit.options.skew ?? null, spot: hit.options.spot ?? null });
  }
  return x;
}

/**
 * Stored earnings rows not resolved yet (the straddle backfill's, or earlier runs'): realized from historical_events'
 * d0 columns (event_kind = 'earnings' when that column is filled). Returns rows resolved.
 */
async function resolveStoredEarnings(db: pg.Client, lastClosed: string, cols: Set<string>): Promise<number> {
  if (!cols.has("stock_return_d0")) return 0;
  const open = (await db.query(`select *, exit_date::text as exit_day from public.forecast_matchups where kind = 'earnings' and resolved_at is null and exit_date <= $1`, [lastClosed])).rows as Array<Record<string, unknown>>;
  if (!open.length) return 0;
  const tickers = [...new Set(open.map((r) => String(r.ticker)))];
  const ev = (await db.query(`select ticker, event_date::text as d, stock_return_d0 as raw, abnormal_return_d0 as abn, sector_etf, price_source from public.historical_events where ticker = any($1::text[]) and stock_return_d0 is not null`, [tickers])).rows as Array<{ ticker: string; d: string; raw: number; abn: number | null; sector_etf: string | null; price_source: string | null }>;
  const of = new Map(ev.map((e) => [`${e.ticker}|${e.d}`, e]));
  const outcomes: Array<{ key: string; row: Record<string, unknown> }> = [];
  for (const r of open) {
    const exit = String(r.exit_day);
    const e = of.get(`${r.ticker}|${exit}`);
    if (!e) continue;
    const m = matchupFromRow(r, { rawPct: e.raw * 100, abnPct: e.abn === null ? null : e.abn * 100, benchmark: e.sector_etf });
    const o = outcomeRow(m, e.price_source);
    if (o) outcomes.push({ key: m.key, row: o });
  }
  return resolveMatchups(db, outcomes);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err instanceof Error ? err.message : err).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***"));
    process.exit(1);
  },
);
