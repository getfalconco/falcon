/**
 * Event-driven strategy tests from a declared rule spec (the `event_backtest`
 * tool). Pure and browser-safe: the tool's input schema and parser, the rules
 * in plain words (the results panel and the model show them), the spec block
 * a result carries, and the independent check that a result's trades follow
 * its declared rules (the server feeds it Falcon's events table and the daily
 * bars: lib/desk/event-backtest-run.ts).
 *
 * The rules run in Falcon's own Python helper (lib/desk/event-backtest-py.ts),
 * never in a script the model writes, so the same question always gives the
 * same numbers. Canonical rules have exactly the helper's keys (DEFAULTS in
 * the helper); the helper hashes them (sha256 of the sorted JSON) and derives
 * the random comparison's picks from that hash.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { CAVEAT_FLAGS, EVENT_KINDS, parseDateBound, parseKinds, parseReturn, parseSector, pctText, type EventKind } from "./tools/events";
import { ToolError, normalizeTicker, nyParts } from "./tools/util";
import type { RunTrade } from "./run-result";

export const EVENT_BACKTEST_TOOL_NAME = "event_backtest";

export const EVENT_MEASURES = ["stock_return_d0", "abnormal_return_d0", "stock_return_d1", "abnormal_return_d1", "stock_return_d0_d1", "abnormal_return_d0_d1"] as const;
export type EventMeasure = (typeof EVENT_MEASURES)[number];
const D1_MEASURES: readonly EventMeasure[] = ["stock_return_d1", "abnormal_return_d1", "stock_return_d0_d1", "abnormal_return_d0_d1"];

/** Quality flags a test may leave out (cik_mismatch and price_source_disagree are always left out). */
export const EXCLUDABLE_FLAGS = ["suspicious_move", "amended", "multiple_same_day", "etf_fallback_spy", "missing_price", "before_first_price"] as const;

export const EVENT_DEFAULTS = {
  event_kinds: ["earnings"] as EventKind[],
  measure: "stock_return_d0" as EventMeasure,
  direction: "up" as const,
  entry: "next_open" as const,
  max_positions: 20,
  costs_bps: 5,
  benchmark: "SPY",
};

/** The canonical rules: exactly the helper's keys, defaults filled in. */
export type EventRules = {
  version: 1;
  event_kinds: EventKind[];
  measure: EventMeasure;
  direction: "up" | "down" | "both";
  /** Decimal, 0.1 = 10%; up: measure > threshold, down: measure < -threshold, both: |measure| > threshold. */
  threshold: number;
  since: string;
  until: string | null;
  exclude_flags: string[];
  tickers: string[] | null;
  sector_etf: string | null;
  entry: "next_open" | "next_close";
  hold_days: number;
  max_positions: number;
  costs_bps: number;
  benchmark: string;
};

export const EVENT_BACKTEST_TOOL = {
  name: EVENT_BACKTEST_TOOL_NAME,
  description:
    "Runs Falcon's own, unit-tested event-backtest helper in the sandbox from rules you declare here (no script to write): use it for EVERY event-driven strategy test (a trade after an earnings release or another 8-K Item 2.02 event in Falcon's events table: a move filter, an entry after the event, a fixed holding period, compared with a benchmark). Deterministic: the same rules always give the same numbers. " +
    "Call it after load_events and load_prices have returned (a later step, never in the same step): it reads the files of the latest load_events and load_prices calls of this reply; load_events must hold every event the rules need (same or broader filter, since on or before the rules' since) and load_prices must be tickers_from_events of that file with open and close. " +
    "It writes falcon_result.json (shown in the results panel) and returns the rules in plain words, the event counts, a check that every trade follows the rules, and the script_path to pass to audit_run next. " +
    "Fixed defaults (use them unless the member says otherwise, and state them): 'rises/falls more than X% on earnings' = the stock's own close-to-close return on the reaction day d0 (stock_return_d0) above +X% (below -X% for falls), quarterly earnings releases only; 'buy the next day' = entry next_open, the open of the first trading day after d0's close; 'hold N days' = hold_days N trading days, sold at the close of the Nth (the entry day counts as day 1); at most 20 positions at once, each 1/20 of equity (busy days: the largest move first; a stock already held is not bought again); 5 bps per side; SPY. Only for a rule it cannot express (stops, scaling in, signals from prices or other data, shorts with borrow costs) write a custom script instead, and then say in the answer that the result came from a custom script written for this question.",
  input_schema: {
    type: "object",
    properties: {
      threshold: { type: ["number", "string"], description: "The move filter's size: 10, \"10%\" or 0.1 all mean 10%. Strict: up keeps measure > +threshold, down keeps measure < -threshold, both keeps |measure| > threshold." },
      direction: { type: "string", enum: ["up", "down", "both"], description: "up (default): rises; down: falls; both." },
      measure: {
        type: "string",
        enum: [...EVENT_MEASURES],
        description: "The return the filter reads (default stock_return_d0: the stock's own close-to-close return on the reaction day d0). abnormal_* is the stock minus its sector ETF; *_d1 is the next day alone; *_d0_d1 is both days (known only at d1's close, so the entry moves one day later).",
      },
      event_kinds: { type: "array", items: { type: "string", enum: [...EVENT_KINDS] }, description: "Which Item 2.02 filings (default [\"earnings\"]: quarterly earnings releases)." },
      since: { type: "string", maxLength: 10, description: "First event day and test start, YYYY-MM-DD (e.g. 2016-01-01 for 'since 2016')." },
      until: { type: "string", maxLength: 10, description: "Last event day and test end, YYYY-MM-DD (default: the last day with prices)." },
      entry: { type: "string", enum: ["next_open", "next_close"], description: "next_open (default): the open of the first trading day after the day whose close made the signal; next_close: that day's close." },
      hold_days: { type: "integer", minimum: 1, maximum: 250, description: "Trading days held; sold at the close of the last one (with next_open the entry day counts as day 1)." },
      max_positions: { type: "integer", minimum: 1, maximum: 200, description: "Positions open at once (default 20), each 1/max_positions of equity at entry; events beyond that are skipped." },
      costs_bps: { type: "number", minimum: 0, maximum: 200, description: "Cost per side in basis points (default 5)." },
      benchmark: { type: "string", maxLength: 10, description: "Benchmark ticker in the prices file (default SPY)." },
      exclude_flags: { type: "array", items: { type: "string", enum: [...EXCLUDABLE_FLAGS] }, description: "Quality flags to leave out (default none; cik_mismatch and price_source_disagree are always left out)." },
      tickers: { type: "array", items: { type: "string", maxLength: 10 }, maxItems: 600, description: "Only these companies' events (default: every company)." },
      sector: { type: "string", maxLength: 40, description: "Only one sector: a GICS sector name or its SPDR ETF (XLK)." },
    },
    required: ["threshold", "since", "hold_days"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

type Input = Record<string, unknown>;
const blank = (v: unknown) => v === undefined || v === null || v === "";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function int(v: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (blank(v)) {
    if (fallback === undefined) throw new ToolError(`${field} is required.`);
    return fallback;
  }
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`${field} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The tool's input as canonical rules (defaults filled in, lists sorted). Throws ToolError with a message the model can act on. */
export function parseEventBacktestInput(input: unknown): EventRules {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  if (blank(i.threshold)) throw new ToolError("threshold is required, e.g. 10% for 'more than 10%'.");
  const t = parseReturn(i.threshold);
  const dirRaw = blank(i.direction) ? null : String(i.direction).toLowerCase();
  if (dirRaw !== null && !["up", "down", "both"].includes(dirRaw)) throw new ToolError("direction must be up, down or both.");
  if (t.sign && dirRaw && dirRaw !== "both" && dirRaw !== t.sign) throw new ToolError(`threshold says ${t.sign} but direction says ${dirRaw}.`);
  const direction = (t.sign ?? dirRaw ?? EVENT_DEFAULTS.direction) as EventRules["direction"];
  const measure = blank(i.measure) ? EVENT_DEFAULTS.measure : String(i.measure).trim().toLowerCase();
  if (!(EVENT_MEASURES as readonly string[]).includes(measure)) throw new ToolError(`measure must be one of ${EVENT_MEASURES.join(", ")}.`);
  const since = parseDateBound(i.since, "since");
  if (!since) throw new ToolError("since is required (YYYY-MM-DD), e.g. 2016-01-01 for 'since 2016'.");
  const until = parseDateBound(i.until, "until");
  if (until && until <= since) throw new ToolError("until must be after since.");
  const entry = blank(i.entry) ? EVENT_DEFAULTS.entry : String(i.entry).trim().toLowerCase();
  if (entry !== "next_open" && entry !== "next_close") throw new ToolError("entry must be next_open or next_close.");
  const flags = Array.isArray(i.exclude_flags) ? i.exclude_flags.map((f) => String(f).trim().toLowerCase()) : [];
  const badFlag = flags.find((f) => !(EXCLUDABLE_FLAGS as readonly string[]).includes(f));
  if (badFlag) throw new ToolError(`exclude_flags: "${badFlag.slice(0, 30)}" is not one of ${EXCLUDABLE_FLAGS.join(", ")}.`);
  let tickers: string[] | null = null;
  if (Array.isArray(i.tickers) && i.tickers.length) {
    const set = new Set<string>();
    for (const x of i.tickers) {
      try {
        set.add(normalizeTicker(x).replace(/\./g, "-"));
      } catch {
        throw new ToolError(`Not a US ticker: ${String(x).slice(0, 12)}.`);
      }
    }
    tickers = [...set].sort();
  }
  const costs = blank(i.costs_bps) ? EVENT_DEFAULTS.costs_bps : Number(i.costs_bps);
  if (!Number.isFinite(costs) || costs < 0 || costs > 200) throw new ToolError("costs_bps must be a number from 0 to 200.");
  let benchmark = EVENT_DEFAULTS.benchmark;
  if (!blank(i.benchmark)) {
    try {
      benchmark = normalizeTicker(i.benchmark).replace(/\./g, "-");
    } catch {
      throw new ToolError("benchmark must be a ticker such as SPY.");
    }
  }
  return {
    version: 1,
    event_kinds: parseKinds(i.event_kinds ?? i.kinds),
    measure: measure as EventMeasure,
    direction,
    threshold: t.value,
    since,
    until,
    exclude_flags: [...new Set(flags)].sort(),
    tickers,
    sector_etf: parseSector(i.sector),
    entry,
    hold_days: int(i.hold_days, "hold_days", 1, 250),
    max_positions: int(i.max_positions, "max_positions", 1, 200, EVENT_DEFAULTS.max_positions),
    costs_bps: Math.round(costs * 1e4) / 1e4,
    benchmark,
  };
}

/** Rules read back from a result (lenient): null when they are not a usable spec. */
export function rulesFromResult(v: unknown): EventRules | null {
  try {
    const o = (v && typeof v === "object" ? v : {}) as Input;
    const { sector_etf, version: _v, ...rest } = o;
    return parseEventBacktestInput({ ...rest, sector: sector_etf, threshold: typeof o.threshold === "number" ? `${o.threshold * 100}%` : undefined });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ plain words */

const MEASURE_WORDS: Record<EventMeasure, string> = {
  stock_return_d0: "the stock's own close-to-close return on the reaction day (d0)",
  abnormal_return_d0: "the stock's return minus its sector ETF's on the reaction day (d0)",
  stock_return_d1: "the stock's own return on the day after the reaction day (d1)",
  abnormal_return_d1: "the stock's return minus its sector ETF's on the day after the reaction day (d1)",
  stock_return_d0_d1: "the stock's own return over the reaction day and the next day (d0 and d1)",
  abnormal_return_d0_d1: "the stock's return minus its sector ETF's over the reaction day and the next day (d0 and d1)",
};
const KIND_WORDS: Record<EventKind, string> = { earnings: "quarterly earnings releases", preliminary: "preliminary results", operational_update: "operational updates", other: "other Item 2.02 filings" };
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const sign = (r: EventRules) => (r.direction === "up" ? `above +${pctText(r.threshold)}` : r.direction === "down" ? `below -${pctText(r.threshold)}` : `beyond ±${pctText(r.threshold)}`);

/** The rules as the member reads them (panel and reply), one line per part. */
export function describeEventRules(r: EventRules): string[] {
  const kinds = r.event_kinds.map((k) => KIND_WORDS[k]).join(", ");
  const d1 = D1_MEASURES.includes(r.measure);
  const signalDay = d1 ? "d1" : "d0";
  const scope = [r.tickers ? (r.tickers.length <= 6 ? r.tickers.join(", ") : `${r.tickers.length} companies`) : null, r.sector_etf ? `sector ${r.sector_etf}` : null].filter(Boolean).join(", ");
  return [
    `Events: ${kinds} (SEC 8-K Item 2.02) in Falcon's events table${scope ? ` (${scope})` : ""}, ${r.since} to ${r.until ?? "the last day with prices"}.`,
    `Filter: ${MEASURE_WORDS[r.measure]} ${sign(r)}.${r.exclude_flags.length ? ` Rows flagged ${r.exclude_flags.join(", ")} left out.` : ""}`,
    `Timing: d0 is the filing day if the 8-K was accepted before 4:00 pm ET, else the next trading day; the filter is known at ${signalDay}'s close.`,
    `Entry: ${r.entry === "next_open" ? "buy at the open" : "buy at the close"} of the first trading day after ${signalDay} (no look-ahead).`,
    `Exit: sell at the close of the ${ordinal(r.hold_days)} trading day held${r.entry === "next_open" ? " (the entry day counts as day 1)" : " after the entry day"}; with no price that day, at the next close, or the last close if the stock stopped trading.`,
    `Positions: at most ${r.max_positions} at once, each 1/${r.max_positions} of equity at entry; when all are taken new events are skipped (on a busy day the largest move goes first); a stock already held is not bought again; cash earns nothing.`,
    `Costs and benchmark: ${r.costs_bps} bps per side; ${r.benchmark} held throughout.`,
  ];
}

/** "Earnings jump above +10%: buy next open, hold 5 days". */
export function eventTestName(r: EventRules): string {
  const what = r.event_kinds.length === 1 && r.event_kinds[0] === "earnings" ? "Earnings" : "Event";
  const move = r.direction === "up" ? `jump above +${pctText(r.threshold)}` : r.direction === "down" ? `drop below -${pctText(r.threshold)}` : `move beyond ±${pctText(r.threshold)}`;
  return `${what} ${move}: buy next ${r.entry === "next_open" ? "open" : "close"}, hold ${r.hold_days} day${r.hold_days === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ the spec a result carries */

export type EventCheckStatus = "pass" | "flag" | "skipped";

/** Whether a result's trades follow its declared rules (checkEventTrades). */
export type EventCheck = {
  status: EventCheckStatus;
  detail: string;
  items: string[];
  /** Qualifying events in Falcon's table (server side), before duplicates and timing. */
  qualifying: number | null;
  /** What the helper counted in the file it read. */
  helperQualifying: number | null;
  entered: number;
  /** Qualifying events the rules should have entered (after skips the trades explain). */
  expected: number | null;
  explained: Record<string, number>;
  unexplained: number;
  wrong: Record<string, number>;
};

export type EventSpecInfo = {
  kind: "event_backtest";
  helper_version: number;
  hash: string;
  rules: EventRules;
  counts: { events_in_file: number | null; qualifying: number | null; entered: number | null; closed: number | null; open_at_end: number | null; skipped: Record<string, number> };
  /** Set by the server after the run (and again by the audit). */
  check?: EventCheck;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function cleanCheck(v: unknown): EventCheck | undefined {
  const c = objOf(v);
  if (c.status !== "pass" && c.status !== "flag" && c.status !== "skipped") return undefined;
  const counts = (x: unknown) => Object.fromEntries(Object.entries(objOf(x)).flatMap(([k, n]) => (num(n) !== null ? [[k.slice(0, 30), num(n)!]] : [])).slice(0, 20));
  return {
    status: c.status,
    detail: typeof c.detail === "string" ? c.detail.slice(0, 800) : "",
    items: (Array.isArray(c.items) ? c.items : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 10),
    qualifying: num(c.qualifying),
    helperQualifying: num(c.helperQualifying),
    entered: num(c.entered) ?? 0,
    expected: num(c.expected),
    explained: counts(c.explained),
    unexplained: num(c.unexplained) ?? 0,
    wrong: counts(c.wrong),
  };
}

/** The `spec` block of a result file (validateRunResult keeps it); undefined when it is not one. */
export function cleanEventSpec(v: unknown): EventSpecInfo | undefined {
  const s = objOf(v);
  if (s.kind !== "event_backtest") return undefined;
  const rules = rulesFromResult(s.rules);
  if (!rules) return undefined;
  const c = objOf(s.counts);
  const sk = objOf(c.skipped);
  const check = cleanCheck(s.check);
  return {
    kind: "event_backtest",
    helper_version: num(s.helper_version) ?? 0,
    hash: typeof s.hash === "string" ? s.hash.replace(/[^0-9a-f]/gi, "").slice(0, 32) : "",
    rules,
    counts: {
      events_in_file: num(c.events_in_file),
      qualifying: num(c.qualifying),
      entered: num(c.entered),
      closed: num(c.closed),
      open_at_end: num(c.open_at_end),
      skipped: Object.fromEntries(Object.entries(sk).flatMap(([k, n]) => (num(n) !== null ? [[k.slice(0, 30), num(n)!]] : [])).slice(0, 12)),
    },
    ...(check ? { check } : {}),
  };
}

const SKIP_WORDS: Record<string, string> = {
  duplicate: "a second filing for the same stock and day",
  timing: "filed after the close the filter needs",
  no_price_data: "no prices for the stock",
  after_end: "entry after the test's last day",
  no_entry_price: "no price on the entry day",
  already_held: "the stock was already held",
  max_positions: "all position slots were taken",
  no_cash: "no cash left",
};

/** "4,616 qualifying events, 4,402 entered; skipped: 150 slots taken, ..." */
export function eventCountsLine(s: EventSpecInfo): string {
  const c = s.counts;
  const n = (x: number | null) => (x === null ? "n/a" : x.toLocaleString("en-US"));
  const skipped = Object.entries(c.skipped)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v.toLocaleString("en-US")} ${SKIP_WORDS[k] ?? k}`);
  return `${n(c.qualifying)} qualifying events, ${n(c.entered)} entered, ${n(c.closed)} closed${c.open_at_end ? `, ${n(c.open_at_end)} still open at the end` : ""}${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}.`;
}

/* ------------------------------------------------------------------ the independent check */

/** An events-table row as the check reads it. */
export type CheckEvent = {
  ticker: string;
  event_date: string;
  filed_at: string | null;
  event_kind: string | null;
  sector_etf: string | null;
  flags: string[] | null;
  accession: string;
} & Partial<Record<EventMeasure, number | null>>;

/** One ticker's bars on the check's calendar: days ascending, open and close (NaN when missing). */
export type CheckBars = { days: string[]; open: number[]; close: number[] };

export type CheckInput = {
  rules: EventRules;
  trades: readonly RunTrade[];
  /** Falcon's events table rows for the rules (the server reads them; a superset is fine). */
  events: readonly CheckEvent[];
  /** The benchmark's trading days with a close (the helper's calendar), ascending. */
  calendar: readonly string[];
  bars: ReadonlyMap<string, CheckBars>;
  /** The result's last day. */
  periodEnd: string;
  helperQualifying?: number | null;
  /** The full trade list was there (a cut list cannot be checked for missing trades). */
  complete?: boolean;
};

/** Relative slack for prices rounded in the CSV. */
const PX_TOL = 0.002;
const dash = (t: string) => t.trim().toUpperCase().replace(/[./]/g, "-");

function lowerBound(xs: readonly string[], x: string): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}
const upperBound = (xs: readonly string[], x: string) => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]! <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
};

type Q = { e: CheckEvent; ticker: string; value: number; signalIdx: number; skip: "duplicate" | "timing" | null; order: number };

/** The qualifying events of the rules, in the helper's order, with duplicates and late filings marked. */
export function qualifyingEvents(rows: readonly CheckEvent[], r: EventRules, calendar: readonly string[]): Q[] {
  const out: Omit<Q, "signalIdx" | "skip" | "order">[] = [];
  for (const e of rows) {
    const ticker = dash(e.ticker);
    const day = e.event_date.slice(0, 10);
    if (!r.event_kinds.includes((e.event_kind ?? "earnings") as EventKind)) continue;
    if (day < r.since || (r.until && day > r.until)) continue;
    if (r.tickers && !r.tickers.includes(ticker)) continue;
    if (r.sector_etf && (e.sector_etf ?? "").toUpperCase() !== r.sector_etf) continue;
    const flags = e.flags ?? [];
    if (flags.some((f) => (CAVEAT_FLAGS as readonly string[]).includes(f) || r.exclude_flags.includes(f))) continue;
    const raw = e[r.measure];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    // As the events file writes it (6 decimals: lib/desk/tools/load-events.ts decimal), so a move of exactly the threshold reads the same.
    const v = Number(raw.toFixed(6));
    const pass = r.direction === "up" ? v > r.threshold : r.direction === "down" ? v < -r.threshold : Math.abs(v) > r.threshold;
    if (pass) out.push({ e: { ...e, event_date: day }, ticker, value: v });
  }
  const filed = (q: (typeof out)[number]) => (q.e.filed_at ? new Date(Date.parse(q.e.filed_at)).toISOString().replace(/\.\d{3}Z$/, "Z") : "");
  out.sort((a, b) => (a.e.event_date < b.e.event_date ? -1 : a.e.event_date > b.e.event_date ? 1 : 0) || cmp(filed(a), filed(b)) || cmp(a.ticker, b.ticker) || cmp(a.e.accession, b.e.accession));
  const d1 = D1_MEASURES.includes(r.measure);
  const seen = new Set<string>();
  return out.map((q, order) => {
    const key = `${q.ticker}|${q.e.event_date}`;
    let skip: Q["skip"] = seen.has(key) ? "duplicate" : null;
    seen.add(key);
    if (!skip && q.e.filed_at) {
      const ms = Date.parse(q.e.filed_at);
      if (Number.isFinite(ms)) {
        const p = nyParts(ms);
        const j = p.minutes < 16 * 60 ? lowerBound(calendar, p.date) : upperBound(calendar, p.date);
        if (j >= calendar.length || calendar[j]! > q.e.event_date) skip = "timing";
      }
    }
    return { ...q, signalIdx: lowerBound(calendar, q.e.event_date) + (d1 ? 1 : 0), skip, order };
  });
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Pos = { ticker: string; buy: RunTrade; sell: RunTrade | null; bIdx: number; sIdx: number | null };

/**
 * Checks a result's trades against its declared rules, independently of the helper: every buy comes from a
 * qualifying event (by ticker and signal day), enters on the rules' day at that day's open or close, sells on the
 * rules' day; never more than max_positions at once; and every qualifying event without a trade is explained
 * (no price, already held, slots full, after the end). Pure.
 */
export function checkEventTrades(input: CheckInput): EventCheck {
  const { rules: r, calendar } = input;
  const items: string[] = [];
  const wrong: Record<string, number> = { not_from_event: 0, entry_day: 0, entry_price: 0, exit_day: 0, exit_price: 0, concurrency: 0, priority: 0 };
  const note = (kind: string, text: string) => {
    wrong[kind] = (wrong[kind] ?? 0) + 1;
    if (items.length < 8) items.push(text);
  };
  const idx = new Map(calendar.map((d, i) => [d, i] as const));
  const endIdx = upperBound(calendar, input.periodEnd) - 1;
  const atOpen = r.entry === "next_open";
  const all = qualifyingEvents(input.events, r, calendar);
  const live = all.filter((q) => !q.skip);
  const byKey = new Map(live.map((q) => [`${q.ticker}|${calendar[q.signalIdx] ?? ""}`, q] as const));
  const bar = (t: string, day: string, f: "open" | "close"): number => {
    const b = input.bars.get(t);
    if (!b) return NaN;
    const k = lowerBound(b.days, day);
    return b.days[k] === day ? b[f][k]! : NaN;
  };
  const ok = (x: number) => Number.isFinite(x) && x > 0;
  const near = (a: number | null, b: number) => a !== null && ok(b) && Math.abs(a / b - 1) <= PX_TOL;

  // Pair buys and sells per ticker, in list order (the helper writes them as they happen).
  const positions: Pos[] = [];
  const openOf = new Map<string, Pos>();
  for (const t of input.trades) {
    const ticker = dash(t.ticker);
    if (t.side === "buy") {
      const p: Pos = { ticker, buy: t, sell: null, bIdx: idx.get(t.date) ?? -1, sIdx: null };
      positions.push(p);
      openOf.set(ticker, p);
    } else {
      const p = openOf.get(ticker);
      if (p) {
        p.sell = t;
        p.sIdx = idx.get(t.date) ?? -1;
        openOf.delete(ticker);
      }
    }
  }

  const matched = new Set<Q>();
  for (const p of positions) {
    const q = byKey.get(`${p.ticker}|${p.buy.signal_date ?? ""}`);
    if (!q || matched.has(q)) {
      note("not_from_event", `${p.buy.date} buy ${p.ticker}: no qualifying event with a signal on ${p.buy.signal_date ?? "(none)"}`);
      continue;
    }
    matched.add(q);
    const eIdx = q.signalIdx + 1;
    const entryDay = calendar[eIdx];
    if (p.buy.date !== entryDay) note("entry_day", `${p.ticker} (event ${q.e.event_date}) bought ${p.buy.date}; the rules enter ${entryDay ?? "after the data"}`);
    else if (!near(p.buy.price, bar(p.ticker, entryDay, atOpen ? "open" : "close"))) note("entry_price", `${p.ticker} bought ${p.buy.date} at ${p.buy.price ?? "n/a"}, not that day's ${atOpen ? "open" : "close"}`);
    // The exit the rules give.
    const planned = eIdx + r.hold_days - (atOpen ? 1 : 0);
    let want: { idx: number; px: number } | "open" = "open";
    if (planned <= endIdx) {
      const px = bar(p.ticker, calendar[planned]!, "close");
      if (ok(px)) want = { idx: planned, px };
      else {
        const b = input.bars.get(p.ticker);
        const later = b ? b.days.findIndex((d, k) => d > calendar[planned]! && ok(b.close[k]!) && idx.has(d)) : -1;
        if (b && later >= 0) {
          const li = idx.get(b.days[later]!)!;
          want = li <= endIdx ? { idx: li, px: b.close[later]! } : "open";
        } else {
          let last = NaN;
          if (b) for (let k = 0; k < b.days.length && b.days[k]! <= calendar[planned]!; k++) if (ok(b.close[k]!) && idx.has(b.days[k]!)) last = b.close[k]!;
          want = { idx: planned, px: ok(last) ? last : (p.buy.price ?? NaN) };
        }
      }
    }
    if (want === "open") {
      if (p.sell) note("exit_day", `${p.ticker} (bought ${p.buy.date}) sold ${p.sell.date}; the rules hold it past the test's end`);
    } else if (!p.sell) note("exit_day", `${p.ticker} (bought ${p.buy.date}) never sold; the rules sell it ${calendar[want.idx]}`);
    else if (p.sIdx !== want.idx) note("exit_day", `${p.ticker} (bought ${p.buy.date}) sold ${p.sell.date}; the rules sell it ${calendar[want.idx]}`);
    else if (!near(p.sell.price, want.px)) note("exit_price", `${p.ticker} sold ${p.sell.date} at ${p.sell.price ?? "n/a"}, not that day's close`);
  }

  // Positions held at an entry moment (open: bought by that open, sold at or after that close; close: sells come first).
  const heldAt = (e: number) => positions.filter((p) => p.bIdx >= 0 && (atOpen ? p.bIdx <= e && (p.sIdx === null || p.sIdx >= e) : p.bIdx <= e && (p.sIdx === null || p.sIdx > e)));
  const busiest = new Map<number, number>();
  for (const p of positions) if (p.bIdx >= 0 && !busiest.has(p.bIdx)) busiest.set(p.bIdx, heldAt(p.bIdx).length);
  for (const [e, n] of busiest) if (n > r.max_positions) note("concurrency", `${n} positions open on ${calendar[e]}, more than the ${r.max_positions} allowed`);

  // Qualifying events with no trade: each must have a reason the data shows.
  const explained: Record<string, number> = {};
  const add = (k: string) => (explained[k] = (explained[k] ?? 0) + 1);
  for (const q of all) if (q.skip) add(q.skip);
  let unexplained = 0;
  let inPeriod = 0;
  const complete = input.complete !== false;
  for (const q of live) {
    const eIdx = q.signalIdx + 1;
    if (eIdx > endIdx) {
      add("after_end");
      continue;
    }
    inPeriod++;
    if (matched.has(q)) continue;
    const day = calendar[eIdx]!;
    if (!input.bars.has(q.ticker)) add("no_price_data");
    else if (!ok(bar(q.ticker, day, atOpen ? "open" : "close"))) add("no_entry_price");
    else if (heldAt(eIdx).some((p) => p.ticker === q.ticker && p.bIdx < eIdx)) add("already_held");
    else if (heldAt(eIdx).length >= r.max_positions) {
      add("max_positions");
      // Busy day: nothing entered that day may have a smaller move than this skipped one.
      const moveOf = (p: Pos) => byKey.get(`${p.ticker}|${p.buy.signal_date ?? ""}`)?.value;
      const weaker = positions.find((p) => {
        const v = p.bIdx === eIdx ? moveOf(p) : undefined;
        return v !== undefined && Math.abs(v) < Math.abs(q.value);
      });
      if (weaker) note("priority", `${calendar[eIdx]}: ${weaker.ticker} entered ahead of ${q.ticker} with a smaller move`);
    } else if (complete) {
      unexplained++;
      if (items.length < 8) items.push(`${q.ticker} event ${q.e.event_date} (move ${pctText(q.value)}) qualifies but has no trade and no reason in the data`);
    }
  }
  const qualifying = all.length;
  const helperQualifying = input.helperQualifying ?? null;
  const fileGap = helperQualifying !== null && helperQualifying !== qualifying;
  if (fileGap && items.length < 8) items.unshift(`The events file the test read had ${helperQualifying.toLocaleString("en-US")} qualifying events; Falcon's events table has ${qualifying.toLocaleString("en-US")} for these rules.`);
  const entered = positions.length;
  const skippedHere = (explained.no_price_data ?? 0) + (explained.no_entry_price ?? 0) + (explained.already_held ?? 0) + (explained.max_positions ?? 0);
  const expected = inPeriod - skippedHere;
  const tolerance = Math.max(1, Math.ceil(qualifying * 0.005));
  const hard = Object.values(wrong).reduce((a, b) => a + b, 0);
  const status: EventCheckStatus = hard > 0 || unexplained > tolerance || fileGap || Math.abs(entered - expected) > tolerance ? "flag" : "pass";
  const n = (x: number) => x.toLocaleString("en-US");
  const skips = Object.entries(explained)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${n(v)} ${SKIP_WORDS[k] ?? k}`)
    .join("; ");
  const detail =
    status === "pass"
      ? `All ${n(entered)} trades come from qualifying events and enter and exit on the days the rules give. Falcon's events table has ${n(qualifying)} qualifying events for these rules; ${n(entered)} were traded${skips ? ` and the rest are explained (${skips})` : ""}.`
      : `The trades do not match the declared rules: ${[
          ...Object.entries(wrong)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${n(v)} ${k.replace(/_/g, " ")}`),
          ...(unexplained ? [`${n(unexplained)} qualifying events missing with no reason`] : []),
          ...(fileGap ? ["the events file differs from Falcon's table"] : []),
          ...(Math.abs(entered - expected) > tolerance ? [`${n(entered)} trades against ${n(expected)} the rules give`] : []),
        ].join(", ")}.`;
  return { status, detail, items, qualifying, helperQualifying, entered, expected, explained, unexplained, wrong };
}

/** A check that could not run (no events or prices on the server). */
export function skippedCheck(why: string): EventCheck {
  return { status: "skipped", detail: why, items: [], qualifying: null, helperQualifying: null, entered: 0, expected: null, explained: {}, unexplained: 0, wrong: {} };
}
