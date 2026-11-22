/**
 * `flow(ticker, days, session?)`: volume delta (aggressor buy volume minus
 * aggressor sell volume) over the last 1 to 5 completed sessions, on demand,
 * from Databento XNAS.ITCH trades in regular hours (09:30 to 16:00 New York,
 * 13:00 on early-close days, plus 5 s so the closing cross is in).
 *
 * Side: Databento's `side` on a trade is the aggressor (B = buyer lifted the
 * offer, A = seller hit the bid, N = none), as the engine's flow study reads
 * it (packages/engine/src/options/flow.ts). Side-less prints in the opening
 * 2 s or at/after the close are the crosses; they count in volume, never in
 * the delta, and are left out of the large prints.
 *
 * Cost: one paid pull per ticker-session, priced first with get_cost; a pull
 * over DESK_FLOW_MAX_PULL_USD (default $0.40) is refused, and so is one that
 * would pass this caller's month cap (DESK_FLOW_MONTH_CAP_USD, default $10)
 * or the Databento month cap over every caller in public.options_spend
 * (OPTIONS_DAILY_MONTH_CAP_USD, default $110). Each charge is written to
 * options_spend as caller "desk-flow" before the download (a refund line if
 * Databento then refuses it). Session summaries are cached in memory for a
 * week per server instance, so a ticker-session is bought once; a download
 * keeps going after the tool's own deadline so the next ask is free.
 *
 * Sessions and close-to-close changes come from Yahoo's daily chart (also the
 * consolidated volume, for Nasdaq's share). Server-only.
 */

import { DatabentoError, databentoConfigured, getCost, getDatasetEnd, getRange, parseTrades, requestKey, type RangeRequest, type Trade } from "../../databento/client";
import { appendSpend, monthBounds, monthSpend, type SpendLine } from "../../databento/ledger";
import type { FieldSource } from "../citations";
import { barsFromChart } from "./history";
import { ToolError, TtlCache, addDays, cached, nyParts, round, type DeskToolContext } from "./util";
import { yahooChart } from "./yahoo";

export const FLOW_DATASET = "XNAS.ITCH";
export const FLOW_SCHEMA = "trades";
export const FLOW_CALLER = "desk-flow";
export const FLOW_MAX_DAYS = 5;
export const FLOW_NOTE =
  "Nasdaq (XNAS) prints only, ~10-15% of consolidated volume; excludes NYSE/other venues and dark pools; aggressor side per Nasdaq ITCH";
/** Earliest XNAS.ITCH date at Databento. */
export const FLOW_FIRST_DATE = "2018-05-01";

const DAY = 86_400_000;
/** A busy NVDA session (1M+ trades) is a 25-50 s download; it keeps going after the tool's own deadline. */
const PULL_TIMEOUT_MS = 90_000;
const CURVE_MIN = 30;
const TOP_PRINTS = 5;

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function flowCaps() {
  return {
    maxPullUsd: envUsd("DESK_FLOW_MAX_PULL_USD", 0.4),
    callerMonthUsd: envUsd("DESK_FLOW_MONTH_CAP_USD", 10),
    totalMonthUsd: envUsd("OPTIONS_DAILY_MONTH_CAP_USD", 110),
  };
}

/* ------------------------------------------------------------------ New York sessions */

/** The instant of a New York wall-clock time (minutes after midnight) on a date. */
export function nyInstantMs(date: string, minutes: number): number {
  const noonUtc = Date.parse(`${date}T12:00:00Z`);
  const offsetMin = nyParts(noonUtc).minutes - 12 * 60; // -300 (EST) or -240 (EDT)
  return Date.parse(`${date}T00:00:00Z`) + (minutes - offsetMin) * 60_000;
}

/** NYSE/Nasdaq early closes (13:00): July 3, December 24, the day after Thanksgiving. Pure. */
export function isEarlyClose(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if ((m === 7 && d === 3) || (m === 12 && d === 24)) return true;
  if (m !== 11) return false;
  const firstDow = new Date(Date.UTC(y, 10, 1)).getUTCDay(); // 0 Sunday
  const thanksgiving = 1 + ((4 - firstDow + 7) % 7) + 21;
  return d === thanksgiving + 1;
}

export function sessionBounds(date: string): { openMs: number; closeMs: number; closeMin: number } {
  const closeMin = isEarlyClose(date) ? 13 * 60 : 16 * 60;
  return { openMs: nyInstantMs(date, 9 * 60 + 30), closeMs: nyInstantMs(date, closeMin), closeMin };
}

function flowRequest(symbol: string, date: string): RangeRequest {
  const { openMs, closeMs } = sessionBounds(date);
  return { dataset: FLOW_DATASET, schema: FLOW_SCHEMA, symbols: [symbol], start: new Date(openMs).toISOString(), end: new Date(closeMs + 5_000).toISOString() };
}

const NY_HMS = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/* ------------------------------------------------------------------ one session (pure) */

export type SessionFlow = {
  date: string;
  trades: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** Side-less volume (crosses included). */
  unsignedVolume: number;
  openCross: number;
  closeCross: number;
  vwap: number | null;
  /** Last Nasdaq print of the session. */
  lastPrice: number | null;
  /** [bucket end "HH:MM", cumulative delta, last price] every 30 minutes. */
  curve: Array<[string, number, number | null]>;
  largest: Array<{ time: string; side: "buy" | "sell" | "none"; size: number; price: number }>;
  costUsd: number;
  partial?: string;
};

/** Session summary from its trades (any order). Pure. */
export function summarizeSession(date: string, trades: readonly Trade[]): Omit<SessionFlow, "costUsd"> {
  const { openMs, closeMs, closeMin } = sessionBounds(date);
  const kept = trades.filter((t) => t.size > 0 && t.price > 0 && t.tsMs >= openMs && t.tsMs < closeMs + 5_000).sort((a, b) => a.tsMs - b.tsMs);
  const ends: number[] = [];
  for (let m = 9 * 60 + 30 + CURVE_MIN; m <= closeMin; m += CURVE_MIN) ends.push(m);
  if (ends[ends.length - 1] !== closeMin) ends.push(closeMin);
  const endMs = ends.map((m) => openMs + (m - (9 * 60 + 30)) * 60_000);
  const curve: SessionFlow["curve"] = [];
  let bucket = 0;
  let buy = 0;
  let sell = 0;
  let unsigned = 0;
  let openCross = 0;
  let closeCross = 0;
  let pv = 0;
  let volume = 0;
  let last: number | null = null;
  const continuous: Trade[] = [];
  const flushUntil = (ms: number) => {
    while (bucket < ends.length && endMs[bucket]! <= ms) {
      curve.push([hhmm(ends[bucket]!), buy - sell, last === null ? null : round(last, 4)]);
      bucket++;
    }
  };
  for (const t of kept) {
    // The closing cross prints at the close: it belongs to the last bucket.
    flushUntil(t.tsMs >= closeMs ? closeMs - 1 : t.tsMs);
    const auction = t.side === "N" && (t.tsMs < openMs + 2_000 || t.tsMs >= closeMs);
    volume += t.size;
    pv += t.size * t.price;
    last = t.price;
    if (t.side === "B") buy += t.size;
    else if (t.side === "A") sell += t.size;
    else {
      unsigned += t.size;
      if (auction) {
        if (t.tsMs >= closeMs) closeCross += t.size;
        else openCross += t.size;
      }
    }
    if (!auction) continuous.push(t);
  }
  flushUntil(Number.POSITIVE_INFINITY);
  const largest = [...continuous]
    .sort((a, b) => b.size - a.size || a.tsMs - b.tsMs)
    .slice(0, TOP_PRINTS)
    .map((t) => ({ time: NY_HMS.format(new Date(t.tsMs)), side: t.side === "B" ? ("buy" as const) : t.side === "A" ? ("sell" as const) : ("none" as const), size: t.size, price: round(t.price, 4)! }));
  return {
    date,
    trades: kept.length,
    volume,
    buyVolume: buy,
    sellVolume: sell,
    unsignedVolume: unsigned,
    openCross,
    closeCross,
    vwap: volume > 0 ? round(pv / volume, 4) : null,
    lastPrice: last === null ? null : round(last, 4),
    curve,
    largest,
  };
}

/* ------------------------------------------------------------------ caches and the month ledger */

const sessionCache = new TtlCache<Promise<SessionFlow>>(7 * DAY, 400);
let datasetEnd: { at: number; endMs: number | null } | null = null;
let month: { month: string; at: number; totalUsd: number; callerUsd: number } | null = null;
const MONTH_TTL_MS = 5 * 60_000;

/** For tests: forget every cached session, the dataset range and the month totals. */
export function resetFlow(): void {
  sessionCache.clear();
  datasetEnd = null;
  month = null;
}

async function loadDatasetEnd(nowMs: number, signal: AbortSignal): Promise<number | null> {
  if (datasetEnd && nowMs - datasetEnd.at < 10 * 60_000) return datasetEnd.endMs;
  const endMs = await getDatasetEnd(FLOW_DATASET, FLOW_SCHEMA, signal).catch(() => null);
  // A failed read is retried on the next call; a good one is kept 10 minutes.
  if (endMs !== null) datasetEnd = { at: nowMs, endMs };
  return endMs;
}

async function loadMonth(nowMs: number, signal: AbortSignal) {
  const m = monthBounds(nowMs).month;
  if (month && month.month === m && nowMs - month.at < MONTH_TTL_MS) return month;
  const s = await monthSpend(FLOW_CALLER, nowMs, signal);
  month = { month: m, at: nowMs, totalUsd: s.totalUsd, callerUsd: s.callerUsd };
  return month;
}

/** Checks the caps and books the cost locally; a reason when refused. */
function reserve(costUsd: number): string | null {
  const caps = flowCaps();
  if (!month) return "the spend ledger could not be read, so nothing was bought";
  if (month.callerUsd + costUsd > caps.callerMonthUsd + 1e-9) return `Falcon AI's monthly volume-data budget ($${caps.callerMonthUsd.toFixed(2)}) is used up`;
  if (month.totalUsd + costUsd > caps.totalMonthUsd + 1e-9) return `the monthly Databento budget ($${caps.totalMonthUsd.toFixed(2)}) is used up`;
  month.callerUsd += costUsd;
  month.totalUsd += costUsd;
  return null;
}

function release(costUsd: number): void {
  if (!month) return;
  month.callerUsd -= costUsd;
  month.totalUsd -= costUsd;
}

function spendLine(req: RangeRequest, kind: "charge" | "refund", costUsd: number, at: string, note: string): SpendLine {
  return { at, caller: FLOW_CALLER, kind, dataset: req.dataset, schema: req.schema, symbols: req.symbols.length, start_at: req.start, end_at: req.end, cost_usd: kind === "refund" ? -costUsd : costUsd, key: requestKey(req), note };
}

/** Records the charge, downloads the session's trades and summarizes them. The download has its own timeout, not the tool's. */
async function buySession(symbol: string, date: string, req: RangeRequest, costUsd: number): Promise<SessionFlow> {
  const at = new Date().toISOString();
  try {
    await appendSpend([spendLine(req, "charge", costUsd, at, `${symbol} ${date}`)], AbortSignal.timeout(8_000));
  } catch {
    release(costUsd);
    throw new ToolError("The spend ledger could not be written, so no volume data was bought. Try again later.");
  }
  let body;
  try {
    body = await getRange(req, AbortSignal.timeout(PULL_TIMEOUT_MS));
  } catch (err) {
    // Databento refused the request (no data served): refund. A dropped or slow download keeps its charge (the safe side).
    if (err instanceof DatabentoError && err.status >= 400) {
      release(costUsd);
      await appendSpend([spendLine(req, "refund", costUsd, new Date().toISOString(), `refused: HTTP ${err.status}`)]).catch(() => undefined);
    }
    throw err;
  }
  const out: SessionFlow = { ...summarizeSession(date, parseTrades(body.records)), costUsd };
  if (body.partial) out.partial = (body.warning ?? "Databento answered with partial data").slice(0, 200);
  return out;
}

/* ------------------------------------------------------------------ the tool */

type Bar = ReturnType<typeof barsFromChart>[number];

function chartRange(daysBack: number): string {
  for (const [r, d] of [["1mo", 28], ["3mo", 88], ["6mo", 178], ["1y", 360], ["2y", 725], ["5y", 1820]] as const) if (daysBack <= d) return r;
  return "10y";
}

function waitOrAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const errText = (err: unknown) => (err instanceof ToolError ? err.message : err instanceof DatabentoError ? `Databento answered HTTP ${err.status || "error"}` : "the download failed");

export type FlowOptions = { days?: number; session?: string };

export async function flowTool(symbol: string, opts: FlowOptions, ctx: DeskToolContext, signal: AbortSignal) {
  if (!databentoConfigured()) throw new ToolError("Volume data isn't configured on this server");
  const days = opts.days ?? 1;
  if (!Number.isInteger(days) || days < 1 || days > FLOW_MAX_DAYS) throw new ToolError(`days must be 1 to ${FLOW_MAX_DAYS}.`);
  const nowMs = ctx.now?.() ?? Date.now();
  const today = nyParts(nowMs).date;
  const until = opts.session ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || !Number.isFinite(Date.parse(`${until}T12:00:00Z`))) throw new ToolError("session must be a date, YYYY-MM-DD.");
  if (until < FLOW_FIRST_DATE) throw new ToolError(`Nasdaq trade data starts on ${FLOW_FIRST_DATE}.`);
  // Nasdaq lists class shares with a dot (BRK.B); Yahoo with a dash.
  const dbSymbol = symbol.replace("-", ".");

  const daysBack = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${until}T12:00:00Z`)) / DAY) + days * 2 + 10;
  // The month's spend is read while the calendar loads (cached 5 min); the dataset range gets at most 2.5 s.
  const monthLoad = loadMonth(nowMs, signal).then(
    () => true,
    () => false,
  );
  const [chart, endMs] = await Promise.all([
    yahooChart(symbol, chartRange(daysBack), "1d", signal).catch(() => undefined),
    loadDatasetEnd(nowMs, AbortSignal.any([signal, AbortSignal.timeout(2_500)])),
  ]);
  if (chart === null) throw new ToolError(`No such US ticker: ${symbol}.`);
  const bars: Bar[] = chart ? barsFromChart(chart) : [];
  const notes: string[] = [];
  // Session dates: Yahoo's daily bars (the exchange calendar); weekdays if Yahoo is down.
  let dates = bars.map((b) => b.date);
  if (!dates.length) {
    notes.push("Session calendar from weekdays (Yahoo unavailable): no close-to-close change or consolidated volume.");
    for (let d = until, i = 0; i < days * 3 + 5; i++, d = addDays(d, -1)) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(d);
    }
  }
  const usable = (d: string) => {
    const { closeMs } = sessionBounds(d);
    return d <= until && closeMs + 10 * 60_000 <= nowMs && (endMs === null || closeMs + 5_000 <= endMs);
  };
  const latestDone = dates.filter((d) => d <= until && sessionBounds(d).closeMs + 10 * 60_000 <= nowMs).pop();
  dates = dates.filter(usable);
  const chosen = dates.slice(-days);
  if (!chosen.length) throw new ToolError(`No completed session with Nasdaq trade data on or before ${until}.`);
  if (latestDone && latestDone !== chosen[chosen.length - 1]) notes.push(`Databento has not published ${latestDone} yet; the latest available session is ${chosen[chosen.length - 1]}.`);

  // Cached sessions, then price the rest (free) and buy what fits the caps.
  const caps = flowCaps();
  const keyOf = (d: string) => `${dbSymbol}|${d}`;
  const promises = new Map<string, Promise<SessionFlow>>();
  const fromCache = new Set<string>();
  const skipped: Array<{ date: string; reason: string }> = [];
  for (const d of chosen) {
    const hit = sessionCache.get(keyOf(d));
    if (hit) {
      promises.set(d, hit);
      fromCache.add(d);
    }
  }
  const misses = chosen.filter((d) => !promises.has(d));
  const priced = await Promise.all(
    misses.map(async (d) => {
      const req = flowRequest(dbSymbol, d);
      try {
        return { d, req, cost: await getCost(req, signal), err: null as string | null };
      } catch (err) {
        if (signal.aborted) throw err;
        return { d, req, cost: 0, err: err instanceof DatabentoError && err.status === 422 ? "Databento does not know this symbol on Nasdaq" : `Databento could not price it (${errText(err)})` };
      }
    }),
  );
  const toBuy = priced.filter((p) => !p.err && p.cost > 0 && p.cost <= caps.maxPullUsd);
  if (toBuy.length && !(await monthLoad)) {
    if (signal.aborted) throw signal.reason;
    month = null;
  }
  let boughtUsd = 0;
  for (const p of [...priced].reverse()) {
    const again = sessionCache.get(keyOf(p.d));
    if (again) {
      promises.set(p.d, again);
      fromCache.add(p.d);
      continue;
    }
    if (p.err) skipped.push({ date: p.d, reason: p.err });
    else if (p.cost <= 0) skipped.push({ date: p.d, reason: "no Nasdaq trades in this session" });
    else if (p.cost > caps.maxPullUsd)
      skipped.push({ date: p.d, reason: `this one session alone is priced at $${p.cost.toFixed(2)}, over the $${caps.maxPullUsd.toFixed(2)} per-session limit; each session is priced on its own, so fewer days or another session of similar volume will not fit either` });
    else {
      const refused = reserve(p.cost);
      if (refused) skipped.push({ date: p.d, reason: refused });
      else {
        boughtUsd += p.cost;
        promises.set(p.d, cached(sessionCache, keyOf(p.d), () => buySession(dbSymbol, p.d, p.req, p.cost)));
      }
    }
  }

  let settled: Array<{ d: string; r: PromiseSettledResult<SessionFlow> }>;
  try {
    const entries = Array.from(promises.entries());
    const results = await waitOrAbort(Promise.allSettled(entries.map(([, p]) => p)), signal);
    settled = entries.map(([d], i) => ({ d, r: results[i]! }));
  } catch (err) {
    if (ctx.signal?.aborted || !signal.aborted) throw err;
    throw new ToolError(`Still downloading ${symbol}'s Nasdaq trades (large sessions take 5-20 s). Call flow again with the same arguments to get the result: the download continues and is not bought twice.`);
  }
  const flows: SessionFlow[] = [];
  for (const { d, r } of settled) {
    if (r.status === "fulfilled") flows.push(r.value);
    else skipped.push({ date: d, reason: errText(r.reason) });
  }
  if (!flows.length) {
    const why = skipped.map((s) => `${s.date}: ${s.reason}`).join("; ");
    throw new ToolError(`No volume data for ${symbol}${why ? ` (${why})` : ""}.`);
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : 1));
  skipped.sort((a, b) => (a.date < b.date ? -1 : 1));
  return shapeResult(symbol, days, flows, bars, { fromCache, boughtUsd, skipped, notes });
}

/** The compact result. Pure. */
export function shapeResult(
  symbol: string,
  days: number,
  flows: readonly SessionFlow[],
  bars: readonly Bar[],
  extra: { fromCache: ReadonlySet<string>; boughtUsd: number; skipped: Array<{ date: string; reason: string }>; notes: string[] },
) {
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  let cum = 0;
  let buy = 0;
  let sell = 0;
  let vol = 0;
  const sessions = flows.map((f) => {
    const i = idx.get(f.date);
    const bar = i !== undefined ? bars[i] : undefined;
    const prev = i !== undefined && i > 0 ? bars[i - 1] : undefined;
    const delta = f.buyVolume - f.sellVolume;
    const signed = f.buyVolume + f.sellVolume;
    cum += delta;
    buy += f.buyVolume;
    sell += f.sellVolume;
    vol += f.volume;
    return {
      date: f.date,
      buyVolume: f.buyVolume,
      sellVolume: f.sellVolume,
      delta,
      deltaPctOfVolume: f.volume > 0 ? round((delta / f.volume) * 100, 2) : null,
      deltaPctOfSigned: signed > 0 ? round((delta / signed) * 100, 2) : null,
      nasdaqVolume: f.volume,
      unsignedVolume: f.unsignedVolume,
      crosses: { open: f.openCross, close: f.closeCross },
      trades: f.trades,
      vwap: f.vwap,
      nasdaqLast: f.lastPrice,
      close: bar ? round(bar.close, 4) : null,
      closeToClosePct: bar && prev ? round((bar.close / prev.close - 1) * 100, 2) : null,
      consolidatedVolume: bar?.volume || null,
      nasdaqSharePct: bar?.volume ? round((f.volume / bar.volume) * 100, 1) : null,
      cumDelta30m: f.curve,
      largestPrints: f.largest,
      data: extra.fromCache.has(f.date) ? "cached" : `bought $${f.costUsd.toFixed(3)}`,
      ...(f.partial ? { partial: f.partial } : {}),
    };
  });
  let running = 0;
  return {
    ticker: symbol.replace("-", "."),
    sessionsRequested: days,
    sessions,
    multiDay:
      sessions.length > 1
        ? {
            sessions: sessions.length,
            buyVolume: buy,
            sellVolume: sell,
            delta: cum,
            deltaPctOfVolume: vol > 0 ? round((cum / vol) * 100, 2) : null,
            cumulative: sessions.map((s) => [s.date, s.delta, (running += s.delta)]),
          }
        : undefined,
    ...(extra.skipped.length ? { skipped: extra.skipped } : {}),
    costUsd: round(extra.boughtUsd, 4),
    note: FLOW_NOTE,
    notes: [
      "delta = aggressor buy volume - aggressor sell volume (shares); deltaPctOfVolume divides by all Nasdaq volume, deltaPctOfSigned by buy + sell.",
      "unsignedVolume has no aggressor side (opening/closing crosses and some hidden-order executions); it is in volume and VWAP, not in the delta.",
      "cumDelta30m: [bucket end ET, cumulative delta, last Nasdaq price]. largestPrints: continuous-session Nasdaq trades, crosses excluded; side = aggressor.",
      "close, closeToClosePct and consolidatedVolume: Yahoo Finance daily bars (all venues).",
      ...extra.notes,
    ],
    source: "Databento XNAS.ITCH trades (Nasdaq TotalView-ITCH), regular hours 09:30-16:00 ET",
    sources: FLOW_SOURCES,
  };
}

/** The per-session figures that do not come from Nasdaq's trades (citations.ts FieldSource). */
const FLOW_SOURCES: FieldSource[] = [
  { covers: ["sessions.close", "sessions.closeToClosePct", "sessions.consolidatedVolume"], label: "Yahoo Finance daily bars (all venues)" },
  { covers: ["sessions.nasdaqSharePct"], label: "Computed by Falcon from Databento XNAS.ITCH volume and Yahoo Finance consolidated volume" },
];
