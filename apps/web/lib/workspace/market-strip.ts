/**
 * The Dashboard's market strip: SPY, QQQ, VIX and the 10-year yield in one
 * thin row, with the session and the New York time on the right.
 * "SPY 739.15 −0.1%   QQQ 663.38 +0.2%   VIX 22.92 +0.01   10Y 5.13% +0.01   Pre-market · 9:12 ET"
 *
 * Data: Yahoo Finance's v7 quote (GET /api/market, which reads it through
 * lib/desk/tools/yahoo.ts). Session: the NYSE calendar in
 * packages/engine/src/study/abnormal.ts (holidays, 13:00 early closes), as for
 * the market chip (./market-status.ts). Extended hours run 04:00 to the open
 * and the close to 20:00 New York, the hours Yahoo prints pre/post prices for.
 *
 * Colour rule: SPY and QQQ green when up, red when down. VIX inverted (a rise
 * is red, more fear; a fall green). The 10Y neutral (a rising yield is not
 * good or bad by itself). A change that rounds to zero is neutral.
 *
 * Pure: the instant and the quotes are parameters.
 */

import { isNyseEarlyClose, isNyseSession, nyInstantMs } from "../../../../packages/engine/src/study/abnormal.ts";
import { nyOffsetMs } from "../../../../packages/engine/src/edgar-time.ts";
import { CLOSE_MIN, EARLY_CLOSE_MIN, OPEN_MIN, nyDate } from "./market-status";

export const STRIP_KEYS = ["SPY", "QQQ", "VIX", "TNX"] as const;
export type StripKey = (typeof STRIP_KEYS)[number];

/** Yahoo's symbol for each item. */
export const YAHOO_SYMBOL: Record<StripKey, string> = { SPY: "SPY", QQQ: "QQQ", VIX: "^VIX", TNX: "^TNX" };

/** The label shown before each value. */
export const STRIP_LABEL: Record<StripKey, string> = { SPY: "SPY", QQQ: "QQQ", VIX: "VIX", TNX: "10Y" };

/** One price with its change from the previous regular close; `time` in epoch ms. */
export type Leg = { price: number; change: number | null; changePct: number | null; time: number | null };

/** One symbol: the regular session's last price, and the pre/post-market prints when Yahoo has them. */
export type StripQuote = { regular: Leg | null; pre: Leg | null; post: Leg | null };

/** GET /api/market. `quotes[k]` is null when Yahoo had no row for it; `stale` when Yahoo failed and this is the last good answer. */
export type MarketStripData = {
  at: number;
  quotes: Record<StripKey, StripQuote | null>;
  source: string;
  stale?: boolean;
  error?: string;
};

export const MARKET_SOURCE = "Yahoo Finance quote";

/* ------------------------------------------------------------------ parse (server) */

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * ^TNX is the 10-year yield in percent (5.127 = 5.127%) in Yahoo's v7 quote
 * today; older feeds sent it times ten (51.27). A yield of 20% or more is read
 * as the times-ten form. Returns the divisor.
 */
export function tnxScale(price: number | null): number {
  return price !== null && price >= 20 ? 10 : 1;
}

function leg(row: Record<string, unknown>, prefix: "regularMarket" | "preMarket" | "postMarket", scale: number, base: number | null): Leg | null {
  const price = fin(row[`${prefix}Price`]);
  if (price === null || price <= 0) return null;
  let change = fin(row[`${prefix}Change`]);
  let changePct = fin(row[`${prefix}ChangePercent`]);
  // Pre/post change measured from the regular close when Yahoo leaves it out.
  if (change === null && base !== null) change = price - base;
  if (changePct === null && change !== null && base) changePct = (change / base) * 100;
  const sec = fin(row[`${prefix}Time`]);
  return {
    price: price / scale,
    change: change === null ? null : change / scale,
    changePct,
    time: sec === null ? null : sec * 1000,
  };
}

/** A Yahoo v7 quote row to the strip's shape (^TNX to percent). Pure. */
export function stripQuoteFromYahoo(key: StripKey, row: Record<string, unknown>): StripQuote {
  const scale = key === "TNX" ? tnxScale(fin(row.regularMarketPrice)) : 1;
  const regular = leg(row, "regularMarket", scale, null);
  const base = fin(row.regularMarketPrice);
  const extended = key === "SPY" || key === "QQQ";
  return {
    regular,
    pre: extended ? leg(row, "preMarket", 1, base) : null,
    post: extended ? leg(row, "postMarket", 1, base) : null,
  };
}

/* ------------------------------------------------------------------ session */

export type StripSession = "pre" | "open" | "post" | "closed";

export const PRE_START_MIN = 4 * 60;
export const POST_END_MIN = 20 * 60;
/** After hours on a 13:00 close day end at 17:00. */
export const EARLY_POST_END_MIN = 17 * 60;

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** New York wall clock "9:12", "17:05". */
export function nyClock(ms: number): string {
  const d = new Date(ms + nyOffsetMs(ms));
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** The NYSE session (with extended hours) at an instant. */
export function stripSession(nowMs: number): StripSession {
  const today = nyDate(nowMs);
  if (!isNyseSession(today)) return "closed";
  const early = isNyseEarlyClose(today);
  const at = (min: number) => nyInstantMs(today, min);
  if (nowMs < at(PRE_START_MIN)) return "closed";
  if (nowMs < at(OPEN_MIN)) return "pre";
  if (nowMs < at(early ? EARLY_CLOSE_MIN : CLOSE_MIN)) return "open";
  if (nowMs < at(early ? EARLY_POST_END_MIN : POST_END_MIN)) return "post";
  return "closed";
}

const SESSION_WORD: Record<StripSession, string> = { pre: "Pre-market", open: "Open", post: "After hours", closed: "Closed" };

/** "Pre-market · 9:12 ET", "Open · 11:40 ET", "After hours · 17:05 ET", "Closed · Sat 10:12 ET" (closed names the weekday). */
export function sessionLabel(nowMs: number, session: StripSession = stripSession(nowMs)): string {
  const day = session === "closed" ? `${WEEKDAY[new Date(nowMs + nyOffsetMs(nowMs)).getUTCDay()]} ` : "";
  return `${SESSION_WORD[session]} · ${day}${nyClock(nowMs)} ET`;
}

/** Poll every 15 s while anything trades (pre, open, after hours), every 5 min when closed. */
export function pollMs(session: StripSession): number {
  return session === "closed" ? 5 * 60_000 : 15_000;
}

/* ------------------------------------------------------------------ pick + format */

export type LegKind = "regular" | "pre" | "post";

/**
 * The price to show. Pre-market and after hours: SPY/QQQ's extended print
 * when Yahoo has one newer than the regular close; else the last regular
 * price (the last close outside the session).
 */
export function pickLeg(q: StripQuote | null, session: StripSession): { leg: Leg; kind: LegKind } | null {
  if (!q) return null;
  const closeAt = q.regular?.time ?? 0;
  const fresh = (l: Leg | null) => l !== null && (l.time === null || l.time >= closeAt);
  if (session === "pre" && fresh(q.pre)) return { leg: q.pre!, kind: "pre" };
  if (session === "post" && fresh(q.post)) return { leg: q.post!, kind: "post" };
  return q.regular ? { leg: q.regular, kind: "regular" } : null;
}

export type Tone = "up" | "down" | "flat";

/** The colour of a change: SPY/QQQ green up, red down; VIX inverted; 10Y always neutral; zero neutral. */
export function changeTone(key: StripKey, sign: number): Tone {
  if (key === "TNX" || sign === 0) return "flat";
  const good = key === "VIX" ? sign < 0 : sign > 0;
  return good ? "up" : "down";
}

const MINUS = "−";
export const MISSING = "—";

function fixed(x: number, digits: number): string {
  return Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A signed number at `digits` decimals ("+0.4", "−1.80", "0.0"), and the sign of what is shown. */
export function signed(x: number, digits: number): { text: string; sign: -1 | 0 | 1 } {
  const r = Math.round(x * 10 ** digits);
  if (r === 0) return { text: fixed(0, digits), sign: 0 };
  return { text: `${r > 0 ? "+" : MINUS}${fixed(x, digits)}`, sign: r > 0 ? 1 : -1 };
}

/** The value as shown: "739.15", "22.92", "5.13%". */
export function formatValue(key: StripKey, price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return MISSING;
  return key === "TNX" ? `${fixed(price, 2)}%` : fixed(price, 2);
}

/** The change as shown: SPY/QQQ in percent at 1 decimal, VIX in points and the 10Y in percentage points at 2. */
export function formatChange(key: StripKey, l: Leg | null | undefined): { text: string; tone: Tone } {
  const x = !l ? null : key === "SPY" || key === "QQQ" ? l.changePct : l.change;
  if (x === null || x === undefined || !Number.isFinite(x)) return { text: MISSING, tone: "flat" };
  const s = key === "SPY" || key === "QQQ" ? signed(x, 1) : signed(x, 2);
  return { text: key === "SPY" || key === "QQQ" ? `${s.text}%` : s.text, tone: changeTone(key, s.sign) };
}

export type StripItem = { key: StripKey; label: string; value: string; change: string; tone: Tone; kind: LegKind | null; title: string };

const KIND_WORD: Record<LegKind, string> = { regular: "last price", pre: "pre-market", post: "after hours" };

/** One item of the strip, ready to render. */
export function stripItem(key: StripKey, q: StripQuote | null, session: StripSession): StripItem {
  const picked = pickLeg(q, session);
  const value = formatValue(key, picked?.leg.price);
  const change = formatChange(key, picked?.leg);
  const label = STRIP_LABEL[key];
  const unit = key === "TNX" ? " pp" : key === "VIX" ? " pts" : "";
  const title = picked
    ? `${label} ${KIND_WORD[picked.kind]} ${value}, ${change.text}${change.text === MISSING ? "" : unit} vs the previous close`
    : `${label}: no quote`;
  return { key, label, value, change: change.text, tone: change.tone, kind: picked?.kind ?? null, title };
}
