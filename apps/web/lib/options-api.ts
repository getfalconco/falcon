import type { RippleOptions } from "@falcon/ripple";
import { canSeeOptions, type OptionsDisplay } from "./sightings-options";

/**
 * /api/options: options data (OPRA via Databento) for every liquid ticker of
 * the universe, priced once a trading day by the engine's options-daily job
 * (packages/engine/src/options/daily.ts) and stored in Supabase
 * public.options_daily. Same display rule as the Sightings options blocks
 * (OPTIONS_DISPLAY, lib/sightings-options.ts): viewers the mode does not
 * allow get the empty shapes below.
 *
 *   GET /api/options?all=1        -> OptionsAll     (compact, every ticker; ~150 KB)
 *   GET /api/options?ticker=NVDA  -> OptionsTicker  (the card block + IV history)
 *   GET /api/options?earnings=1   -> OptionsEarnings (stored pre-earnings straddles, last sessions)
 *
 * Numbers are in the card block's units: vol points and percent (atmIv 42.1
 * = 42.1% annualised; im5 3.2 = an expected absolute move of 3.2% over 5
 * sessions). Pure types and helpers here; safe to import from client code.
 */

/** One ticker in the compact map. Optional keys are omitted when unknown. */
export type OptionsCompact = {
  /** ATM implied volatility, 30 days, vol points. */
  atmIv: number;
  /** Percentile (0-100) of atmIv among this ticker's stored days; omitted under 20 days of history. */
  ivPct?: number;
  /** Implied absolute move over 5 / 20 sessions, percent (null without an expiry covering the window). */
  im5: number | null;
  im20: number | null;
  /** The same beyond the market (beta^2 x VIX^2 taken out of the variance). */
  im5adj?: number;
  im20adj?: number;
  /** Put-minus-call skew, vol points. */
  skew?: number;
  /** Call-minus-put IV spread, vol points. */
  cp?: number;
  /** Snapshot instant (ISO; 15:45 New York of the session). */
  asOf: string;
};

export type OptionsAll = {
  /** Newest session date in the map (YYYY-MM-DD), null when empty. */
  asOf: string | null;
  source: "OPRA via Databento";
  count: number;
  tickers: Record<string, OptionsCompact>;
};

export type OptionsTicker = {
  ticker: string;
  /** Session date of `options` (YYYY-MM-DD), null when none. */
  date: string | null;
  /** The card block (no hit history comparison), with ivPct when known; null when the ticker has no stored chain. */
  options: RippleOptions | null;
  /** Stored days behind ivPct. */
  ivDays: number;
  /** ATM IV per stored session, oldest first (up to ~90 days). */
  history: Array<{ date: string; atmIv: number }>;
};

export const OPTIONS_SOURCE = "OPRA via Databento" as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The compact entry of a stored block (null when the block has no ATM IV). Pure. */
export function compactOf(block: RippleOptions | null | undefined, ivPct?: number | null): OptionsCompact | null {
  if (!block || num(block.atmIv) === null) return null;
  const out: OptionsCompact = {
    atmIv: block.atmIv,
    im5: num(block.impliedMove5?.rawPct) ?? null,
    im20: num(block.impliedMove20?.rawPct) ?? null,
    asOf: block.asOf,
  };
  const pct = num(ivPct) ?? num(block.ivPct);
  if (pct !== null) out.ivPct = pct;
  const a5 = num(block.impliedMove5?.marketAdjustedPct);
  if (a5 !== null) out.im5adj = a5;
  const a20 = num(block.impliedMove20?.marketAdjustedPct);
  if (a20 !== null) out.im20adj = a20;
  const sk = num(block.skew);
  if (sk !== null) out.skew = sk;
  const cp = num(block.cpSpread);
  if (cp !== null) out.cp = cp;
  return out;
}

export function emptyAll(): OptionsAll {
  return { asOf: null, source: OPTIONS_SOURCE, count: 0, tickers: {} };
}

export function emptyTicker(ticker: string): OptionsTicker {
  return { ticker, date: null, options: null, ivDays: 0, history: [] };
}

/** The all-tickers payload as this viewer may see it (OPTIONS_DISPLAY). Pure. */
export function allForViewer(payload: OptionsAll, mode: OptionsDisplay, isAdmin: boolean): OptionsAll {
  return canSeeOptions(mode, isAdmin) ? payload : emptyAll();
}

/** The one-ticker payload as this viewer may see it (OPTIONS_DISPLAY). Pure. */
export function tickerForViewer(payload: OptionsTicker, mode: OptionsDisplay, isAdmin: boolean): OptionsTicker {
  return canSeeOptions(mode, isAdmin) ? payload : emptyTicker(payload.ticker);
}

// ---------------------------------------------------------------------------
// Client helpers (browser or server; same-origin by default)

/** Every ticker's compact options numbers; an empty map on any error. */
export async function fetchOptionsAll(init?: RequestInit, base = ""): Promise<OptionsAll> {
  try {
    const res = await fetch(`${base}/api/options?all=1`, { credentials: "same-origin", ...init });
    if (!res.ok) return emptyAll();
    const body = (await res.json()) as OptionsAll;
    return body && typeof body.tickers === "object" && body.tickers ? body : emptyAll();
  } catch {
    return emptyAll();
  }
}

/** One ticker's card block and IV history; the empty shape on any error. */
export async function fetchTickerOptions(ticker: string, init?: RequestInit, base = ""): Promise<OptionsTicker> {
  const t = ticker.trim().toUpperCase();
  try {
    const res = await fetch(`${base}/api/options?ticker=${encodeURIComponent(t)}`, { credentials: "same-origin", ...init });
    if (!res.ok) return emptyTicker(t);
    const body = (await res.json()) as OptionsTicker;
    return body && body.ticker ? body : emptyTicker(t);
  } catch {
    return emptyTicker(t);
  }
}

/** ATM IV (vol points) per ticker from the compact map, e.g. for an implied-vol filter. Pure. */
export function ivByTicker(all: OptionsAll): Map<string, number> {
  return new Map(Object.entries(all.tickers).map(([t, o]) => [t, o.atmIv]));
}

// ---------------------------------------------------------------------------
// Upcoming earnings: the stored pre-earnings straddles

/** When a release lands (engine options/earnings-straddle.ts EarningsTime). */
export type EarningsTimeOfDay = "before_open" | "during" | "after_close" | "unknown";

/**
 * One stored pre-earnings ATM straddle (options_daily.metrics.earnings_straddle,
 * written by the daily job on the last session before the release can move
 * the stock): the release date Yahoo gave and what the options priced for it.
 */
export type OptionsEarningsRelease = {
  ticker: string;
  /** Release date, New York (YYYY-MM-DD). */
  date: string;
  time: EarningsTimeOfDay;
  /** The first session that can react. */
  reactionDay: string;
  /** Straddle implied move, percent of spot (10.2 = ±10.2%). */
  movePct: number;
  /** The session of the snapshot (YYYY-MM-DD). */
  session: string;
  /** Snapshot instant (ISO); the session date when the store has none. */
  asOf: string;
};

export type OptionsEarnings = { source: "OPRA via Databento"; releases: OptionsEarningsRelease[] };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const TIMES: readonly EarningsTimeOfDay[] = ["before_open", "during", "after_close", "unknown"];

export function emptyEarnings(): OptionsEarnings {
  return { source: OPTIONS_SOURCE, releases: [] };
}

/** A stored straddle as a release row; null when any field is missing or off. Pure. */
export function earningsReleaseOf(ticker: string, session: string, straddle: unknown): OptionsEarningsRelease | null {
  if (!straddle || typeof straddle !== "object") return null;
  const s = straddle as Record<string, unknown>;
  const move = num(s.implied_move);
  const date = typeof s.earnings_date === "string" && YMD.test(s.earnings_date) ? s.earnings_date : null;
  const reaction = typeof s.reaction_day === "string" && YMD.test(s.reaction_day) ? s.reaction_day : null;
  if (move === null || !(move > 0) || !date || !reaction || !YMD.test(session)) return null;
  const time = TIMES.includes(s.earnings_time as EarningsTimeOfDay) ? (s.earnings_time as EarningsTimeOfDay) : "unknown";
  return {
    ticker: ticker.toUpperCase(),
    date,
    time,
    reactionDay: reaction,
    movePct: Math.round(move * 1000) / 10,
    session,
    asOf: typeof s.as_of === "string" ? s.as_of : session,
  };
}

/** The payload as this viewer may see it (OPTIONS_DISPLAY). Pure. */
export function earningsForViewer(payload: OptionsEarnings, mode: OptionsDisplay, isAdmin: boolean): OptionsEarnings {
  return canSeeOptions(mode, isAdmin) ? payload : emptyEarnings();
}

/** Stored pre-earnings straddles of the last few sessions; empty on any error. */
export async function fetchOptionsEarnings(init?: RequestInit, base = ""): Promise<OptionsEarnings> {
  try {
    const res = await fetch(`${base}/api/options?earnings=1`, { credentials: "same-origin", ...init });
    if (!res.ok) return emptyEarnings();
    const body = (await res.json()) as OptionsEarnings;
    return body && Array.isArray(body.releases) ? body : emptyEarnings();
  } catch {
    return emptyEarnings();
  }
}
