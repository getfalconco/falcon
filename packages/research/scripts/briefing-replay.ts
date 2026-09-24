/**
 * Handover briefing replay harness: build the report, or read its calendar
 * rules, without Electron.
 *
 *   pnpm --filter @meridian/research exec tsx scripts/briefing-replay.ts report --now 2026-12-18T12:00:00Z --positions NVDA:10,SPY:5,IWM:20[:COST_USD] [--cash 5000] [--json] [--live]
 *   pnpm --filter @meridian/research exec tsx scripts/briefing-replay.ts window --now 2026-09-28T12:00:00Z
 *   pnpm --filter @meridian/research exec tsx scripts/briefing-replay.ts calendar --from 2026-12-14 --to 2026-12-18
 *   pnpm --filter @meridian/research exec tsx scripts/briefing-replay.ts coverage [--now 2026-12-10T12:00:00Z]
 *
 * `report` leads with WHAT HAPPENED, the stories the engine built (what, the
 * reaction, what it means for the book, the evidence ids), then the
 * IMPLICATIONS, then the figures they rest on. It is OFFLINE by default: the
 * ports are the deterministic fixtures the tests use, dated against --now, so
 * the command runs anywhere and prints the same report every time. The prices
 * and headlines in it are made up; the window, the calendar, the
 * corporate-event rules, the stories, the implications and the narrative
 * template are the real engine. `--live` swaps in keyless Yahoo reads: chart
 * meta for the markets table and the held quotes, and search news over the
 * market symbols for the headlines; the chain, quant, risk and
 * corporate-calendar ports then answer "nothing known", because those live in
 * the desktop host. With no betas known, a --live report leads with the gap
 * that leaves rather than with a sized open.
 *
 * `calendar` prints every macro, expiry and rebalance line in a date range,
 * for checking by eye against the official pages listed in
 * src/briefing/data/macro-calendar.ts.
 *
 * `coverage` exits 1 when the curated calendar has fewer than 30 days left
 * from --now (default: the machine clock) or fails its own validator, so it
 * can sit in a scheduled check.
 *
 * Without --now the machine clock is used. Read-only: nothing is written.
 */

import { addCalendarDays, isEarlyClose, isTradingDay, nyParts, nyYmd, weekdayOf } from "../src/tracker/calendar.js";
import { expiryEventsBetween } from "../src/briefing/expiry.js";
import { gatherBriefing } from "../src/briefing/gather.js";
import { INDEX_FAMILY_LABEL } from "../src/briefing/index-map.js";
import { coverageStatus, loadMacroCalendar, macroEventsBetween, validateMacroCalendar } from "../src/briefing/macro-calendar.js";
import { MARKET_NEWS_SYMBOLS } from "../src/briefing/markets.js";
import { rebalanceEventsBetween } from "../src/briefing/rebalance.js";
import { fakePorts, fixtureHoldings } from "../src/briefing/test-fixtures.js";
import { resolveBriefingWindow } from "../src/briefing/window.js";
import type {
  BriefingHolding,
  BriefingPorts,
  BriefingReport,
  HeldQuote,
  HeldSession,
  MarketGroup,
  MarketHeadline,
  MarketRow,
  MarketSnapshot,
} from "../src/briefing/types.js";

const USAGE = `usage:
  briefing-replay.ts report   [--now <iso>] [--positions NVDA:10,SPY:5[:cost]] [--cash 5000] [--json] [--live]
  briefing-replay.ts window   [--now <iso>]
  briefing-replay.ts calendar --from <YYYY-MM-DD> --to <YYYY-MM-DD>
  briefing-replay.ts coverage [--now <iso>]`;

const COVERAGE_WARN_DAYS = 30;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

/** The clock of the run: --now when given, the machine's otherwise. */
function clock(): { now: Date; synthetic: boolean } {
  const raw = arg("--now");
  if (raw === null) return { now: new Date(), synthetic: false };
  const now = new Date(raw);
  if (Number.isNaN(now.getTime())) fail(`--now "${raw}" is not a readable instant (expected ISO, e.g. 2026-12-18T12:00:00Z)`);
  return { now, synthetic: true };
}

function parsePositions(spec: string): BriefingHolding[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [symbol, shares, cost] = s.split(":");
      const n = Number(shares ?? "1");
      const c = cost == null ? 0 : Number(cost);
      if (!symbol || !Number.isFinite(n) || !Number.isFinite(c)) fail(`bad position "${s}" (expected TICKER:SHARES[:COST_USD])`);
      return { symbol: symbol.toUpperCase(), shares: n, cost_usd: c };
    });
}

function nyClock(iso: string): string {
  const p = nyParts(new Date(iso));
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${WEEKDAYS[p.weekday]} ${p.y}-${two(p.m)}-${two(p.d)} ${two(p.hh)}:${two(p.mm)} ET`;
}

// ---------------------------------------------------------------------------
// --live ports: keyless Yahoo chart and search reads
// ---------------------------------------------------------------------------

/** The endpoints answer 429 to a client that does not look like a browser. */
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json",
};

const CHART_TIMEOUT_MS = 8000;
/** The same bound the desktop's briefing reads give themselves. */
const SEARCH_TIMEOUT_MS = 6000;

type ChartMeta = {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  currentTradingPeriod?: Record<"pre" | "regular" | "post", { start?: number; end?: number } | undefined>;
};

type Chart = { meta: ChartMeta; timestamps: number[]; closes: Array<number | null> };

async function fetchChart(symbol: string): Promise<Chart> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
  const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(CHART_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`chart ${symbol}: HTTP ${response.status}`);
  const body = (await response.json()) as { chart?: { result?: Array<{ meta?: ChartMeta; timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
  const result = body.chart?.result?.[0];
  if (!result?.meta) throw new Error(`chart ${symbol}: no result`);
  return { meta: result.meta, timestamps: result.timestamp ?? [], closes: result.indicators?.quote?.[0]?.close ?? [] };
}

type SearchNews = {
  uuid?: string;
  title?: string;
  link?: string;
  publisher?: string;
  providerPublishTime?: number;
  relatedTickers?: string[];
};

/**
 * The search endpoint's news for one symbol, as the stock view's news reader
 * uses it: a symbol query answers with headlines tagged to it, which is what
 * makes the market symbols a way of reading the tape.
 */
async function fetchSearchNews(symbol: string): Promise<MarketHeadline[]> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=10`;
  const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`search ${symbol}: HTTP ${response.status}`);
  const body = (await response.json()) as { news?: SearchNews[] };
  return (body.news ?? []).flatMap((item) => {
    if (!item.title || !item.link || typeof item.providerPublishTime !== "number") return [];
    return [
      {
        id: item.uuid ?? item.link,
        title: item.title,
        source: item.publisher ?? "",
        url: item.link,
        published_at: new Date(item.providerPublishTime * 1000).toISOString(),
        related: item.relatedTickers ?? [],
        via: symbol,
      },
    ];
  });
}

function within(period: { start?: number; end?: number } | undefined, seconds: number): boolean {
  return period?.start != null && period.end != null && seconds >= period.start && seconds < period.end;
}

function isoOf(seconds: number | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function livePorts(now: Date): BriefingPorts {
  const seconds = now.getTime() / 1000;
  return {
    async marketSnapshot(symbol): Promise<MarketSnapshot> {
      const { meta } = await fetchChart(symbol);
      return {
        symbol,
        price: meta.regularMarketPrice ?? null,
        previous_close: meta.chartPreviousClose ?? meta.previousClose ?? null,
        market_time: isoOf(meta.regularMarketTime),
        in_regular_session: within(meta.currentTradingPeriod?.regular, seconds),
        // `previous_close` is the close of the chart day BEFORE this one, so
        // the engine needs to know when this one opened. For these symbols a
        // chart day is the ET calendar day: from 16:00 ET onwards the baseline
        // belongs to a session before the one the report measures from, and
        // without this the evening rows carry a whole extra session as their
        // overnight move (see `marketRow`).
        session_start: isoOf(meta.currentTradingPeriod?.regular?.start),
      };
    },
    async heldQuote(symbol): Promise<HeldQuote> {
      const { meta, timestamps, closes } = await fetchChart(symbol);
      // The newest bar that carries a price: with pre and post bars included
      // that is the extended-hours print while the regular session is shut.
      let last = closes.length - 1;
      while (last >= 0 && typeof closes[last] !== "number") last -= 1;
      const periods = meta.currentTradingPeriod;
      const session: HeldSession = within(periods?.regular, seconds)
        ? "regular"
        : within(periods?.pre, seconds)
          ? "pre"
          : within(periods?.post, seconds)
            ? "post"
            : "closed";
      return {
        symbol,
        price: last >= 0 ? (closes[last] as number) : (meta.regularMarketPrice ?? null),
        regular_price: meta.regularMarketPrice ?? null,
        previous_close: meta.chartPreviousClose ?? meta.previousClose ?? null,
        session,
        as_of: last >= 0 ? isoOf(timestamps[last]) : isoOf(meta.regularMarketTime),
      };
    },
    async marketNews(since): Promise<MarketHeadline[]> {
      // Every query symbol at once; one symbol failing costs its headlines,
      // not the section. The engine de-duplicates and caps again on its side.
      const sinceMs = Date.parse(since);
      const settled = await Promise.allSettled(MARKET_NEWS_SYMBOLS.map((symbol) => fetchSearchNews(symbol)));
      const seen = new Set<string>();
      const out: MarketHeadline[] = [];
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const h of result.value) {
          if (Date.parse(h.published_at) < sinceMs || seen.has(h.url)) continue;
          seen.add(h.url);
          out.push(h);
        }
      }
      return out.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    },
    quant: async () => null,
    chainSlice: async (ticker) => ({ ticker, coverage: "pending", news: [], filings: [], measurements: [], scheduled_earnings: [] }),
    riskLatest: async () => null,
    corporateCalendar: async (symbol) => ({
      symbol,
      available: false,
      ex_dividend_date: null,
      dividend_date: null,
      dividend_rate: null,
      earnings_dates: [],
      earnings_estimated: null,
      recent_dividends: [],
      recent_splits: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const GROUP_LABEL: Record<MarketGroup, string> = { asia: "Asia", europe: "Europe", us_futures: "US futures", macro: "Macro" };

/** A scenario's dollar size, which the panel masks in privacy mode; a developer tool prints it. */
function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function signed(value: number, decimals = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}`;
}

function moveText(row: MarketRow): string {
  if (row.move === null) return row.state === "unavailable" ? "unavailable" : `move withheld (${row.state})`;
  const unit = row.unit === "pct" ? "%" : row.unit === "bp" ? " bp" : " pts";
  return `${signed(row.move, row.unit === "bp" ? 1 : 2)}${unit}  ${row.state}${row.basis === "prior_settle" ? ", from prior settle" : ""}`;
}

function printReport(report: BriefingReport, mode: string): void {
  const w = report.window;
  console.log(`HANDOVER to ${w.target_session_ymd} | phase ${w.phase} | handover ${w.handover}${w.early_close ? " | EARLY CLOSE" : ""} | ${mode}`);
  console.log(`  generated ${report.generated_at} (${nyClock(report.generated_at)})${report.synthetic_now ? " | developer clock" : ""}`);
  console.log(`  overnight since ${w.overnight_since} | window opens ${w.window_opens_at} | open ${w.target_open_at} | close ${w.target_close_at} | auto_show ${w.auto_show}`);

  // First, as in the panel: what happened leads, and everything below is its evidence.
  console.log("\nWHAT HAPPENED");
  report.stories.forEach((s, i) => {
    console.log(`  ${i + 1}. [${s.scope}${s.source === "model" ? ", model" : ""}${s.at ? `, ${s.at}` : ""}] ${s.what}`);
    console.log(`     reaction: ${s.reaction}`);
    if (s.meaning !== null) console.log(`     meaning:  ${s.meaning}`);
    const chips = s.reactions.map((r) => `${r.label} ${r.move === null ? "n/a" : signed(r.move, r.unit === "bp" ? 1 : 2)}${r.unit === "pct" ? "%" : ` ${r.unit}`}`);
    if (chips.length > 0) console.log(`     chips:    ${chips.join(" | ")}`);
    console.log(`     evidence: ${s.evidence.join(", ") || "(none)"}`);
  });
  if (report.stories.length === 0) console.log("  (none)");

  console.log("\nIMPLICATIONS");
  report.implications.forEach((item, i) => {
    const size = item.book_pct === null ? "" : `  [${item.kind}, ${signed(item.book_pct)}% of book]`;
    console.log(`  ${i + 1}. ${item.headline}${size}`);
    console.log(`     because: ${item.because}`);
    if (item.scenario !== null) console.log(`     scenario: ${item.scenario}${item.scenario_usd === null ? "" : ` (${usd(item.scenario_usd)})`}`);
  });
  if (report.implications.length === 0) console.log("  (none)");

  console.log("\nNARRATIVE");
  console.log(`  [${report.narrative.source}${report.narrative.pending ? ", model pending" : ""}, facts ${report.facts_hash}] ${report.narrative.text}`);

  console.log("\nOVERNIGHT MARKETS");
  for (const group of Object.keys(GROUP_LABEL) as MarketGroup[]) {
    console.log(`  ${GROUP_LABEL[group]}`);
    for (const row of report.overnight.markets.filter((r) => r.group === group)) {
      console.log(`    ${row.label.padEnd(22)} ${(row.last === null ? "n/a" : String(row.last)).padStart(10)}  ${moveText(row)}${row.as_of ? `  @ ${row.as_of}` : ""}`);
    }
  }

  console.log("\nMARKET HEADLINES");
  for (const h of report.headlines) console.log(`  ${h.published_at}  [${h.id}] via ${h.via}${h.related.length ? ` (${h.related.join(",")})` : ""}: ${h.title} | ${h.source}`);
  if (report.headlines.length === 0) console.log("  (none since the close)");

  console.log("\nHELD NAMES");
  const coverage = new Map(report.held_coverage.map((c) => [c.ticker, c.coverage]));
  for (const m of report.overnight.held_movers) {
    const z = m.move_z === null ? "z n/a" : `z ${signed(m.move_z)}`;
    console.log(`  ${m.ticker.padEnd(6)} ${signed(m.move_pct)}%  ${z.padEnd(8)} pnl ${signed(m.pnl_usd)}  ${m.basis}, ${m.session}  [${coverage.get(m.ticker) ?? "?"}]${m.flag ? `  FLAG ${m.flag}` : ""}`);
  }
  for (const c of report.held_coverage) {
    if (!report.overnight.held_movers.some((m) => m.ticker === c.ticker)) console.log(`  ${c.ticker.padEnd(6)} no usable quote  [${c.coverage}]`);
  }
  if (report.held_coverage.length === 0) console.log("  (no holdings)");
  for (const n of report.overnight.held_news) console.log(`  news    ${n.band} ${n.ticker}${n.also.length ? ` (+${n.also.join(",")})` : ""} [${n.incident_id}]: ${n.headline} | ${n.source} ${n.published_at}`);
  for (const f of report.overnight.filings) console.log(`  filing  ${f.ticker}: ${f.label} | ${f.filed_at} | ${f.url}`);
  for (const m of report.overnight.measurements) console.log(`  measure ${m.ticker} ${m.type}: ${m.detail}`);

  const b = report.book;
  console.log("\nBOOK");
  console.log(`  equity ${b.equity_usd} | cash ${b.cash_usd} | invested ${b.invested_usd} | net ${b.net_exposure_pct}% | gross ${b.gross_exposure_pct}% | positions ${b.position_count}`);
  console.log(`  since close: ${b.overnight_pnl_usd === null ? "n/a" : `${signed(b.overnight_pnl_usd)} (${b.overnight_pnl_pct === null ? "n/a" : `${signed(b.overnight_pnl_pct)}%`})`}${b.unpriced.length ? ` | unpriced ${b.unpriced.join(",")}` : ""}`);
  console.log(`  weights: ${b.top_weights.map((t) => `${t.ticker} ${(t.weight * 100).toFixed(1)}% ${t.side}`).join(" | ") || "none"}`);
  const r = report.risk;
  console.log(`  risk: ${r === null ? "no snapshot" : `${r.score} ${r.band} | ${r.driver_component}: ${r.driver_sentence} | matches_book ${r.matches_book}`}`);

  console.log("\nCORPORATE EVENTS");
  for (const e of report.corporate_events) {
    console.log(`  ${e.date} (${e.sessions_until >= 0 ? `in ${e.sessions_until}` : `${-e.sessions_until} ago`}) ${e.kind.padEnd(9)} ${e.title} [${e.certainty}, ${e.source}]${e.affects_held.length ? ` -> ${e.affects_held.join(",")}` : ""}`);
    console.log(`      ${e.detail}`);
  }
  if (report.corporate_events.length === 0) console.log("  (none listed)");
  console.log(`  coverage: ${report.corporate_coverage.dividends}`);
  console.log(`  coverage: ${report.corporate_coverage.splits}`);
  if (report.corporate_coverage.unknown_symbols.length) console.log(`  no provider calendar for: ${report.corporate_coverage.unknown_symbols.join(", ")}`);

  console.log(`\nCALENDAR ${w.target_session_ymd}`);
  for (const c of report.calendar_today) {
    console.log(`  ${(c.time_et ?? "all-day").padEnd(7)} ${c.kind.padEnd(9)} imp ${c.importance}  ${c.title}${c.tickers.length ? ` [${c.tickers.join(",")}]` : ""}${c.detail ? ` | ${c.detail}` : ""}${c.at ? ` | ${c.at}` : ""}`);
  }
  if (report.calendar_today.length === 0) console.log("  (no items)");
  const cov = report.calendar_coverage;
  console.log(`  macro file ${cov.from}..${cov.until}, compiled ${cov.compiled_at}, covers this session: ${cov.covers_target}, days left ${cov.days_left}`);

  console.log("\nDEGRADED");
  for (const d of report.degraded) console.log(`  ${d.section}: ${d.detail}${d.symbols?.length ? ` (${d.symbols.join(", ")})` : ""}`);
  if (report.degraded.length === 0) console.log("  (nothing)");
}

async function report(): Promise<void> {
  const { now, synthetic } = clock();
  const positionsArg = arg("--positions");
  const holdings = positionsArg ? parsePositions(positionsArg) : fixtureHoldings();
  const cash = Number(arg("--cash") ?? "5000");
  if (!Number.isFinite(cash)) fail(`--cash "${arg("--cash")}" is not a number`);

  const live = process.argv.includes("--live");
  if (live && synthetic) console.error("note: --live reads the market as it is now; --now only moves the session window");
  const ports = live ? livePorts(now) : fakePorts({}, { now, riskTickers: holdings.map((h) => h.symbol) });

  const built = await gatherBriefing({ holdings, cash }, now, ports, { syntheticNow: synthetic });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(built, null, 2));
    return;
  }
  printReport(built, live ? "LIVE Yahoo quotes and search news; chain, risk and corporate calendar not connected" : "OFFLINE fixture ports (prices and headlines are made up)");
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function windowCommand(): void {
  const { now } = clock();
  const w = resolveBriefingWindow(now);
  console.log(`now              ${now.toISOString()}  (${nyClock(now.toISOString())})`);
  console.log(`target session   ${w.target_session_ymd}${w.early_close ? "  (early close, 13:00 ET)" : ""}`);
  console.log(`previous session ${w.prev_session_ymd}`);
  console.log(`handover         ${w.handover}`);
  console.log(`phase            ${w.phase}  (auto_show ${w.auto_show})`);
  console.log(`overnight since  ${w.overnight_since}  (${nyClock(w.overnight_since)})`);
  console.log(`window opens     ${w.window_opens_at}  (${nyClock(w.window_opens_at)})`);
  console.log(`target open      ${w.target_open_at}  (${nyClock(w.target_open_at)})`);
  console.log(`target close     ${w.target_close_at}  (${nyClock(w.target_close_at)})`);
}

// ---------------------------------------------------------------------------
// calendar
// ---------------------------------------------------------------------------

function calendarCommand(): void {
  const from = arg("--from");
  const to = arg("--to");
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !ymd.test(from) || !ymd.test(to)) fail("calendar needs --from and --to as YYYY-MM-DD");
  if (to < from) fail("--to is before --from");

  const cal = loadMacroCalendar(null);
  const macro = macroEventsBetween(from, to, cal);
  const expiries = expiryEventsBetween(from, to);
  const rebalances = rebalanceEventsBetween(from, to, cal.index_events);
  console.log(`macro file ${cal.coverage.from}..${cal.coverage.until} (compiled ${cal.compiled_at}); expiry and S&P / Nasdaq-100 dates are rule-derived and have no end`);

  for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
    const status = !isTradingDay(day) ? "  market closed" : isEarlyClose(day) ? "  early close 13:00 ET" : "";
    const covered = day >= cal.coverage.from && day <= cal.coverage.until;
    console.log(`\n${day} ${WEEKDAYS[weekdayOf(day)]}${status}${covered ? "" : "  (outside the macro file: releases not listed)"}`);
    const lines: string[] = [];
    for (const e of macro.filter((x) => x.date === day)) {
      lines.push(`  ${(e.time_et ?? "--:--").padEnd(7)} ${e.kind.padEnd(9)} imp ${e.importance}  ${e.title}${e.period ? ` (${e.period})` : ""}  [${e.code}, ${e.source}]`);
    }
    for (const e of expiries.filter((x) => x.date === day)) lines.push(`  all-day opex      ${e.title} | ${e.detail}  [${e.kind}, rule]`);
    for (const e of rebalances.filter((x) => x.date === day)) {
      lines.push(`  close   rebalance ${e.title} | ${INDEX_FAMILY_LABEL[e.family]} | ${e.detail}  [${e.certainty}, ${e.source}]`);
    }
    console.log(lines.length ? lines.join("\n") : "  (nothing listed)");
  }
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

function coverageCommand(): void {
  const { now } = clock();
  const today = nyYmd(now);
  const cal = loadMacroCalendar(null);
  const status = coverageStatus(today, cal);
  console.log(`today (NY)   ${today}`);
  console.log(`macro file   ${status.from}..${status.until}, compiled ${status.compiled_at}`);
  console.log(`covers today ${status.covers_target}`);
  console.log(`days left    ${status.days_left}`);
  console.log(`rows         ${cal.events.length} events, ${cal.index_events.length} index events, ${cal.session_overrides.length} session overrides`);
  for (const source of cal.sources) console.log(`  ${source.id.padEnd(13)} published through ${cal.per_source_until[source.id] ?? "?"}  (read ${source.retrieved_at})  ${source.url}`);

  const problems = validateMacroCalendar(cal);
  for (const p of problems) console.log(`INVALID: ${p}`);
  if (status.days_left < COVERAGE_WARN_DAYS) {
    console.log(`REFRESH DUE: fewer than ${COVERAGE_WARN_DAYS} days of macro calendar remain. Recompile src/briefing/data/macro-calendar.ts from the sources above.`);
  }
  if (problems.length > 0 || status.days_left < COVERAGE_WARN_DAYS) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "report") await report();
else if (cmd === "window") windowCommand();
else if (cmd === "calendar") calendarCommand();
else if (cmd === "coverage") coverageCommand();
else {
  console.error(USAGE);
  process.exit(1);
}
