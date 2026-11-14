/**
 * Stock order-flow hypotheses H1 (quiet accumulation) and H3 (ripple + flow),
 * pre-registered in data/preregistration/flow-v1.json. Write-up:
 * docs/flow-study.md. Pure parts: src/options/study-flow.ts.
 *
 * Phases (resumable; each skips what is already done):
 *   plan     dry-run every session's XNAS.ITCH trades request, print the projected cost
 *   pull     pull the sessions not yet in the panel (caller flow-hypotheses, cap $35),
 *            aggregate each to daily flow and append it to .cache/flow-study/flow-panel.ndjson
 *   events   EDGAR earnings 8-Ks and Taiwan monthly revenue 6-Ks, Yahoo EPS signs
 *            -> .cache/flow-study/events.json
 *   analyze  H1 and H3 -> .cache/flow-study/results.json and results.md
 *
 * Usage: node --import tsx scripts/flow-study.ts <phase...> [--concurrency 3] [--max-days N]
 *
 * Prices: Yahoo adjusted daily bars cached by the F7 study under
 * .cache/study/yahoo (read only). Raw trades stay in the shared Databento
 * cache (.cache/databento/data); only daily aggregates are kept here.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabentoClient, fetchStockTrades } from "../src/options/client.ts";
import { aggregateFlow, type FlowDay } from "../src/options/flow.ts";
import {
  CALLER,
  CALLER_CAP_USD,
  FLOW_FROM,
  FLOW_TO,
  FLOW_UNIVERSE,
  H1_RULES,
  H3_RULES,
  ROUND_TRIP_PCT,
  benjaminiHochberg,
  clusteredDiffTest,
  confirms,
  dedupHits,
  fillSessions,
  flowPass,
  flowSum,
  h1Events,
  h1Primary,
  outcomeAfter,
  ownEventNear,
  permutationP,
  permuteWithin,
  quantile,
  quietPass,
  quietRows,
  shuffledSignals,
  splitHalves,
  summarize,
  thetaOf,
  twoWayP,
  type Direction,
  type HitCandidate,
  type Outcome,
  type Summary,
} from "../src/options/study-flow.ts";
import { nyInstantMs, nyseSessions, type PriceSeries } from "../src/study/abnormal.ts";
import { clusteredMeanTest, median } from "../src/study/stats.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { edgarPastEvents, type PastEvent } from "../src/past-events.ts";
import { backtestMarketData, type ReportedQuarter } from "../src/market.ts";
import { eventReactionIndex, matchQuarters } from "../src/history.ts";
import { signOf } from "../src/events.ts";
import { loadGraph, walk } from "../src/graph.ts";
import { SECTORS } from "../src/universe.ts";

const OUT = path.join(ENGINE_ROOT, ".cache", "flow-study");
const PANEL = path.join(OUT, "flow-panel.ndjson");
const EVENTS = path.join(OUT, "events.json");
const RESULTS = path.join(OUT, "results.json");
const RESULTS_MD = path.join(OUT, "results.md");
const YAHOO_DIR = path.join(ENGINE_ROOT, ".cache", "study", "yahoo");
const PULL = { caller: CALLER, maxCallUsd: 0.6, maxCallerUsd: CALLER_CAP_USD };

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const phases = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const CONCURRENCY = Number(flag("--concurrency") ?? "3");
const MAX_DAYS = Number(flag("--max-days") ?? "100000");

const t0 = Date.now();
function log(...xs: unknown[]): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...xs);
}

fs.mkdirSync(OUT, { recursive: true });
const FLOW_SESSIONS = nyseSessions(FLOW_FROM, FLOW_TO);

// ---------------------------------------------------------------------------
// Panel

type PanelLine = { date: string; costUsd: number; cached: boolean; flows: Record<string, FlowDay> };

function readPanel(): Map<string, PanelLine> {
  const out = new Map<string, PanelLine>();
  if (!fs.existsSync(PANEL)) return out;
  for (const line of fs.readFileSync(PANEL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as PanelLine;
      out.set(p.date, p);
    } catch {
      // a torn last line from an interrupted run: that day is pulled again (from cache, free)
    }
  }
  return out;
}

function tradesRequest(date: string) {
  const iso = (m: number) => new Date(nyInstantMs(date, m)).toISOString();
  // Same window as fetchStockTrades(regularOnly), so the cache key matches.
  return { dataset: "XNAS.ITCH", schema: "trades", symbols: [...FLOW_UNIVERSE], start: iso(9 * 60 + 30), end: iso(16 * 60 + 10) };
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

async function planPhase(): Promise<number> {
  const client = new DatabentoClient();
  const done = readPanel();
  const todo = FLOW_SESSIONS.filter((d) => !done.has(d));
  let priced = 0;
  let cachedDays = 0;
  let k = 0;
  await pool(todo, 4, async (d) => {
    const res = await client.getRange(tradesRequest(d), { ...PULL, dryRun: true });
    if (res.cached) cachedDays++;
    priced += res.pricedUsd;
    if (++k % 50 === 0) log(`plan: ${k}/${todo.length} priced, running total $${priced.toFixed(2)}`);
  });
  const spent = client.guard.spentUsd(CALLER);
  log(`plan: ${FLOW_SESSIONS.length} sessions ${FLOW_FROM}..${FLOW_TO}, ${done.size} in panel, ${todo.length} to pull (${cachedDays} already cached, free)`);
  log(`plan: projected $${priced.toFixed(2)}; caller ${CALLER} spent $${spent.toFixed(2)} of $${CALLER_CAP_USD}; ledger total $${client.guard.spentUsd().toFixed(2)} of $${client.guard.totalBudgetUsd}`);
  return priced;
}

async function pullPhase(): Promise<void> {
  const client = new DatabentoClient();
  const done = readPanel();
  const todo = FLOW_SESSIONS.filter((d) => !done.has(d)).slice(0, MAX_DAYS);
  log(`pull: ${todo.length} sessions`);
  let k = 0;
  let cost = 0;
  await pool(todo, CONCURRENCY, async (date) => {
    const pre = await client.getRange(tradesRequest(date), { ...PULL, dryRun: true });
    const trades = await fetchStockTrades(client, { symbols: [...FLOW_UNIVERSE], date, regularOnly: true, pull: PULL });
    const flows: Record<string, FlowDay> = {};
    for (const [sym, ts] of trades) {
      const day = aggregateFlow(ts, { session: "regular", classify: "given" }).find((d) => d.date === date);
      if (day) flows[sym] = day;
    }
    const line: PanelLine = { date, costUsd: pre.cached ? 0 : pre.pricedUsd, cached: pre.cached, flows };
    fs.appendFileSync(PANEL, JSON.stringify(line) + "\n");
    cost += line.costUsd;
    k++;
    if (k % 10 === 0 || k === todo.length) log(`pull: ${k}/${todo.length} (${date}, ${Object.keys(flows).length} names), this run ~$${cost.toFixed(2)}, caller total $${client.guard.spentUsd(CALLER).toFixed(2)}`);
  });
}

// ---------------------------------------------------------------------------
// Events

type StoredEvent = PastEvent & { ticker: string; quarter: ReportedQuarter | null };
type EventsFile = { done: string[]; events: StoredEvent[]; problems: string[] };

const MONTHLY = ["TSM", "UMC", "ASX"];

async function eventsPhase(): Promise<void> {
  const file: EventsFile = fs.existsSync(EVENTS) ? JSON.parse(fs.readFileSync(EVENTS, "utf8")) : { done: [], events: [], problems: [] };
  const md = await backtestMarketData(path.join(OUT, "market"));
  if ("error" in md) throw new Error(md.error);
  const tickers = SECTORS.semis!.tickers;
  const since = "2023-03-01";
  for (const t of tickers) {
    if (file.done.includes(t)) continue;
    try {
      if (MONTHLY.includes(t)) {
        const ev = await edgarPastEvents(t, "monthly_revenue", since, (l) => log(l));
        for (const e of ev) file.events.push({ ...e, ticker: t, quarter: null });
        log(`events ${t}: ${ev.length} monthly revenue reports`);
      } else {
        const ev = await edgarPastEvents(t, "earnings", since);
        let quarters: ReportedQuarter[] = [];
        try {
          quarters = await md.market.earnings(t, "2023-02-20", "2024-09-30");
        } catch (err) {
          file.problems.push(`${t}: EPS record unreadable (${err instanceof Error ? err.message : String(err)})`);
        }
        const matched = matchQuarters(ev, quarters);
        for (const m of matched) file.events.push({ ...m.event, ticker: t, quarter: m.quarter });
        log(`events ${t}: ${ev.length} earnings 8-Ks, ${matched.filter((m) => m.event.sign !== null).length} with an EPS sign`);
      }
      file.done.push(t);
    } catch (err) {
      file.problems.push(`${t}: ${err instanceof Error ? err.message : String(err)}`);
      log(`events ${t}: failed (${err instanceof Error ? err.message : String(err)}), rerun to retry`);
    }
    fs.writeFileSync(EVENTS, JSON.stringify(file, null, 1));
  }
}

// ---------------------------------------------------------------------------
// Prices

type YahooFile = { d: string[]; o: number[]; c: number[]; a: number[]; v: number[]; status: number };
type Aligned = PriceSeries & { dollarVolume: Float64Array };

const CALENDAR = nyseSessions("2022-01-03", "2026-10-30");
const CAL_INDEX = new Map(CALENDAR.map((d, i) => [d, i]));

function loadAligned(ticker: string): Aligned | null {
  let y: YahooFile;
  try {
    y = JSON.parse(fs.readFileSync(path.join(YAHOO_DIR, `${ticker}.json`), "utf8")) as YahooFile;
  } catch {
    return null;
  }
  if (y.status !== 200) return null;
  const n = CALENDAR.length;
  const open = new Float64Array(n).fill(NaN);
  const close = new Float64Array(n).fill(NaN);
  const dollarVolume = new Float64Array(n).fill(NaN);
  for (let k = 0; k < y.d.length; k++) {
    const i = CAL_INDEX.get(y.d[k]!);
    if (i === undefined) continue;
    const f = y.a[k]! / y.c[k]!;
    open[i] = y.o[k]! * f;
    close[i] = y.a[k]!;
    dollarVolume[i] = y.c[k]! * y.v[k]!;
  }
  return { open, close, dollarVolume };
}

// ---------------------------------------------------------------------------
// Analysis

const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "n/a");
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

type Line = Summary & { label: string; early?: Summary | null; late?: Summary | null; costAware?: number; extra?: Record<string, unknown> };

function line(label: string, values: number[], dates: string[], extra?: Record<string, unknown>): Line | null {
  const s = summarize(values, dates);
  if (!s) return null;
  const items = values.map((v, i) => ({ v, date: dates[i]! })).filter((x) => Number.isFinite(x.v));
  const { early, late } = splitHalves(items);
  return {
    label,
    ...s,
    early: summarize(early.map((x) => x.v), early.map((x) => x.date)),
    late: summarize(late.map((x) => x.v), late.map((x) => x.date)),
    costAware: s.mean - ROUND_TRIP_PCT,
    ...(extra ? { extra } : {}),
  };
}

function fmtLine(l: Line | null): string {
  if (!l) return "| (empty) | | | | | | | | | |";
  return `| ${l.label} | ${l.n} | ${l.g} | ${pct(l.mean)} | ${pct(l.median)} | ${num(l.t)} | ${num(l.p, 4)} | ${(l.hitRate * 100).toFixed(1)}% | ${pct(l.early?.mean ?? NaN)} / ${pct(l.late?.mean ?? NaN)} | ${pct(l.costAware ?? NaN)} |`;
}

const TABLE_HEAD = "| Test | n | dates | mean | median | t | p (1-sided) | hit rate | early / late mean | mean - 20 bp |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

function analyzePhase(): void {
  const panel = readPanel();
  const missing = FLOW_SESSIONS.filter((d) => !panel.has(d));
  if (missing.length) log(`analyze: ${missing.length} sessions not in the panel (first ${missing[0]}); results use what is there`);
  const flowIdx = FLOW_SESSIONS.map((d) => CAL_INDEX.get(d)!);
  const flowFrom = flowIdx[0]!;
  const flowTo = flowIdx[flowIdx.length - 1]!;

  const spy = loadAligned("SPY");
  if (!spy) throw new Error("SPY prices missing");
  const prices = new Map<string, Aligned>();
  for (const t of FLOW_UNIVERSE) {
    const p = loadAligned(t);
    if (p) prices.set(t, p);
    else log(`analyze: no prices for ${t}`);
  }

  // Flow per name, by calendar index.
  const flowByName = new Map<string, Array<FlowDay | undefined>>();
  const flowDays = new Map<string, FlowDay[]>();
  for (const t of FLOW_UNIVERSE) {
    const arr = new Array<FlowDay | undefined>(CALENDAR.length);
    const days: FlowDay[] = [];
    for (const d of FLOW_SESSIONS) {
      const f = panel.get(d)?.flows[t];
      if (f) {
        arr[CAL_INDEX.get(d)!] = f;
        days.push(f);
      }
    }
    flowByName.set(t, arr);
    flowDays.set(t, days);
  }

  // Coverage.
  const coverage: Record<string, { days: number; signedShareNasdaq: number; signedShareConsolidated: number; auctionShare: number; meanDailyImbalance: number }> = {};
  let totSigned$ = 0;
  let totItch$ = 0;
  let totCons$ = 0;
  for (const t of FLOW_UNIVERSE) {
    const days = flowDays.get(t)!;
    const p = prices.get(t);
    let signedV = 0, vol = 0, auction = 0, signed$ = 0, itch$ = 0, cons$ = 0;
    const imbs: number[] = [];
    for (const d of days) {
      signedV += d.buyVolume + d.sellVolume;
      vol += d.volume;
      auction += d.auctionVolume;
      signed$ += d.buyDollar + d.sellDollar;
      itch$ += d.buyDollar + d.sellDollar + d.unknownDollar;
      const dv = p?.dollarVolume[CAL_INDEX.get(d.date)!];
      if (dv !== undefined && Number.isFinite(dv)) cons$ += dv;
      if (d.dollarImbalance !== null) imbs.push(d.dollarImbalance);
    }
    totSigned$ += signed$;
    totItch$ += itch$;
    totCons$ += cons$;
    coverage[t] = {
      days: days.length,
      signedShareNasdaq: vol ? signedV / vol : NaN,
      signedShareConsolidated: cons$ ? signed$ / cons$ : NaN,
      auctionShare: vol ? auction / vol : NaN,
      meanDailyImbalance: imbs.length ? imbs.reduce((a, b) => a + b, 0) / imbs.length : NaN,
    };
  }
  log(`coverage: signed $ / ITCH $ ${(totSigned$ / totItch$ * 100).toFixed(1)}%, signed $ / consolidated $ ${(totSigned$ / totCons$ * 100).toFixed(1)}%`);

  // Outcomes for every name-day of the flow calendar (entry next open).
  const outcomes = new Map<string, Map<string, Outcome>>();
  for (const t of FLOW_UNIVERSE) {
    const p = prices.get(t);
    const m = new Map<string, Outcome>();
    if (p) for (const i of flowIdx) m.set(CALENDAR[i]!, outcomeAfter(CALENDAR, p, spy, i));
    outcomes.set(t, m);
  }
  const outcomeAt = (t: string, i: number): Outcome => {
    const d = CALENDAR[i]!;
    const hit = outcomes.get(t)?.get(d);
    if (hit) return hit;
    const p = prices.get(t);
    const o = p ? outcomeAfter(CALENDAR, p, spy, i) : { car5: NaN, car10: NaN };
    if (!outcomes.has(t)) outcomes.set(t, new Map());
    outcomes.get(t)!.set(d, o);
    return o;
  };

  // ------------------------------------------------------------------ H1
  const closesOf = (t: string) => {
    const p = prices.get(t);
    const out: Array<{ date: string; close: number }> = [];
    if (!p) return out;
    for (let i = Math.max(0, flowFrom - 120); i <= flowTo; i++) if (p.close[i]! > 0) out.push({ date: CALENDAR[i]!, close: p.close[i]! });
    return out;
  };

  type Variant = { window: number; theta: "own80" | number; side: "buy" | "sell" };
  const runH1 = (v: Variant) => {
    const signals = new Map<string, Set<string>>();
    const eligible = new Map<string, string[]>();
    const perDate = new Map<string, Array<{ ticker: string; flow: boolean; quiet: boolean }>>();
    let rawSignals = 0;
    let eligibleDays = 0;
    const thetas: Record<string, number> = {};
    for (const t of FLOW_UNIVERSE) {
      if (!prices.has(t)) continue;
      const rows = quietRows(fillSessions(flowDays.get(t)!, FLOW_SESSIONS), closesOf(t), v.window);
      const theta = v.theta === "own80" ? thetaOf(rows, v.window, H1_RULES.thetaQuantile, v.side) : v.side === "buy" ? v.theta : -v.theta;
      thetas[t] = theta;
      const sig = new Set<string>();
      const el: string[] = [];
      for (const r of rows) {
        if (r.windowDays !== v.window || r.imbalance === null || r.zMove === null) continue;
        el.push(r.date);
        const fp = flowPass(r, v.window, theta, v.side);
        const q = quietPass(r);
        if (!perDate.has(r.date)) perDate.set(r.date, []);
        perDate.get(r.date)!.push({ ticker: t, flow: fp, quiet: q });
        if (fp && q) sig.add(r.date);
      }
      rawSignals += sig.size;
      eligibleDays += el.length;
      signals.set(t, sig);
      eligible.set(t, el);
    }
    const events = h1Events({ sessions: CALENDAR, outcomes, signals, eligible, gap: H1_RULES.gap });
    return { signals, eligible, perDate, events, rawSignals, eligibleDays, thetas };
  };

  const sgn = (side: "buy" | "sell") => (side === "buy" ? 1 : -1);
  const h1Lines = (label: string, v: Variant, r: ReturnType<typeof runH1>) => {
    const ev = r.events.filter((e) => Number.isFinite(e.car10) && Number.isFinite(e.control10));
    const s = sgn(v.side);
    return {
      primary: line(`${label}: CAR10 - same-date control`, ev.map((e) => h1Primary(e)), ev.map((e) => e.date)),
      raw: line(`${label}: raw CAR10`, ev.map((e) => e.car10 * 100), ev.map((e) => e.date)),
      sameName: line(`${label}: CAR10 - same name's non-signal mean`, ev.map((e) => (e.car10 - e.sameName10) * 100), ev.map((e) => e.date)),
      car5: line(`${label}: CAR5 - same-date control`, r.events.filter((e) => Number.isFinite(e.car5) && Number.isFinite(e.control5)).map((e) => (e.car5 - e.control5) * 100), r.events.filter((e) => Number.isFinite(e.car5) && Number.isFinite(e.control5)).map((e) => e.date)),
      sign: s,
      events: ev,
    };
  };

  const primaryVariant: Variant = { window: 5, theta: "own80", side: "buy" };
  const h1 = runH1(primaryVariant);
  const h1L = h1Lines("H1 primary (W5, own 80th pct)", primaryVariant, h1);
  log(`H1: ${h1.eligibleDays} eligible name-days, ${h1.rawSignals} raw signal days, ${h1.events.length} events (${h1L.events.length} measurable)`);

  // Robustness of the primary.
  const ev1 = h1L.events;
  const vals1 = ev1.map((e) => h1Primary(e));
  const tw1 = twoWayP(vals1, ev1.map((e) => e.ticker), ev1.map((e) => e.date));
  const block1 = clusteredMeanTest(vals1, ev1.map((e) => String(Math.floor(e.index / 10))));

  // Placebo: flow-pass flags shuffled across names within each date.
  const placebo1 = permutationP(h1L.primary?.mean ?? NaN, 1000, 20261114, (rnd) => {
    const sig = shuffledSignals(h1.perDate, rnd);
    const ev = h1Events({ sessions: CALENDAR, outcomes, signals: sig, eligible: h1.eligible, gap: H1_RULES.gap }).filter((e) => Number.isFinite(e.car10) && Number.isFinite(e.control10));
    return ev.length ? ev.reduce((s, e) => s + h1Primary(e), 0) / ev.length : NaN;
  });

  const variants: Array<[string, Variant]> = [
    ["W3, own 80th pct", { window: 3, theta: "own80", side: "buy" }],
    ["W5, fixed theta 0.10", { window: 5, theta: 0.1, side: "buy" }],
    ["W5, quiet distribution (mirror, expect < 0)", { window: 5, theta: "own80", side: "sell" }],
  ];
  const h1Secondary: Line[] = [];
  for (const l of [h1L.raw, h1L.sameName, h1L.car5]) if (l) h1Secondary.push(l);
  const variantInfo: Record<string, unknown> = {};
  for (const [label, v] of variants) {
    const r = runH1(v);
    const L = h1Lines(label, v, r);
    if (L.primary) h1Secondary.push(L.primary);
    variantInfo[label] = { rawSignals: r.rawSignals, events: r.events.length, eligibleDays: r.eligibleDays };
  }
  // Flat-price days with no flow condition (does "quiet" alone carry anything?).
  {
    const quietOnly = new Map<string, Set<string>>();
    for (const [date, rows] of h1.perDate) for (const r of rows) if (r.quiet) {
      if (!quietOnly.has(r.ticker)) quietOnly.set(r.ticker, new Set());
      quietOnly.get(r.ticker)!.add(date);
    }
    // Control = non-quiet names that date; reported as a reference only.
    const ev = h1Events({ sessions: CALENDAR, outcomes, signals: quietOnly, eligible: h1.eligible, gap: H1_RULES.gap }).filter((e) => Number.isFinite(e.car10) && Number.isFinite(e.control10));
    const l = line("reference: quiet price alone, any flow", ev.map((e) => h1Primary(e)), ev.map((e) => e.date));
    if (l) h1Secondary.push(l);
  }

  // ------------------------------------------------------------------ H3
  const evFile: EventsFile = fs.existsSync(EVENTS) ? JSON.parse(fs.readFileSync(EVENTS, "utf8")) : { done: [], events: [], problems: ["no events file"] };
  const graph = loadGraph();
  const universe = new Set<string>(FLOW_UNIVERSE);
  const ownDay0 = new Map<string, number[]>();
  type Ev = { ticker: string; kind: string; accession: string; day0: number; sign: Direction };
  const rippleEvents: Ev[] = [];
  const funnel = { stored: evFile.events.length, noSign: 0, zeroSign: 0, noReleaseDate: 0, noDay0: 0, outsideFlow: 0, kept: 0 };
  for (const e of evFile.events) {
    let day0: number | null;
    if (e.kind === "monthly_revenue") {
      day0 = eventReactionIndex(CALENDAR, Date.parse(e.acceptedAt), e.releasedOn ? { date: e.releasedOn, time: "before_open" } : null);
    } else {
      day0 = eventReactionIndex(CALENDAR, Date.parse(e.acceptedAt), e.quarter);
      if (day0 !== null) {
        if (!ownDay0.has(e.ticker)) ownDay0.set(e.ticker, []);
        ownDay0.get(e.ticker)!.push(day0);
      }
    }
    if (day0 === null) {
      funnel.noDay0++;
      continue;
    }
    if (day0 < flowFrom || day0 + H3_RULES.flowSessions - 1 > flowTo) {
      funnel.outsideFlow++;
      continue;
    }
    if (e.kind === "monthly_revenue" && !e.releasedOn) {
      funnel.noReleaseDate++;
      continue;
    }
    const sign = e.kind === "monthly_revenue" ? e.sign : signOf(e.quarter?.surprisePct ?? null);
    if (sign === null || sign === undefined) {
      funnel.noSign++;
      continue;
    }
    if (sign === 0) {
      funnel.zeroSign++;
      continue;
    }
    funnel.kept++;
    rippleEvents.push({ ticker: e.ticker, kind: e.kind, accession: e.accession, day0, sign: sign as Direction });
  }

  const cands: HitCandidate[] = [];
  for (const e of rippleEvents) {
    for (const p of walk(graph, e.ticker, 1)) {
      if (!universe.has(p.ticker)) continue;
      cands.push({
        hit: p.ticker,
        day0: e.day0,
        direction: e.sign,
        event: `${e.ticker}:${e.kind}:${CALENDAR[e.day0]}`,
        relation: p.relation,
        supplyChain: p.edges.some((x) => x.category !== "competitor"),
      });
    }
  }
  const deduped = dedupHits(cands);
  const hitsFunnel = { candidates: cands.length, afterDedup: deduped.length, ownEarnings: 0, noFlow: 0, noOutcome: 0, kept: 0 };

  // Name's median 3-session imbalance (for the de-biased secondary).
  const bias3 = new Map<string, number>();
  for (const t of FLOW_UNIVERSE) {
    const arr = flowByName.get(t)!;
    const xs: number[] = [];
    for (let i = flowFrom; i + 2 <= flowTo; i++) {
      const f = flowSum(arr, i, i + 2);
      if (f.buy + f.sell > 0 && f.days === 3) xs.push((f.buy - f.sell) / (f.buy + f.sell));
    }
    bias3.set(t, quantile(xs, 0.5));
  }

  type Hit = HitCandidate & { date: string; confirmed: boolean; confirmed1: boolean | null; confirmedDebiased: boolean | null; y10: number; y5: number; yAlone10: number; imbalance: number };
  const hits: Hit[] = [];
  for (const h of deduped) {
    if (ownEventNear(ownDay0.get(h.hit), h.day0, H3_RULES.ownEarningsBefore, H3_RULES.ownEarningsAfter)) {
      hitsFunnel.ownEarnings++;
      continue;
    }
    const arr = flowByName.get(h.hit)!;
    const f = flowSum(arr, h.day0, h.day0 + H3_RULES.flowSessions - 1);
    const c = confirms(f, h.direction);
    if (c === null) {
      hitsFunnel.noFlow++;
      continue;
    }
    const o3 = outcomeAt(h.hit, h.day0 + H3_RULES.flowSessions - 1);
    const o1 = outcomeAt(h.hit, h.day0);
    if (!Number.isFinite(o3.car10)) {
      hitsFunnel.noOutcome++;
      continue;
    }
    hitsFunnel.kept++;
    hits.push({
      ...h,
      date: CALENDAR[h.day0]!,
      confirmed: c,
      confirmed1: confirms(flowSum(arr, h.day0, h.day0), h.direction),
      confirmedDebiased: confirms(f, h.direction, bias3.get(h.hit) ?? 0),
      y10: h.direction * o3.car10 * 100,
      y5: h.direction * o3.car5 * 100,
      yAlone10: h.direction * o1.car10 * 100,
      imbalance: (f.buy - f.sell) / (f.buy + f.sell),
    });
  }
  log(`H3: ${rippleEvents.length} events in the window, ${cands.length} linked hits in the universe, ${hits.length} measured (${hits.filter((h) => h.confirmed).length} confirmed)`);

  const diff = (xs: Hit[], y: (h: Hit) => number, g: (h: Hit) => boolean | null) => {
    const ok = xs.filter((h) => Number.isFinite(y(h)) && g(h) !== null);
    return clusteredDiffTest(ok.map(y), ok.map((h) => g(h)!), ok.map((h) => h.date));
  };
  const h3Primary = diff(hits, (h) => h.y10, (h) => h.confirmed);
  const halves = splitHalves(hits);
  const h3Early = diff(halves.early, (h) => h.y10, (h) => h.confirmed);
  const h3Late = diff(halves.late, (h) => h.y10, (h) => h.confirmed);
  const h3Placebo = permutationP(h3Primary.diff, 1000, 20261115, (rnd) => {
    const perm = permuteWithin(hits.map((h) => h.confirmed), hits.map((h) => h.date), rnd);
    let s1 = 0, n1 = 0, s0 = 0, n0 = 0;
    hits.forEach((h, i) => {
      if (perm[i]) {
        s1 += h.y10;
        n1++;
      } else {
        s0 += h.y10;
        n0++;
      }
    });
    return n1 && n0 ? s1 / n1 - s0 / n0 : NaN;
  });
  const h3Secondary = {
    oneSession: diff(hits, (h) => h.yAlone10, (h) => h.confirmed1),
    supplyChain: diff(hits.filter((h) => h.supplyChain), (h) => h.y10, (h) => h.confirmed),
    competitorOnly: diff(hits.filter((h) => !h.supplyChain), (h) => h.y10, (h) => h.confirmed),
    debiased: diff(hits, (h) => h.y10, (h) => h.confirmedDebiased),
    car5: diff(hits, (h) => h.y5, (h) => h.confirmed),
  };
  const h3Lines: Line[] = [];
  const add = (l: Line | null) => l && h3Lines.push(l);
  add(line("ripple alone, entry day 0 + 1 (all hits)", hits.map((h) => h.yAlone10), hits.map((h) => h.date)));
  add(line("ripple alone, entry day 0 + 3 (all hits)", hits.map((h) => h.y10), hits.map((h) => h.date)));
  add(line("flow confirmed, entry day 0 + 3", hits.filter((h) => h.confirmed).map((h) => h.y10), hits.filter((h) => h.confirmed).map((h) => h.date)));
  add(line("flow not confirmed, entry day 0 + 3", hits.filter((h) => !h.confirmed).map((h) => h.y10), hits.filter((h) => !h.confirmed).map((h) => h.date)));
  add(line("confirmed, earnings events only", hits.filter((h) => h.confirmed && h.event.includes(":earnings:")).map((h) => h.y10), hits.filter((h) => h.confirmed && h.event.includes(":earnings:")).map((h) => h.date)));
  add(line("confirmed, monthly revenue only", hits.filter((h) => h.confirmed && h.event.includes(":monthly_revenue:")).map((h) => h.y10), hits.filter((h) => h.confirmed && h.event.includes(":monthly_revenue:")).map((h) => h.date)));
  // Did the reaction-window move already go the implied way? (flow and price move together)
  const reactionMove = hits.map((h) => {
    const p = prices.get(h.hit)!;
    const a = p.close[h.day0 - 1]!, b = p.close[h.day0 + 2]!;
    const ma = spy.close[h.day0 - 1]!, mb = spy.close[h.day0 + 2]!;
    return h.direction * ((b / a - 1) - (mb / ma - 1)) * 100;
  });
  const reactionByGroup = {
    confirmed: median(reactionMove.filter((_, i) => hits[i]!.confirmed)),
    notConfirmed: median(reactionMove.filter((_, i) => !hits[i]!.confirmed)),
  };

  // ------------------------------------------------------------------ pass bar
  const pH1 = h1L.primary?.p ?? 1;
  const pH3 = h3Primary.pOneSided;
  const bh = benjaminiHochberg([pH1, pH3], 0.05);
  const h1Enough = (h1L.primary?.n ?? 0) >= 30 && (h1L.primary?.g ?? 0) >= 20;
  const h3Enough = h3Primary.n1 >= 30 && h3Primary.n0 >= 30 && h3Primary.clusters >= 20;
  const h1Late = (h1L.primary?.late?.mean ?? NaN) > 0;
  const h3LateOk = h3Late.diff > 0;
  const verdict = {
    H1: { p: pH1, bhReject: bh[0]!, laterHalfPositive: h1Late, enough: h1Enough, pass: bh[0]! && h1Late && h1Enough },
    H3: { p: pH3, bhReject: bh[1]!, laterHalfPositive: h3LateOk, enough: h3Enough, pass: bh[1]! && h3LateOk && h3Enough },
  };

  // Ledger.
  const client = new DatabentoClient();
  const ledger = client.guard.entries().filter((e) => e.caller === CALLER);
  const spend = { lines: ledger.length, charges: ledger.filter((e) => e.kind === "charge").length, refunds: ledger.filter((e) => e.kind === "refund").length, usd: ledger.reduce((s, e) => s + e.costUsd, 0), ledgerTotalUsd: client.guard.spentUsd() };

  const results = {
    generatedAt: new Date().toISOString(),
    preregistration: "data/preregistration/flow-v1.json",
    panel: { sessions: FLOW_SESSIONS.length, inPanel: FLOW_SESSIONS.length - missing.length, from: FLOW_FROM, to: FLOW_TO, names: FLOW_UNIVERSE.length },
    spend,
    coverage: { overall: { signedOfItchDollar: totSigned$ / totItch$, signedOfConsolidatedDollar: totSigned$ / totCons$ }, perName: coverage },
    h1: {
      eligibleNameDays: h1.eligibleDays,
      rawSignalDays: h1.rawSignals,
      events: h1.events.length,
      thetas: h1.thetas,
      primary: h1L.primary,
      twoWay: tw1,
      blockClusters10: { t: block1.t, df: block1.df, clusters: block1.clusters },
      placebo: placebo1,
      secondary: h1Secondary,
      variants: variantInfo,
      eventList: h1L.events.map((e) => ({ ticker: e.ticker, date: e.date, car10: e.car10, control10: e.control10 })),
    },
    h3: {
      funnel,
      hitsFunnel,
      primary: h3Primary,
      early: h3Early,
      late: h3Late,
      placebo: h3Placebo,
      secondary: h3Secondary,
      lines: h3Lines,
      reactionMoveMedianPct: reactionByGroup,
      problems: evFile.problems,
      hitList: hits.map((h) => ({ hit: h.hit, date: h.date, event: h.event, direction: h.direction, confirmed: h.confirmed, imbalance: h.imbalance, y10: h.y10 })),
    },
    verdict,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 1));

  const dt = (d: ReturnType<typeof clusteredDiffTest>) =>
    `diff ${pct(d.diff)} (confirmed ${pct(d.mean1)}, n ${d.n1}; not ${pct(d.mean0)}, n ${d.n0}), t ${num(d.t)}, df ${d.df}, p ${num(d.pOneSided, 4)}`;
  const md: string[] = [];
  md.push(`# flow-v1 results (${results.generatedAt})`, "");
  md.push(`Panel: ${results.panel.inPanel}/${results.panel.sessions} sessions, ${FLOW_UNIVERSE.length} names. Spend (caller ${CALLER}): $${spend.usd.toFixed(2)} in ${spend.charges} charges, ${spend.refunds} refunds; ledger total $${spend.ledgerTotalUsd.toFixed(2)}.`);
  md.push(`Coverage: signed dollars are ${(results.coverage.overall.signedOfItchDollar * 100).toFixed(1)}% of Nasdaq ITCH dollars and ${(results.coverage.overall.signedOfConsolidatedDollar * 100).toFixed(1)}% of consolidated dollars.`, "");
  md.push(`## H1 quiet accumulation`, "", `${h1.eligibleDays} eligible name-days, ${h1.rawSignals} raw signal days, ${h1.events.length} events.`, "", TABLE_HEAD);
  md.push(fmtLine(h1L.primary));
  for (const l of h1Secondary) md.push(fmtLine(l));
  md.push("", `Primary robustness: two-way (firm x month) t ${num(tw1.t)}, p ${num(tw1.p, 4)}; 10-session block clusters t ${num(block1.t)} (${block1.clusters} blocks); placebo (flow flags shuffled within date, 1000 reps) null mean ${pct(placebo1.nullMean)}, sd ${num(placebo1.nullSd)}, permutation p ${num(placebo1.p, 4)}.`, "");
  md.push(`## H3 ripple + flow`, "", `Events: ${JSON.stringify(funnel)}`, `Hits: ${JSON.stringify(hitsFunnel)}`, "");
  md.push(`Primary (CAR10 from day 0 + 3, confirmed - not confirmed, clustered by day 0): ${dt(h3Primary)}`);
  md.push(`Early half: ${dt(h3Early)}`, `Late half: ${dt(h3Late)}`);
  md.push(`Placebo (labels permuted within day 0, 1000 reps): null mean ${pct(h3Placebo.nullMean)}, permutation p ${num(h3Placebo.p, 4)}`, "");
  for (const [k, d] of Object.entries(h3Secondary)) md.push(`Secondary ${k}: ${dt(d)}`);
  md.push("", `Median implied-way excess move over the flow window (close before day 0 to close of day 0 + 2): confirmed ${pct(reactionByGroup.confirmed)}, not confirmed ${pct(reactionByGroup.notConfirmed)}`, "", TABLE_HEAD);
  for (const l of h3Lines) md.push(fmtLine(l));
  md.push("", "## Verdict (pre-registered bar)", "", "```", JSON.stringify(verdict, null, 1), "```");
  md.push("", "## Coverage per name", "", "| name | days | signed / ITCH volume | signed $ / consolidated $ | auction share | mean daily imbalance |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [t, c] of Object.entries(coverage)) md.push(`| ${t} | ${c.days} | ${(c.signedShareNasdaq * 100).toFixed(1)}% | ${(c.signedShareConsolidated * 100).toFixed(1)}% | ${(c.auctionShare * 100).toFixed(1)}% | ${pct(c.meanDailyImbalance * 100, 1)} |`);
  fs.writeFileSync(RESULTS_MD, md.join("\n") + "\n");
  console.log(md.join("\n"));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const want = (p: string) => phases.includes(p);
  if (!phases.length) {
    console.log("phases: plan | pull | events | analyze");
    return;
  }
  if (want("plan")) await planPhase();
  if (want("pull")) await pullPhase();
  if (want("events")) await eventsPhase();
  if (want("analyze")) analyzePhase();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
