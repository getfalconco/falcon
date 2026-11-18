/**
 * How fresh a falcon_options answer is, and the free same-day fallback when
 * Databento cannot serve the current session.
 *
 * Why a fallback: Databento's historical OPRA.PILLAR data for the running
 * session needs a live data licence. Without one, get_dataset_range ends at
 * the day's 09:30 New York open and a get_range past it answers HTTP 403
 * `license_not_found_unauthorized` (measured 2026-11-16 14:10 ET); the day's
 * quotes are published after the session. Falcon's daily job
 * (packages/engine/src/options/daily.ts) stores the 15:45 snapshot once they
 * are. Until then the newest Databento minute is the previous session's.
 *
 * Freshness rule: data is current when its as-of instant is at or after the
 * open of the latest NYSE session that has opened (pre-market, yesterday's
 * 15:45 is current; from 09:30 on, only today's quotes are). Older data is
 * `stale`. When the stored and Databento snapshots are stale, falcon_options
 * reads Yahoo Finance's options chain (delayed about 15 minutes; bid, ask,
 * last, volume, open interest and Yahoo's own IV per contract) and computes
 * every figure with the engine's math from the mid quotes (surface.ts,
 * cards.ts), never from Yahoo's IV, which is only reported next to Falcon's
 * for comparison. When even that fails, the answer is stale and says why;
 * with earnings within EARNINGS_WINDOW_DAYS it carries a warning the model
 * must pass on.
 *
 * Yahoo's terms forbid automated commercial use: a stand-in until a licensed
 * intraday source (a Databento live licence or another vendor) is in place.
 * Server-only apart from the pure helpers (tested in iv-fresh.test.ts).
 */

import type { OptionDefinition, Quote } from "../../../../../packages/engine/src/options/client.ts";
import { addDays, isNyseEarlyClose, nyInstantMs, nyseSessions } from "../../../../../packages/engine/src/study/abnormal.ts";
import { nextEarnings } from "./earnings";
import { nyParts, round } from "./util";
import { yahooOptions, yahooSummary, type YahooOptionChain, type YahooOptionContract } from "./yahoo";

export const YAHOO_OPTIONS_DATASET = "Yahoo Finance options chain (delayed ~15 min)";
export const yahooOptionsUrl = (t: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(t)}/options`;
/** Earnings this close (calendar days) make stale options data a warning, not a footnote. */
export const EARNINGS_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
/** Yahoo requests per answer (one per expiry). */
const MAX_SUMMARY_EXPIRIES = 16;
const MAX_FULL_EXPIRIES = 22;

/* ------------------------------------------------------------------ sessions and staleness */

export type SessionClock = {
  /** The latest NYSE session that has opened at `nowMs`. */
  date: string;
  openMs: number;
  closeMs: number;
  /** Between the open and the close. */
  inSession: boolean;
};

/** The session current data must belong to: the latest NYSE session whose open has passed. Pure. */
export function currentSession(nowMs: number): SessionClock | null {
  const today = nyParts(nowMs).date;
  const sessions = nyseSessions(addDays(today, -12), today);
  for (let i = sessions.length - 1; i >= 0; i--) {
    const date = sessions[i]!;
    const openMs = nyInstantMs(date, 9 * 60 + 30);
    if (openMs > nowMs) continue;
    const closeMs = nyInstantMs(date, isNyseEarlyClose(date) ? 13 * 60 : 16 * 60);
    return { date, openMs, closeMs, inSession: nowMs < closeMs };
  }
  return null;
}

/** Older than the current session's open. Pure. */
export function isStale(asOfMs: number, session: SessionClock | null): boolean {
  return session !== null && Number.isFinite(asOfMs) && asOfMs < session.openMs;
}

export type EarningsSoon = { date: string; time: "before_open" | "after_close" | "during" | "unknown"; daysAway: number; source: string };

/** Earnings from a Yahoo epoch (seconds) when within EARNINGS_WINDOW_DAYS of `nowMs` (today counts). Pure. */
export function earningsFromEpoch(epochS: number | null | undefined, nowMs: number, source: string): EarningsSoon | null {
  if (typeof epochS !== "number" || !Number.isFinite(epochS) || epochS <= 0) return null;
  const p = nyParts(epochS * 1000);
  const time = epochS % 86_400 === 0 ? "unknown" : p.minutes < 9 * 60 + 30 ? "before_open" : p.minutes >= 16 * 60 ? "after_close" : "during";
  return earningsSoon(epochS % 86_400 === 0 ? new Date(epochS * 1000).toISOString().slice(0, 10) : p.date, time, nowMs, source);
}

/** An earnings date as EarningsSoon when it is today or within EARNINGS_WINDOW_DAYS. Pure. */
export function earningsSoon(date: string | null, time: EarningsSoon["time"], nowMs: number, source: string): EarningsSoon | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = nyParts(nowMs).date;
  const daysAway = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS);
  return daysAway >= 0 && daysAway <= EARNINGS_WINDOW_DAYS ? { date, time, daysAway, source } : null;
}

/** Next earnings within the window from Yahoo's quote summary (when the chain could not tell). */
export async function loadEarningsSoon(t: string, nowMs: number, signal: AbortSignal): Promise<EarningsSoon | null> {
  const summary = await yahooSummary(t, "calendarEvents", signal).catch(() => null);
  const next = nextEarnings(summary, nyParts(nowMs).date);
  if (!next) return null;
  const time = next.time === "before_open" || next.time === "after_close" || next.time === "during" ? next.time : "unknown";
  return earningsSoon(next.date, time, nowMs, `Yahoo Finance calendar${next.estimated ? " (estimated date)" : ""}`);
}

/* ------------------------------------------------------------------ Yahoo's chain as engine inputs */

const expiryDate = (epochS: number) => new Date(epochS * 1000).toISOString().slice(0, 10);

/**
 * The expiries to read (epoch seconds), nearest first: for the summary, every
 * one within 100 days, the first past it and the ones nearest 180 and 365
 * days (ATM IV 30/60/90, the implied moves, skew and a term outline); for
 * term, smile and surface every one within 400 days. The asked smile expiry
 * is always included. At most 16 or 22, spread over the curve. Pure.
 */
export function yahooExpiriesToFetch(expiries: readonly number[], asOfMs: number, full: boolean, wanted: string | null = null): number[] {
  const days = (e: number) => (Date.parse(`${expiryDate(e)}T21:00:00Z`) - asOfMs) / DAY_MS;
  const live = [...new Set(expiries)].filter((e) => Number.isFinite(e) && days(e) >= 1 && days(e) <= 400).sort((a, b) => a - b);
  let pick: number[];
  if (full) pick = live;
  else {
    const near = live.filter((e) => days(e) <= 100);
    const set = new Set(near);
    const past = live.find((e) => days(e) > 100);
    if (past !== undefined) set.add(past);
    for (const target of [180, 365]) {
      const best = live.reduce<number | null>((a, b) => (a === null || Math.abs(days(b) - target) < Math.abs(days(a) - target) ? b : a), null);
      if (best !== null && days(best) > 100) set.add(best);
    }
    pick = [...set].sort((a, b) => a - b);
  }
  const max = full ? MAX_FULL_EXPIRIES : MAX_SUMMARY_EXPIRIES;
  if (pick.length > max) pick = Array.from({ length: max }, (_, i) => pick[Math.round((i * (pick.length - 1)) / (max - 1))]!);
  if (wanted) {
    const w = live.reduce<number | null>((a, b) => (a === null || Math.abs(Date.parse(expiryDate(b)) - Date.parse(wanted)) < Math.abs(Date.parse(expiryDate(a)) - Date.parse(wanted)) ? b : a), null);
    if (w !== null && !pick.includes(w)) pick = [...pick, w].sort((a, b) => a - b);
  }
  return [...new Set(pick)];
}

export type YahooInputs = {
  /** The quote's exchange time (delayed ~15 min), ms. */
  asOfMs: number;
  /** Yahoo's last price at the quote time (the stock quote can be fresher than the chain: prefer a minute bar at asOfMs). */
  spot: number;
  definitions: OptionDefinition[];
  quotes: Map<number, Quote>;
  /** Yahoo's own IV per contract (fraction), only to compare with Falcon's. */
  yahooIv: Map<number, number>;
  /** The next earnings date Yahoo carries with the quote (epoch seconds), when it does. */
  earningsEpoch: number | null;
  marketState: string | null;
  delayMinutes: number | null;
};

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Yahoo's chains (one per expiry, with the quote) as the engine's
 * definitions and quotes: one synthetic instrument id per contract, the
 * quote stamped at the underlying quote's time (Yahoo gives no per-contract
 * quote time; the whole chain is delayed alike). Null without a quote time
 * or price. Pure.
 */
export function yahooInputs(t: string, chains: ReadonlyArray<YahooOptionChain | null>, nowMs: number): YahooInputs | null {
  const head = chains.find((c) => c?.quote) ?? null;
  const q = (head?.quote ?? {}) as Record<string, unknown>;
  const timeS = finite(q.regularMarketTime);
  const spot = finite(q.regularMarketPrice);
  if (timeS === null || spot === null || !(spot > 0)) return null;
  const delay = finite(q.exchangeDataDelayedBy);
  // Yahoo's stock quote can be real time while the option quotes are delayed (~15 min): the chain's time is the
  // latest option trade, at least the quote time minus the delay, never after the quote time.
  let lastTradeS = 0;
  for (const c of chains) for (const o of c?.options ?? []) for (const x of [...(o.calls ?? []), ...(o.puts ?? [])]) lastTradeS = Math.max(lastTradeS, finite(x.lastTradeDate) ?? 0);
  const quoteMs = Math.min(timeS * 1000, nowMs);
  const asOfMs = Math.min(quoteMs, Math.max(lastTradeS * 1000, quoteMs - (delay !== null && delay > 0 ? delay : 15) * 60_000));
  const definitions: OptionDefinition[] = [];
  const quotes = new Map<number, Quote>();
  const yahooIv = new Map<number, number>();
  const seen = new Set<string>();
  let id = 1;
  const add = (c: YahooOptionContract, right: "C" | "P", expEpoch: number) => {
    const strike = finite(c.strike);
    if (strike === null || !(strike > 0)) return;
    const expiration = expiryDate(finite(c.expiration) ?? expEpoch);
    const key = `${expiration}|${right}|${strike}`;
    if (seen.has(key)) return;
    seen.add(key);
    const instrumentId = id++;
    definitions.push({ instrumentId, rawSymbol: c.contractSymbol ?? key, underlying: t, right, strike, expirationMs: Date.parse(`${expiration}T00:00:00Z`), expiration, multiplier: 100 });
    const bid = finite(c.bid);
    const ask = finite(c.ask);
    if (bid !== null || ask !== null) quotes.set(instrumentId, { instrumentId, tsMs: asOfMs, bid: bid !== null && bid > 0 ? bid : bid === 0 ? 0 : null, ask: ask !== null && ask > 0 ? ask : null, bidSize: 0, askSize: 0 });
    const iv = finite(c.impliedVolatility);
    if (iv !== null && iv > 0.0001) yahooIv.set(instrumentId, iv);
  };
  for (const c of chains) {
    for (const o of c?.options ?? []) {
      const exp = finite(o.expirationDate);
      if (exp === null) continue;
      for (const x of o.calls ?? []) add(x, "C", exp);
      for (const x of o.puts ?? []) add(x, "P", exp);
    }
  }
  return {
    asOfMs,
    spot,
    definitions,
    quotes,
    yahooIv,
    earningsEpoch: finite(q.earningsTimestampStart) ?? finite(q.earningsTimestamp),
    marketState: typeof q.marketState === "string" ? q.marketState : null,
    delayMinutes: delay,
  };
}

export type YahooIvCheck = { expiration: string; days: number; falconPct: number; yahooPct: number; diffPts: number };

/**
 * Yahoo's own ATM IV next to Falcon's for the expiry nearest 30 days: the
 * mean of Yahoo's call and put IV at the two strikes around spot,
 * interpolated to spot (as surface.ts atmIvOf does with Falcon's). Pure.
 */
export function yahooIvCheck(
  inputs: Pick<YahooInputs, "definitions" | "yahooIv">,
  spot: number,
  term: ReadonlyArray<{ expiration: string; days: number; iv: number }>,
): YahooIvCheck | null {
  const near = term.filter((p) => p.days >= 2 && p.iv > 0);
  if (!near.length) return null;
  const pt = near.reduce((a, b) => (Math.abs(b.days - 30) < Math.abs(a.days - 30) ? b : a));
  const perStrike = new Map<number, number[]>();
  for (const d of inputs.definitions) {
    if (d.expiration !== pt.expiration) continue;
    const iv = inputs.yahooIv.get(d.instrumentId);
    if (iv === undefined) continue;
    const l = perStrike.get(d.strike) ?? [];
    l.push(iv);
    perStrike.set(d.strike, l);
  }
  const strikes = [...perStrike.entries()].filter(([, l]) => l.length === 2).map(([k, l]) => ({ k, iv: (l[0]! + l[1]!) / 2 })).sort((a, b) => a.k - b.k);
  const lo = [...strikes].reverse().find((s) => s.k <= spot);
  const hi = strikes.find((s) => s.k >= spot);
  if (!lo || !hi) return null;
  const y = hi.k === lo.k ? lo.iv : lo.iv + ((hi.iv - lo.iv) * (spot - lo.k)) / (hi.k - lo.k);
  const falconPct = round(pt.iv * 100, 1)!;
  const yahooPct = round(y * 100, 1)!;
  return { expiration: pt.expiration, days: round(pt.days, 1)!, falconPct, yahooPct, diffPts: round(yahooPct - falconPct, 1)! };
}

/** Reads Yahoo's chain for the expiries an answer needs. Null when Yahoo has no options for the ticker. */
export async function loadYahooChain(t: string, full: boolean, wanted: string | null, nowMs: number, signal: AbortSignal): Promise<YahooInputs | null> {
  const first = await yahooOptions(t, null, signal);
  if (!first) return null;
  const pre = yahooInputs(t, [first], nowMs);
  const asOfMs = pre?.asOfMs ?? nowMs;
  const want = yahooExpiriesToFetch(first.expirationDates ?? [], asOfMs, full, wanted);
  const firstExp = first.options?.[0]?.expirationDate;
  const rest = await Promise.all(want.filter((e) => e !== firstExp).map((e) => yahooOptions(t, e, signal).catch((err: unknown) => (signal.aborted ? Promise.reject(err) : null))));
  return yahooInputs(t, [first, ...rest], nowMs);
}
