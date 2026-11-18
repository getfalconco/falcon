/**
 * `falcon_scoreboard` (/scoreboard): Falcon's forecasts against the options
 * market's, head to head ("Falcon mı piyasa mı daha isabetli?"). The scoring
 * is the engine's (packages/engine/src/study/scoreboard.ts); this tool only
 * gathers the matchups and shapes the summary for the model.
 *
 * Where the matchups come from:
 *   - public.forecast_matchups when it has rows (migration
 *     20261122_forecast_matchups.sql, written by the engine's
 *     scripts/scoreboard.ts --write and scripts/backfill-straddle.ts): Falcon
 *     forecasts (kind 'forecast') and earnings releases (kind 'earnings':
 *     Falcon's trailing mean |reaction| against the pre-earnings straddle);
 *   - until then, live and read-only: the first ripple_forecasts row per
 *     (event, ticker, horizon), its Sightings hit (for Falcon's size), the
 *     options_daily snapshot of its creation session (else the card's own
 *     block), and for horizons that have closed, Yahoo adjusted closes of the
 *     stock and its sector ETF (from historical_events; SPY otherwise).
 *
 * The two kinds are scored apart (forecasts over their horizon, earnings on
 * the reaction day; both in moves beyond the sector ETF): `kind` picks one; without it the main figures are
 * the forecasts' and an `earnings` section summarizes the earnings matchups.
 *
 * Read-only through the service client; no Databento call; never writes.
 * runScoreboardTool never throws.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  MIN_SAMPLE,
  buildForecastMatchup,
  firstForecasts,
  lastClosedSession,
  movePct,
  summarize,
  type ForecastRowIn,
  type HitInfo,
  type Matchup,
  type MeanCi,
  type RateSummary,
  type StoredOptionsIn,
} from "../../../../../packages/engine/src/study/scoreboard.ts";
import type { DeskToolOutcome } from "./index";
import { DEFAULT_TOOL_TIMEOUT_MS, TtlCache, ToolError, addDays, deadline, fitResult, normalizeTicker, round, type DeskToolContext } from "./util";

export const SCOREBOARD_TOOL_NAME = "falcon_scoreboard";
export const MATCHUPS_TABLE = "forecast_matchups";
/** Tickers priced from Yahoo at most per call (matured matchups only). */
export const MAX_PRICED = 80;

const TIERS = ["measured", "documented", "watch"] as const;
const KINDS = ["forecast", "earnings"] as const;
/** Rows read from forecast_matchups per page, and at most. */
const PAGE = 1000;
const MAX_ROWS = 40_000;

/** SPDR sector ETF to the sector it tracks (earnings matchups are grouped by it). */
const SECTOR_OF: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financials",
  XLV: "Health care",
  XLY: "Consumer discretionary",
  XLP: "Consumer staples",
  XLE: "Energy",
  XLI: "Industrials",
  XLB: "Materials",
  XLU: "Utilities",
  XLRE: "Real estate",
  XLC: "Communication services",
  SPY: "No sector ETF (SPY)",
};

export const SCOREBOARD_TOOL = {
  name: SCOREBOARD_TOOL_NAME,
  description:
    "Falcon's scoreboard: Falcon's own forecasts (Sightings / forecast ledger: direction, horizon, evidence label, expected size) head to head with the options market's forecast for the same stock, horizon and closes (the implied move from OPRA option prices of the forecast's creation session; for earnings, the pre-earnings ATM straddle). " +
    "Returns sample sizes (forecasts, with a market number, matured, pending and when the next ones mature), direction hit rate with a 95% interval against a coin and against always-the-majority-sign (the options market prices no direction), size errors (Falcon's expected size vs the market's implied move against the realized move: mean absolute errors, paired difference with interval, share where Falcon was closer), realized / implied (above 1: the market under-priced the moves on Falcon's events), results by evidence label and confidence, P&L proxies in implied-move units, warnings for small samples, and the method. " +
    "Earnings (kind earnings): for past earnings releases, Falcon's earnings-move estimate (the company's mean absolute reaction over its 4 to 8 earlier releases) against the options market's pre-earnings straddle and the realized reaction-day move, with sample sizes, intervals and results by sector. " +
    "Use it for any question on whether Falcon or the market forecasts better (on earnings too), Falcon's track record against options, or how accurate Falcon's calls are. Free and read-only. The member may type /scoreboard, /scoreboard NVDA, /scoreboard documented or /scoreboard earnings.",
  input_schema: {
    type: "object",
    properties: {
      ticker: { type: "string", maxLength: 10, description: "Only this stock's matchups." },
      tier: { type: "string", enum: [...TIERS], description: "Only this evidence label (Measured, Documented or Watch)." },
      kind: { type: "string", enum: [...KINDS], description: "forecast: Falcon's own forecasts (the default figures). earnings: past earnings releases, Falcon's earnings-move estimate vs the pre-earnings straddle." },
    },
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/* ------------------------------------------------------------------ input */

export type ScoreboardQuery = { ticker: string | null; tier: (typeof TIERS)[number] | null; kind?: (typeof KINDS)[number] | null };

export function parseScoreboardInput(input: unknown): ScoreboardQuery {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  let tier: ScoreboardQuery["tier"] = null;
  if (i.tier !== undefined && i.tier !== null && i.tier !== "") {
    const t = String(i.tier).trim().toLowerCase();
    if (!(TIERS as readonly string[]).includes(t)) throw new ToolError(`tier must be one of ${TIERS.join(", ")}.`);
    tier = t as ScoreboardQuery["tier"];
  }
  const ticker = i.ticker === undefined || i.ticker === null || i.ticker === "" ? null : normalizeTicker(i.ticker);
  let kind: ScoreboardQuery["kind"] = null;
  if (i.kind !== undefined && i.kind !== null && i.kind !== "") {
    const k = String(i.kind).trim().toLowerCase();
    if (!(KINDS as readonly string[]).includes(k)) throw new ToolError(`kind must be one of ${KINDS.join(", ")}.`);
    kind = k as ScoreboardQuery["kind"];
  }
  return { ticker, tier, kind };
}

export function scoreboardLabel(input: unknown, phase: "running" | "done" = "done"): string {
  const run = phase === "running";
  let what = "";
  try {
    const q = parseScoreboardInput(input);
    what = [q.ticker, q.tier, q.kind === "earnings" ? "earnings" : null].filter(Boolean).join(" ");
  } catch {
    /* label only */
  }
  return `${run ? "Scoring" : "Scored"} Falcon vs the options market${what ? ` (${what})` : ""}`;
}

/** "/scoreboard", "/scoreboard NVDA", "/scoreboard documented". Pure. */
export function scoreboardCommand(input: Record<string, unknown>): string {
  const parts = ["/scoreboard"];
  if (typeof input.ticker === "string" && input.ticker.trim()) parts.push(input.ticker.trim().toUpperCase().slice(0, 10));
  if (typeof input.tier === "string" && input.tier.trim()) parts.push(input.tier.trim().toLowerCase().slice(0, 12));
  if (input.kind === "earnings") parts.push("earnings");
  return parts.join(" ");
}

/* ------------------------------------------------------------------ store */

export type MatchupRow = Record<string, unknown>;

export type ScoreboardStore = {
  /** forecast_matchups rows, or null when the table does not exist yet. */
  matchups(signal: AbortSignal): Promise<MatchupRow[] | null>;
  forecasts(signal: AbortSignal): Promise<ForecastRowIn[]>;
  /** Sightings hits by "<card id>|<ticker>". */
  hits(signal: AbortSignal): Promise<Map<string, HitInfo>>;
  /** Usable options_daily snapshots of these tickers from `from` on, oldest first. */
  options(tickers: string[], from: string, signal: AbortSignal): Promise<Map<string, StoredOptionsIn[]>>;
  /** Sector ETF per ticker (historical_events). */
  etfs(tickers: string[], signal: AbortSignal): Promise<Map<string, string>>;
  /** Adjusted closes by date, or null when unknown. */
  closes(ticker: string, signal: AbortSignal): Promise<Map<string, number> | null>;
};

/** The table does not exist yet (or PostgREST has not seen it). */
export function isMissingTable(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /relation .* does not exist|could not find the table|schema cache/i.test(err.message ?? "");
}

const admin = async () => (await import("../../supabase-admin")).getSupabaseAdmin();
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function supabaseScoreboardStore(): ScoreboardStore {
  return {
    async matchups(signal) {
      const db = await admin();
      const out: MatchupRow[] = [];
      for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await db
          .from(MATCHUPS_TABLE)
          .select("*")
          .order("base_date", { ascending: false })
          .order("key", { ascending: true })
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) {
          if (isMissingTable(error)) return null;
          throw new Error(`forecast_matchups: ${error.message}`);
        }
        out.push(...((data ?? []) as MatchupRow[]));
        if (!data || data.length < PAGE) break;
      }
      return out;
    },
    async forecasts(signal) {
      const db = await admin();
      const { data, error } = await db
        .from("ripple_forecasts")
        .select("id, created_at, event_id, card_id, ticker, tier, family, sign_pred, window_days, published, model_version, covariates")
        .order("id", { ascending: true })
        .limit(10000)
        .abortSignal(signal);
      if (error) throw new Error(`ripple_forecasts: ${error.message}`);
      return ((data ?? []) as ForecastRowIn[]).map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    },
    async hits(signal) {
      const db = await admin();
      const { data, error } = await db.from("sightings_cards").select("id, card").limit(2000).abortSignal(signal);
      if (error) throw new Error(`sightings_cards: ${error.message}`);
      const out = new Map<string, HitInfo>();
      for (const c of (data ?? []) as Array<{ id: string; card: { hits?: Array<HitInfo & { ticker: string }> } }>) for (const h of c.card?.hits ?? []) out.set(`${c.id}|${h.ticker}`, h);
      return out;
    },
    async options(tickers, from, signal) {
      const out = new Map<string, StoredOptionsIn[]>();
      if (!tickers.length) return out;
      const db = await admin();
      for (let i = 0; i < tickers.length; i += 200) {
        const { data, error } = await db
          .from("options_daily")
          .select("ticker, as_of, metrics")
          .in("ticker", tickers.slice(i, i + 200))
          .gte("as_of", from)
          .is("skip", null)
          .order("as_of", { ascending: true })
          .limit(20000)
          .abortSignal(signal);
        if (error) throw new Error(`options_daily: ${error.message}`);
        for (const r of (data ?? []) as Array<{ ticker: string; as_of: string; metrics: { raw?: Omit<StoredOptionsIn, "session"> } | null }>) {
          if (!r.metrics?.raw) continue;
          out.set(r.ticker, [...(out.get(r.ticker) ?? []), { session: r.as_of.slice(0, 10), ...r.metrics.raw }]);
        }
      }
      return out;
    },
    async etfs(tickers, signal) {
      const out = new Map<string, string>();
      if (!tickers.length) return out;
      const db = await admin();
      const { data, error } = await db.from("historical_events").select("ticker, sector_etf, event_date").in("ticker", tickers).not("sector_etf", "is", null).order("event_date", { ascending: false }).limit(5000).abortSignal(signal);
      if (error) return out; // no benchmark map: SPY for all
      for (const r of (data ?? []) as Array<{ ticker: string; sector_etf: string }>) if (!out.has(r.ticker)) out.set(r.ticker, r.sector_etf);
      return out;
    },
    async closes(ticker, signal) {
      const { yahooChart } = await import("./yahoo");
      const c = await yahooChart(ticker.replace(/\./g, "-"), "1y", "1d", signal).catch(() => null);
      const ts = c?.timestamp ?? [];
      const adj = c?.indicators?.adjclose?.[0]?.adjclose ?? c?.indicators?.quote?.[0]?.close ?? [];
      const off = typeof c?.meta?.gmtoffset === "number" ? c.meta.gmtoffset : -5 * 3600;
      if (!ts.length) return null;
      const out = new Map<string, number>();
      ts.forEach((t, i) => {
        const v = adj[i];
        if (typeof v === "number" && v > 0) out.set(new Date((t + off) * 1000).toISOString().slice(0, 10), v);
      });
      return out;
    },
  };
}

/* ------------------------------------------------------------------ matchups */

/** A forecast_matchups row as the engine's Matchup. Pure. */
export function matchupFromRow(r: MatchupRow): Matchup {
  const sign = num(r.falcon_sign);
  return {
    kind: r.kind === "earnings" ? "earnings" : "forecast",
    key: String(r.key ?? ""),
    ticker: String(r.ticker ?? ""),
    createdAt: String(r.created_at ?? ""),
    eventId: str(r.event_id),
    horizonSessions: num(r.horizon_sessions) ?? 1,
    baseDate: String(r.base_date ?? "").slice(0, 10),
    exitDate: String(r.exit_date ?? "").slice(0, 10),
    falconSign: (sign === 1 ? 1 : sign === -1 ? -1 : 0) as -1 | 0 | 1,
    falconAbsPct: num(r.falcon_abs_pct),
    falconSignedPct: num(r.falcon_signed_pct),
    falconSource: (str(r.falcon_source) as Matchup["falconSource"]) ?? null,
    tier: (str(r.tier) as Matchup["tier"]) ?? null,
    confidence: (str(r.confidence) as Matchup["confidence"]) ?? null,
    family: str(r.family),
    published: typeof r.published === "boolean" ? r.published : null,
    marketMethod: r.market_method === "earnings_straddle" ? "earnings_straddle" : r.market_method === "card_block" ? "card_block" : "term_interp",
    marketRawPct: num(r.market_raw_pct),
    marketAdjPct: num(r.market_adj_pct),
    optionsAsOf: str(r.options_as_of),
    optionsLagSessions: num(r.options_lag_sessions),
    units: r.units === "raw" ? "raw" : "abnormal",
    realizedRawPct: num(r.realized_raw_pct),
    realizedAbnPct: num(r.realized_abn_pct),
    benchmark: str(r.benchmark),
  };
}

/** The matchups from the ledger, live (no forecast_matchups table yet). */
export async function liveMatchups(store: ScoreboardStore, nowMs: number, signal: AbortSignal): Promise<{ matchups: Matchup[]; ledgerRows: number; priced: number; unpriced: number }> {
  const [rows, hits] = await Promise.all([store.forecasts(signal), store.hits(signal)]);
  const forecasts = firstForecasts(rows);
  const tickers = [...new Set(forecasts.map((f) => f.ticker))];
  const first = forecasts.map((f) => lastClosedSession(Date.parse(f.created_at))).sort()[0];
  const options = first ? await store.options(tickers, addDays(first, -10), signal) : new Map<string, StoredOptionsIn[]>();
  const optFor = (t: string, base: string) => {
    const list = (options.get(t) ?? []).filter((o) => o.session <= base && o.session >= addDays(base, -8));
    return list[list.length - 1] ?? null;
  };
  const lastClosed = lastClosedSession(nowMs);
  let matchups = forecasts.map((f) => buildForecastMatchup(f, hits.get(`${f.card_id}|${f.ticker}`) ?? null, optFor(f.ticker, lastClosedSession(Date.parse(f.created_at)))));

  // Outcomes for matchups whose horizon has closed (a bounded number of tickers a call).
  const due = matchups.filter((m) => m.exitDate <= lastClosed && (m.marketRawPct !== null || m.marketAdjPct !== null));
  let priced = 0;
  let unpriced = 0;
  if (due.length) {
    const dueTickers = [...new Set(due.map((m) => m.ticker))];
    const etfs = await store.etfs(dueTickers, signal);
    const names = [...new Set([...dueTickers.slice(0, MAX_PRICED), ...dueTickers.slice(0, MAX_PRICED).map((t) => etfs.get(t) ?? "SPY")])];
    const closes = new Map<string, Map<string, number> | null>();
    const results = await Promise.all(names.map((n) => store.closes(n, signal).catch(() => null)));
    names.forEach((n, i) => closes.set(n, results[i] ?? null));
    const outcomeFor = (m: Matchup) => {
      const bench = etfs.get(m.ticker) ?? "SPY";
      const a = closes.get(m.ticker);
      const b = closes.get(bench);
      const rawPct = a ? movePct(a, m.baseDate, m.exitDate) : null;
      const benchPct = b ? movePct(b, m.baseDate, m.exitDate) : null;
      return { rawPct, benchPct, benchmark: bench };
    };
    const byKey = new Map(forecasts.map((f) => [`rf:${f.id}`, f]));
    matchups = matchups.map((m) => {
      if (!(m.exitDate <= lastClosed) || (m.marketRawPct === null && m.marketAdjPct === null)) return m;
      const o = outcomeFor(m);
      if (o.rawPct === null) {
        unpriced++;
        return m;
      }
      priced++;
      const f = byKey.get(m.key)!;
      return buildForecastMatchup(f, hits.get(`${f.card_id}|${f.ticker}`) ?? null, optFor(f.ticker, m.baseDate), o);
    });
  }
  return { matchups, ledgerRows: rows.length, priced, unpriced };
}

/* ------------------------------------------------------------------ shaping */

const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : round(x, d));
const share = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : round(x * 100, 1));

function rateOut(r: RateSummary) {
  return { n: r.n, hits: r.k, rate_pct: share(r.rate), ci95_pct: r.ci ? [share(r.ci.lo), share(r.ci.hi)] : null, p_vs_coin: r.n ? round(r.p, 3) : null };
}

function ciOut(c: MeanCi | null, d = 2) {
  if (!c) return null;
  return { n: c.n, mean: pct(c.mean, d), median: pct(c.median, d), ci95: c.lo === null || c.hi === null ? null : [pct(c.lo, d), pct(c.hi, d)], clusters: c.clusters };
}

/**
 * The earnings matchups' section (no direction): Falcon's estimate and the straddle against the realized reaction-day
 * move (beyond the sector ETF when the row is in abnormal units, the engine's default), overall and by sector (the
 * benchmark ETF). Null without earnings matchups. Pure.
 */
export function shapeEarnings(ms: readonly Matchup[], dteOf: ReadonlyMap<string, number> = new Map()) {
  const earn = ms.filter((m) => m.kind === "earnings");
  if (!earn.length) return null;
  const s = summarize(earn);
  /** The realized move in the row's scoring units. */
  const real = (m: Matchup) => (m.units === "abnormal" ? m.realizedAbnPct : m.realizedRawPct);
  const matured = earn.filter((m) => real(m) !== null);
  const sized = matured.filter((m) => m.falconAbsPct !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sectors = new Map<string, Matchup[]>();
  for (const m of matured) {
    const k = m.benchmark ?? "SPY";
    sectors.set(k, [...(sectors.get(k) ?? []), m]);
  }
  const bySector = [...sectors]
    .map(([etf, list]) => {
      const g = summarize(list);
      return {
        sector: SECTOR_OF[etf] ?? etf,
        etf,
        n: list.length,
        with_falcon_size: g.magnitude.n,
        falcon_mae_pct: pct(g.magnitude.falconMae),
        market_mae_pct: pct(g.magnitude.marketMae),
        falcon_minus_market_err: ciOut(g.magnitude.diff),
        falcon_closer_pct: share(g.magnitude.falconCloser.rate),
        realized_over_implied_median: pct(g.byKind[0]?.ratioMedian ?? null, 3),
        ...(list.length < MIN_SAMPLE.group ? { warning: `only ${list.length} releases (fewer than ${MIN_SAMPLE.group})` } : {}),
      };
    })
    .sort((a, b) => b.n - a.n);
  // The straddle's days to expiry: a weekly one (7 days or less) prices little beyond the reaction; a later one prices more days.
  const byExpiry = (
    [
      ["expiry within 7 days (mostly the reaction week: the cleanest comparison)", (d: number) => d <= 7],
      ["expiry more than 7 days out (prices days after the reaction too)", (d: number) => d > 7],
    ] as const
  )
    .map(([label, ok]) => {
      const list = matured.filter((m) => dteOf.has(m.key) && ok(dteOf.get(m.key)!));
      if (!list.length) return null;
      const g = summarize(list);
      return { straddle_expiry: label, n: list.length, falcon_mae_pct: pct(g.magnitude.falconMae), market_mae_pct: pct(g.magnitude.marketMae), falcon_minus_market_err: ciOut(g.magnitude.diff), falcon_closer: rateOut(g.magnitude.falconCloser), realized_over_implied_median: pct(g.byKind[0]?.ratioMedian ?? null, 3) };
    })
    .filter((x) => x !== null);
  const byYear: Record<string, number> = {};
  for (const m of earn) byYear[m.exitDate.slice(0, 4)] = (byYear[m.exitDate.slice(0, 4)] ?? 0) + 1;
  return {
    what: "Past earnings releases: Falcon's earnings-move estimate (mean |reaction-day move beyond the sector ETF| over the company's 4 to 8 earlier releases) vs the options market's pre-earnings ATM straddle ((call + put) / spot, 15:45 New York on the session before the reaction, first expiry covering it) vs the realized reaction-day move beyond the sector ETF (close before the release to the reaction day's close). No direction. realized_over_implied and the straddle returns use the stock's own move.",
    sample: { releases: earn.length, tickers: new Set(earn.map((m) => m.ticker)).size, matured: s.matured, pending: s.pending, with_falcon_estimate: sized.length, reaction_days_by_year: byYear },
    averages_pct: { realized_abs: pct(mean(matured.map((m) => Math.abs(real(m)!)))), market_implied: pct(mean(matured.map((m) => m.marketRawPct!).filter((x) => Number.isFinite(x)))), falcon_estimate: pct(mean(sized.map((m) => m.falconAbsPct!))) },
    size: { n: s.magnitude.n, falcon_mae_pct: pct(s.magnitude.falconMae), market_mae_pct: pct(s.magnitude.marketMae), falcon_minus_market_err: ciOut(s.magnitude.diff), falcon_closer: rateOut(s.magnitude.falconCloser) },
    realized_over_implied: ciOut(s.ratio, 3),
    moved_more_than_implied: rateOut(s.exceeded),
    long_straddle_return_implied_units: ciOut(s.pnl.straddle, 3),
    straddle_on_falcon_side: ciOut(s.pnl.falconSideStraddle, 3),
    by_straddle_expiry: byExpiry,
    by_sector: bySector,
    warnings: s.warnings,
    caveats: [
      "The straddle's expiry can be later than the reaction day (the first listed one on or after it): it then prices days after the release too and overstates the reaction-day move, most for names with monthly expiries only. by_straddle_expiry separates them: read the 7-days-or-less group as the fair comparison and say what it shows.",
      "Falcon's estimate here is a simple trailing average of the company's own past reactions, not a model; it needs 4 earlier releases, so the first releases of each company have none.",
      "The straddle prices the stock's whole move, the scores compare it with the move beyond the sector ETF: the market part of a reaction day (usually small next to the earnings move) is left out of the realized side.",
      "Intervals are clustered by session; one earnings season shares market shocks.",
    ],
  };
}

/** The tool's answer from a set of matchups (pure). */
export function shapeScoreboard(all: readonly Matchup[], q: ScoreboardQuery, meta: { source: string; ledgerRows?: number; nowMs: number; dte?: ReadonlyMap<string, number> }) {
  const picked = all.filter((m) => (!q.ticker || m.ticker === q.ticker || m.ticker === q.ticker.replace("-", ".")) && (!q.tier || m.tier === q.tier));
  const earnings = q.kind === "forecast" ? null : shapeEarnings(picked, meta.dte);
  // The two kinds are in different units: the main figures are one kind's (forecasts unless asked for earnings).
  const ms = picked.filter((m) => m.kind === (q.kind ?? "forecast"));
  const s = summarize(ms);
  const pending = ms.filter((m) => (m.marketRawPct !== null || m.marketAdjPct !== null) && m.realizedRawPct === null && m.realizedAbnPct === null);
  const schedule: Record<string, number> = {};
  for (const m of pending) schedule[m.exitDate] = (schedule[m.exitDate] ?? 0) + 1;
  const withMkt = ms.filter((m) => m.marketRawPct !== null || m.marketAdjPct !== null);
  const directional = withMkt.filter((m) => m.falconSign !== 0).length;
  const sized = withMkt.filter((m) => m.falconAbsPct !== null).length;
  const examples = withMkt
    .filter((m) => m.falconSign !== 0)
    .slice(0, 8)
    .map((m) => ({
      ticker: m.ticker,
      label: m.tier,
      falcon: m.falconSign > 0 ? "up" : "down",
      horizon_sessions: m.horizonSessions,
      // Falcon's size is a move beyond the benchmark: compare it with the market's move beyond the market, never with the raw one.
      falcon_size_beyond_benchmark_pct: pct(m.falconAbsPct),
      market_beyond_market_pct: pct(m.marketAdjPct),
      market_total_move_pct: pct(m.marketRawPct),
      measured_from: m.baseDate,
      matures: m.exitDate,
      realized_vs_benchmark_pct: pct(m.realizedAbnPct),
    }));
  const group = (g: (typeof s.byTier)[number]) => ({ label: g.label, n: g.n, direction: rateOut(g.direction), falcon_mae_pct: pct(g.falconMae), market_mae_pct: pct(g.marketMae), realized_over_implied_median: pct(g.ratioMedian) });
  return {
    source: meta.source,
    as_of: new Date(meta.nowMs).toISOString(),
    filters: { ticker: q.ticker, tier: q.tier, kind: q.kind ?? "forecast" },
    sample: {
      forecasts: s.total,
      ...(meta.ledgerRows !== undefined ? { ledger_rows: meta.ledgerRows } : {}),
      with_market_number: s.withMarket,
      without_market_number: s.total - s.withMarket,
      directional_with_market: directional,
      with_falcon_size: sized,
      matured: s.matured,
      pending: s.pending,
      next_maturity: s.nextMaturity,
      maturing: schedule,
    },
    direction: { ...rateOut(s.direction), always_majority_sign_pct: share(s.direction.majorityBaseline), majority_sign: s.direction.majoritySign === 1 ? "up" : s.direction.majoritySign === -1 ? "down" : null, market_baseline: "the options market prices no direction: 50% is its score" },
    size: {
      n: s.magnitude.n,
      falcon_mae_pct: pct(s.magnitude.falconMae),
      market_mae_pct: pct(s.magnitude.marketMae),
      falcon_minus_market_err: ciOut(s.magnitude.diff),
      falcon_closer: rateOut(s.magnitude.falconCloser),
    },
    realized_over_implied: ciOut(s.ratio, 3),
    moved_more_than_implied: rateOut(s.exceeded),
    pnl_proxies_implied_move_units: { directional: ciOut(s.pnl.directional, 3), long_straddle: ciOut(s.pnl.straddle, 3), straddle_on_falcon_side: ciOut(s.pnl.falconSideStraddle, 3) },
    by_label: s.byTier.map(group),
    by_confidence: s.byConfidence.map(group),
    by_kind: s.byKind.map(group),
    examples_pending: s.matured ? undefined : examples,
    ...(earnings ? { earnings } : {}),
    warnings: s.warnings,
    min_sample: MIN_SAMPLE,
    method: [
      "One matchup per Falcon forecast (first ledger row per event, stock and horizon), measured from the close of the last session completed when it was made to the close N sessions later.",
      "Market's number: ATM implied volatility of that session's OPRA snapshot (15:45 New York), interpolated in total variance to the horizon, x sqrt(N/252) x sqrt(2/pi) = expected absolute move; 'beyond the market' removes beta^2 x VIX^2. Earnings: the pre-earnings ATM straddle, (call + put) / spot.",
      "Direction: realized move minus the sector ETF (SPY when none); a hit when its sign matches Falcon's. Size: |realized| vs Falcon's expected size (its record's mean |move beyond the benchmark|) and vs the market's move beyond the market. When comparing Falcon's size with the market's in an example, use market_beyond_market_pct (same units), not market_total_move_pct.",
      "Intervals: Wilson for rates, clustered by base session for means (names measured over the same closes share market moves). P&L proxies have no costs or spreads.",
    ],
  };
}

/* ------------------------------------------------------------------ run */

const cache = new TtlCache<unknown>(10 * 60_000, 50);

export function resetScoreboard(): void {
  cache.clear();
}

/** The tool's result. Throws ToolError for bad input. */
export async function scoreboardTool(input: unknown, store: ScoreboardStore, signal: AbortSignal, nowMs = Date.now()): Promise<unknown> {
  const q = parseScoreboardInput(input);
  const key = JSON.stringify(q);
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = await store.matchups(signal);
  let out: unknown;
  if (rows && rows.length) {
    const dte = new Map<string, number>();
    for (const r of rows) {
      const st = r.straddle as { dte?: unknown } | null | undefined;
      const d = num(st?.dte);
      if (d !== null) dte.set(String(r.key), d);
    }
    out = shapeScoreboard(rows.map(matchupFromRow), q, { source: "Falcon forecast_matchups table", nowMs, dte });
  } else {
    const live = await liveMatchups(store, nowMs, signal);
    out = shapeScoreboard(live.matchups, q, { source: "Computed live from Falcon's forecast ledger, Sightings cards and stored options snapshots (forecast_matchups not yet populated)", ledgerRows: live.ledgerRows, nowMs });
    if (live.unpriced) (out as { warnings: string[] }).warnings.push(`${live.unpriced} matured matchups had no closes to measure and are counted as pending.`);
  }
  cache.set(key, out);
  return out;
}

/** Runs one falcon_scoreboard call. Never throws. */
export async function runScoreboardTool(input: unknown, ctx: DeskToolContext & { store?: ScoreboardStore; nowMs?: number } = {}): Promise<DeskToolOutcome> {
  const started = Date.now();
  const label = scoreboardLabel(input, "done");
  const signal = deadline(ctx, Math.max(ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, 15_000));
  try {
    const result = await scoreboardTool(input, ctx.store ?? supabaseScoreboardStore(), signal, ctx.nowMs);
    return { name: SCOREBOARD_TOOL_NAME, ok: true, content: fitResult(result), label, ms: Date.now() - started };
  } catch (err) {
    const known = err instanceof ToolError;
    if (!known) console.error("[desk/scoreboard]", JSON.stringify({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: Date.now() - started }));
    const message = known
      ? (err as Error).message
      : signal.aborted
        ? "Falcon's scoreboard did not answer in time. Try again, or answer without it and say so."
        : "Falcon's scoreboard is unavailable right now. Answer without it and say so.";
    return { name: SCOREBOARD_TOOL_NAME, ok: false, content: JSON.stringify({ error: message }), label, ms: Date.now() - started };
  }
}
