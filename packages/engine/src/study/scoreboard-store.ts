/**
 * public.forecast_matchups (migration apps/web/supabase/migrations/
 * 20261122_forecast_matchups.sql): the scoreboard's matchups (scoreboard.ts),
 * one row per key, written once with both sides frozen at creation, and
 * completed by a later run once the horizon has closed (outcome and scores).
 *
 *   insert: `on conflict (key) do nothing`, so a row's Falcon and market
 *           columns are never rewritten.
 *   resolve: outcome and score columns only, and only while resolved_at is null.
 *
 * Written by scripts/scoreboard.ts --write and scripts/backfill-straddle.ts
 * (DATABASE_URL); read by the Falcon AI /scoreboard tool with the service role.
 */

import type pg from "pg";
import { SCOREBOARD_VERSION, scoreMatchup, type Matchup } from "./scoreboard.ts";

/** What a matchup row carries beyond `Matchup` (scoreboard.ts). */
export type MatchupExtra = {
  forecastId?: number | string | null;
  eventId?: string | null;
  cardId?: string | null;
  modelVersion?: string | null;
  marketIv?: number | null;
  marketInterp?: string | null;
  atmIv30?: number | null;
  skew?: number | null;
  spot?: number | null;
  beta?: number | null;
  vix?: number | null;
  optionsSession?: string | null;
  straddle?: unknown;
  priceSource?: string | null;
};

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const numOrNull = (x: unknown) => (fin(x) ? x : null);

/** The columns written at creation (Falcon and market sides). Pure. */
export function creationRow(m: Matchup, x: MatchupExtra = {}): Record<string, unknown> {
  return {
    key: m.key,
    kind: m.kind,
    forecast_id: x.forecastId ?? null,
    event_id: x.eventId ?? m.eventId ?? null,
    card_id: x.cardId ?? null,
    ticker: m.ticker,
    created_at: m.createdAt,
    horizon_sessions: m.horizonSessions,
    base_date: m.baseDate,
    exit_date: m.exitDate,
    falcon_sign: m.falconSign,
    falcon_abs_pct: numOrNull(m.falconAbsPct),
    falcon_signed_pct: numOrNull(m.falconSignedPct),
    falcon_source: m.falconSource ?? null,
    falcon_sample: null,
    tier: m.tier ?? null,
    confidence: m.confidence ?? null,
    family: m.family ?? null,
    published: m.published ?? null,
    model_version: x.modelVersion ?? null,
    market_method: m.marketMethod,
    market_raw_pct: numOrNull(m.marketRawPct),
    market_adj_pct: numOrNull(m.marketAdjPct),
    market_iv: numOrNull(x.marketIv),
    market_interp: x.marketInterp ?? null,
    atm_iv30: numOrNull(x.atmIv30),
    skew: numOrNull(x.skew),
    spot: numOrNull(x.spot),
    beta: numOrNull(x.beta),
    vix: numOrNull(x.vix),
    options_as_of: m.optionsAsOf ?? null,
    options_session: x.optionsSession ?? null,
    options_lag_sessions: m.optionsLagSessions ?? null,
    straddle: x.straddle === undefined || x.straddle === null ? null : JSON.stringify(x.straddle),
    units: m.units,
  };
}

/** The outcome and score columns of a matured matchup; null while it has not matured. Pure. */
export function outcomeRow(m: Matchup, priceSource: string | null = null): Record<string, unknown> | null {
  const s = scoreMatchup(m);
  if (!s.matured) return null;
  return {
    benchmark: m.benchmark ?? null,
    realized_raw_pct: numOrNull(m.realizedRawPct),
    benchmark_pct: fin(m.realizedRawPct) && fin(m.realizedAbnPct) ? m.realizedRawPct - m.realizedAbnPct : null,
    realized_abn_pct: numOrNull(m.realizedAbnPct),
    price_source: priceSource,
    dir_hit: s.dirHit,
    falcon_err: numOrNull(s.falconErr),
    market_err: numOrNull(s.marketErr),
    ratio: numOrNull(s.ratio),
    pnl_dir: numOrNull(s.pnlDir),
    pnl_straddle: numOrNull(s.straddle),
    pnl_vol: numOrNull(s.pnlVol),
    score_version: SCOREBOARD_VERSION,
  };
}

const CREATION_COLS = Object.keys(creationRow({ kind: "forecast", key: "", ticker: "", createdAt: "", horizonSessions: 1, baseDate: "", exitDate: "", falconSign: 0, falconAbsPct: null, marketMethod: "term_interp", marketRawPct: null, marketAdjPct: null, units: "raw", realizedRawPct: null, realizedAbnPct: null }));

/** Inserts rows (creation columns), leaving any existing key untouched. Returns the keys inserted. */
export async function insertMatchups(db: pg.Client, rows: ReadonlyArray<Record<string, unknown>>): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const ph = CREATION_COLS.map((c, k) => {
        vals.push(r[c] ?? null);
        return `$${j * CREATION_COLS.length + k + 1}${c === "straddle" ? "::jsonb" : ""}`;
      });
      return `(${ph.join(", ")})`;
    });
    const res = await db.query<{ key: string }>(`insert into public.forecast_matchups (${CREATION_COLS.join(", ")}) values ${tuples.join(", ")} on conflict (key) do nothing returning key`, vals);
    out.push(...res.rows.map((r) => r.key));
  }
  return out;
}

/** Fills the outcome of unresolved rows (resolved_at is null). Returns the rows updated. */
export async function resolveMatchups(db: pg.Client, outcomes: ReadonlyArray<{ key: string; row: Record<string, unknown> }>): Promise<number> {
  let n = 0;
  for (const o of outcomes) {
    const cols = Object.keys(o.row);
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    const res = await db.query(`update public.forecast_matchups set ${set}, resolved_at = now() where key = $1 and resolved_at is null`, [o.key, ...cols.map((c) => o.row[c] ?? null)]);
    n += res.rowCount ?? 0;
  }
  return n;
}

/** A stored row (snake_case, as pg returns it) back as a Matchup, with an outcome given separately. Pure. */
export function matchupFromRow(r: Record<string, unknown>, outcome: { rawPct: number | null; abnPct: number | null; benchmark: string | null } | null = null): Matchup {
  // node-postgres reads a `date` as local midnight: its local calendar day is the stored one.
  const ymd = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v ?? "").slice(0, 10));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    kind: r.kind as Matchup["kind"],
    key: String(r.key),
    ticker: String(r.ticker),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    eventId: (r.event_id as string | null) ?? null,
    horizonSessions: Number(r.horizon_sessions),
    baseDate: ymd(r.base_date),
    exitDate: ymd(r.exit_date),
    falconSign: Number(r.falcon_sign) as -1 | 0 | 1,
    falconAbsPct: n(r.falcon_abs_pct),
    falconSignedPct: n(r.falcon_signed_pct),
    falconSource: (r.falcon_source as Matchup["falconSource"]) ?? null,
    tier: (r.tier as Matchup["tier"]) ?? null,
    confidence: (r.confidence as Matchup["confidence"]) ?? null,
    family: (r.family as string | null) ?? null,
    published: (r.published as boolean | null) ?? null,
    marketMethod: r.market_method as Matchup["marketMethod"],
    marketRawPct: n(r.market_raw_pct),
    marketAdjPct: n(r.market_adj_pct),
    optionsAsOf: r.options_as_of instanceof Date ? r.options_as_of.toISOString() : ((r.options_as_of as string | null) ?? null),
    optionsLagSessions: n(r.options_lag_sessions),
    units: r.units as Matchup["units"],
    realizedRawPct: outcome ? outcome.rawPct : n(r.realized_raw_pct),
    realizedAbnPct: outcome ? outcome.abnPct : n(r.realized_abn_pct),
    benchmark: outcome ? outcome.benchmark : ((r.benchmark as string | null) ?? null),
  };
}
