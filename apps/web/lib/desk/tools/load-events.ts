/**
 * `load_events` (/load_events): Falcon's historical events table
 * (`historical_events`, one row per SEC 8-K Item 2.02 filing, 2016 on) loaded
 * in bulk into the code execution sandbox, like `load_prices` loads prices
 * (lib/desk/strategy-run.ts). `earnings_events` (/events) shows the model a
 * few dozen rows; this one hands Python every matching row (up to the whole
 * table, about 54,000 rows) for event-based backtests and statistics.
 *
 * The route (app/api/desk/chat/route.ts) runs it: every match is read through
 * the service client in 1,000-row pages (ordered by event_date, id; pages
 * after the first in parallel), written as one gzipped CSV (ISO dates,
 * decimal returns, flags joined by "|"), uploaded with the Files API and put
 * in the sandbox with a `container_upload` block. The model gets the file's
 * path, the row count, a column dictionary, the date range, counts and a
 * preview. The uploaded file is deleted with the price files when the reply
 * ends; a resumed reply keeps it (same container).
 *
 * Client-safe apart from runLoadEvents (command.ts imports the parsers and
 * the command form): no Node imports; gzip uses CompressionStream and the
 * Supabase client is imported lazily.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  CAVEAT_FLAGS,
  EVENT_KINDS,
  EVENTS_TABLE,
  isMissingTable,
  parseDateBound,
  parseEventsCommand,
  parseKinds,
  parseReturn,
  parseSector,
  pctText,
  tickerVariants,
  type Direction,
  type EventKind,
} from "./events";
import { ToolError, normalizeTicker, nyParts } from "./util";

export const LOAD_EVENTS_TOOL_NAME = "load_events";

export const LOAD_EVENTS_LIMITS = {
  /** Rows per Supabase page (PostgREST's default max-rows). */
  page: 1000,
  /** Pages read at once after the first. */
  concurrency: 6,
  /** More than the whole table (about 54,000 rows in Nov 2026). */
  maxRows: 150_000,
  /** Uncompressed CSV guard (the whole table with every column is about 22 MB). */
  maxCsvBytes: 80 * 1024 * 1024,
  tickers: 600,
} as const;

/** The return columns a threshold can apply to; short names for the slash form. */
export const MEASURES = {
  abnormal_return_d0_d1: ["abn", "abnormal", "d0_d1", "d0d1", "two_day"],
  abnormal_return_d0: ["abn_d0", "d0", "event_day"],
  abnormal_return_d1: ["abn_d1", "d1", "next_day"],
  stock_return_d0_d1: ["stock", "stock_d0_d1"],
  stock_return_d0: ["stock_d0"],
  stock_return_d1: ["stock_d1"],
} as const;
export type Measure = keyof typeof MEASURES;
const MEASURE_NAMES = Object.keys(MEASURES) as Measure[];
const DEFAULT_MEASURE: Measure = "abnormal_return_d0_d1";

const RETURN_COLUMNS = [
  "abnormal_return_d0",
  "stock_return_d0",
  "etf_return_d0",
  "abnormal_return_d1",
  "stock_return_d1",
  "etf_return_d1",
  "abnormal_return_d0_d1",
  "stock_return_d0_d1",
  "etf_return_d0_d1",
] as const;
type ReturnColumn = (typeof RETURN_COLUMNS)[number];

/** Every CSV column, in file order. filed_session and filed_et are derived from filed_at. */
export const CSV_COLUMNS = [
  "ticker",
  "event_date",
  "filed_at",
  "filed_session",
  "filed_et",
  "event_kind",
  "sector_etf",
  ...RETURN_COLUMNS,
  "flags",
  "accession",
  "form",
  "price_source",
  "filing_url",
  "kind_reason",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
/** Left out unless asked for (long text, or a second spelling of filed_at). */
const OPTIONAL_COLUMNS: CsvColumn[] = ["filed_et", "filing_url", "kind_reason"];
export const DEFAULT_COLUMNS: CsvColumn[] = CSV_COLUMNS.filter((c) => !OPTIONAL_COLUMNS.includes(c));
const ALWAYS: CsvColumn[] = ["ticker", "event_date"];

/** Units and definitions, as the model gets them with the file. */
export const COLUMN_DOCS: Record<CsvColumn, string> = {
  ticker: "US symbol, share classes with a dash (BRK-B), the same spelling load_prices uses.",
  event_date:
    "d0, YYYY-MM-DD: the first trading day the market could react. The filing day if the 8-K was accepted before 4:00 pm ET on a trading day, else the next trading day.",
  filed_at: "SEC acceptance time of the 8-K, ISO 8601 UTC (e.g. 2024-02-21T21:05:00Z). The event is public from this instant, not before.",
  filed_session:
    "When the news landed relative to event_date's session (New York time): pre_market (before 9:30 ET on event_date) or after_close (after 4 pm ET on an earlier day, or on a non-trading day): event_date's open is the first price after the news; intraday (9:30-16:00 ET on event_date): event_date's open is BEFORE the news, so the first tradable price after it is later that day (use the d0 close).",
  filed_et: "filed_at in New York time, YYYY-MM-DD HH:MM.",
  event_kind: "earnings (the quarterly results release), preliminary (preliminary results), operational_update (e.g. production and deliveries), other (other Item 2.02 filings).",
  sector_etf: "The SPDR sector ETF the abnormal returns are measured against (XLK, XLF, ...; SPY when the sector ETF had no price, flag etf_fallback_spy).",
  abnormal_return_d0: "Decimal (0.1 = +10%). stock_return_d0 - etf_return_d0: the event day alone.",
  stock_return_d0: "Decimal. The stock's event-day return, close(d0) / close(d-1) - 1 (close to close, split- and dividend-adjusted): known only at d0's close.",
  etf_return_d0: "Decimal. The sector ETF's event-day return, close(d0) / close(d-1) - 1.",
  abnormal_return_d1: "Decimal. stock_return_d1 - etf_return_d1: the next trading day alone.",
  stock_return_d1: "Decimal. The stock's next-day return, close(d1) / close(d0) - 1: known only at d1's close.",
  etf_return_d1: "Decimal. The sector ETF's next-day return, close(d1) / close(d0) - 1.",
  abnormal_return_d0_d1: "Decimal. Both days compounded: (1 + stock_d0)(1 + stock_d1) - (1 + etf_d0)(1 + etf_d1), so not exactly abnormal_d0 + abnormal_d1. Known only at d1's close.",
  stock_return_d0_d1: "Decimal. The stock over both days, close(d1) / close(d-1) - 1.",
  etf_return_d0_d1: "Decimal. The sector ETF over both days, close(d1) / close(d-1) - 1.",
  flags:
    "Quality flags joined by '|' (empty when none): suspicious_move (an extreme move to check: split, merger, data error or other news), missing_price, before_first_price, amended (8-K/A), multiple_same_day, etf_fallback_spy; cik_mismatch and price_source_disagree only when include_flagged was set (the filer or the price is in doubt).",
  accession: "SEC accession number of the 8-K (unique per filing; ticker + accession is unique).",
  form: "8-K or 8-K/A.",
  price_source: "Where the closes came from: yahoo (adjusted closes), or mixed (stock from Databento, ETF from Yahoo).",
  filing_url: "The filing's index page on sec.gov.",
  kind_reason: "Why the row got its event_kind (timing against the 10-Q / 10-K, or the Item 2.02 text).",
};

export const LOAD_EVENTS_TOOL = {
  name: LOAD_EVENTS_TOOL_NAME,
  description:
    "Loads Falcon's historical events table into the code execution sandbox as one gzipped CSV, every matching row (up to the whole table, about 54,000 SEC 8-K Item 2.02 filings since 2016 for about 1,400 US filers). Use it for any event-based backtest or statistic over many events; earnings_events (/events) only shows a sample. " +
    "Each row: ticker, event_date (d0: the filing day, or the next trading day if filed after 4 pm ET), filed_at (UTC; the event is public from then), filed_session, event_kind, sector_etf, the stock's, the sector ETF's and the abnormal (stock minus ETF) returns for d0, d1 and both compounded, as decimals, and quality flags. " +
    "Filters: tickers, sector, kinds (default earnings releases only; 'all' for every kind), a threshold min_abs_return on a measure (default the two-day abnormal return; abnormal_return_d0 for the event day alone), direction, since/until. Rows flagged cik_mismatch or price_source_disagree are left out unless include_flagged. " +
    "Returns the file's path in the sandbox, the row count, a column dictionary, date range, counts and a preview; the prices for the trades come from load_prices with tickers_from_events (the next step). An event-driven strategy test then runs with event_backtest (declared rules, Falcon's tested helper), never a script you write: filter here on the rule's own measure (e.g. measure stock_return_d0, min_abs_return 10%, direction up for 'rises more than 10% on earnings'). The member may type /load_events --min-return 10% --since 2016 [--until DATE] [--up|--down] [--measure d0] [--kinds all] [--sector XLK] [--tickers AAPL,MSFT] [--include-flagged]; map them to these fields.",
  input_schema: {
    type: "object",
    properties: {
      tickers: { type: "array", items: { type: "string", maxLength: 10 }, description: `Only these US tickers (at most ${LOAD_EVENTS_LIMITS.tickers}). Default: every company.` },
      sector: { type: "string", maxLength: 40, description: "A GICS sector name (e.g. Information Technology) or its SPDR ETF symbol (e.g. XLK)." },
      kinds: {
        type: ["array", "string"],
        items: { type: "string", enum: [...EVENT_KINDS, "all"] },
        description: "Which Item 2.02 filings: earnings (default), preliminary, operational_update, other, or all.",
      },
      min_abs_return: { type: ["number", "string"], description: "Smallest |measure|: 10, \"10%\" or 0.1 all mean 10%. A signed value (\"+10%\", \"-10%\") also sets the direction. Leave it out to load every event (then filter in Python)." },
      measure: { type: "string", enum: MEASURE_NAMES, description: `The return min_abs_return and direction apply to (default ${DEFAULT_MEASURE}).` },
      direction: { type: "string", enum: ["up", "down", "both"], description: "up: measure >= min (> 0 when no min); down: measure <= -min (< 0 when no min); both (default)." },
      since: { type: "string", maxLength: 10, description: "First event_date, YYYY-MM-DD (or YYYY, YYYY-MM)." },
      until: { type: "string", maxLength: 10, description: "Last event_date, YYYY-MM-DD (or YYYY, YYYY-MM)." },
      include_flagged: { type: "boolean", description: "Also load rows flagged cik_mismatch or price_source_disagree (default false). suspicious_move rows are always loaded and marked in flags." },
      columns: {
        type: "array",
        items: { type: "string", enum: [...CSV_COLUMNS, "all"] },
        description: `CSV columns (ticker and event_date are always there). Default: ${DEFAULT_COLUMNS.join(", ")}. Optional: ${OPTIONAL_COLUMNS.join(", ")}; or ["all"]. Leave it out unless you need an optional column.`,
      },
    },
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/* ------------------------------------------------------------------ input */

export type LoadEventsQuery = {
  tickers: string[] | null;
  etf: string | null;
  kinds: EventKind[];
  min: number;
  measure: Measure;
  direction: Direction;
  since: string | null;
  until: string | null;
  includeFlagged: boolean;
  columns: CsvColumn[];
};

type Input = Record<string, unknown>;
const blank = (v: unknown) => v === undefined || v === null || v === "";

/** A list sent as a JSON string ('["ticker","event_date"]') -> the list; anything else as is. */
function unjson(v: unknown): unknown {
  if (typeof v !== "string" || !/^\s*\[/.test(v)) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : v;
  } catch {
    return v.replace(/[[\]"']/g, " ");
  }
}

function parseTickerList(v: unknown): string[] | null {
  v = unjson(v);
  if (blank(v)) return null;
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/).filter(Boolean) : null;
  if (!parts) throw new ToolError("tickers must be a list of US symbols, e.g. [\"AAPL\", \"MSFT\"], or a comma-separated string.");
  const bad: string[] = [];
  const out = new Set<string>();
  for (const p of parts) {
    try {
      out.add(normalizeTicker(p));
    } catch {
      bad.push(String(p).slice(0, 12));
    }
  }
  if (bad.length) throw new ToolError(`Not US tickers: ${bad.slice(0, 10).join(", ")}. Use symbols such as AAPL or BRK.B.`);
  if (out.size > LOAD_EVENTS_LIMITS.tickers) throw new ToolError(`At most ${LOAD_EVENTS_LIMITS.tickers} tickers; leave tickers out to load every company.`);
  return out.size ? [...out] : null;
}

export function parseMeasure(v: unknown): Measure {
  if (blank(v)) return DEFAULT_MEASURE;
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((MEASURE_NAMES as string[]).includes(s)) return s as Measure;
  const hit = MEASURE_NAMES.find((m) => (MEASURES[m] as readonly string[]).includes(s));
  if (!hit) throw new ToolError(`measure "${String(v).slice(0, 30)}" is unknown. Use ${MEASURE_NAMES.join(", ")}.`);
  return hit;
}

export function parseColumns(v: unknown): CsvColumn[] {
  v = unjson(v);
  if (blank(v)) return [...DEFAULT_COLUMNS];
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;|]+/).filter(Boolean) : null;
  if (!parts) throw new ToolError(`columns must be a list from ${CSV_COLUMNS.join(", ")}, or all.`);
  const want = new Set<CsvColumn>(ALWAYS);
  for (const p of parts) {
    const c = String(p).trim().toLowerCase();
    if (c === "all") return [...CSV_COLUMNS];
    if (c === "default") {
      DEFAULT_COLUMNS.forEach((d) => want.add(d));
      continue;
    }
    if (!(CSV_COLUMNS as readonly string[]).includes(c)) throw new ToolError(`column "${c.slice(0, 30)}" is unknown. Use ${CSV_COLUMNS.join(", ")}, or all.`);
    want.add(c as CsvColumn);
  }
  return CSV_COLUMNS.filter((c) => want.has(c));
}

/** The tool's input, checked (the events.ts parsers for returns, dates, sectors and kinds). Throws ToolError. */
export function parseLoadEvents(input: unknown): LoadEventsQuery {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  const tickers = parseTickerList(i.tickers ?? i.ticker);
  const since = parseDateBound(i.since, "since");
  const until = parseDateBound(i.until, "until");
  if (since && until && since > until) throw new ToolError("since must be on or before until.");
  const dirRaw = blank(i.direction) ? null : String(i.direction).toLowerCase();
  if (dirRaw !== null && !["up", "down", "both"].includes(dirRaw)) throw new ToolError("direction must be up, down or both.");
  const min = blank(i.min_abs_return) ? null : parseReturn(i.min_abs_return);
  if (min?.sign && dirRaw && dirRaw !== "both" && dirRaw !== min.sign) throw new ToolError(`min_abs_return says ${min.sign} but direction says ${dirRaw}.`);
  const direction = (min?.sign ?? dirRaw ?? "both") as Direction;
  if (i.include_flagged !== undefined && typeof i.include_flagged !== "boolean") throw new ToolError("include_flagged must be true or false.");
  return {
    tickers,
    etf: parseSector(i.sector),
    kinds: parseKinds(unjson(i.kinds)),
    min: min?.value ?? 0,
    measure: parseMeasure(i.measure),
    direction,
    since,
    until,
    includeFlagged: i.include_flagged === true,
    columns: parseColumns(i.columns),
  };
}

const MEASURE_SHORT: Record<Measure, string> = {
  abnormal_return_d0_d1: "abn",
  abnormal_return_d0: "d0",
  abnormal_return_d1: "d1",
  stock_return_d0_d1: "stock",
  stock_return_d0: "stock_d0",
  stock_return_d1: "stock_d1",
};

/** The tool row's command: "/load_events --min-return 10% --since 2016-01-01". Pure. */
export function loadEventsCommand(input: unknown): string {
  let q: LoadEventsQuery;
  try {
    q = parseLoadEvents(input);
  } catch {
    return "/load_events";
  }
  const sign = q.direction === "up" ? "+" : q.direction === "down" ? "-" : "";
  const parts = ["/load_events"];
  if (q.tickers) parts.push(`--tickers ${q.tickers.length <= 4 ? q.tickers.join(",") : `${q.tickers.length}-tickers`}`);
  if (q.min > 0) parts.push(`--min-return ${sign}${pctText(q.min)}`);
  else if (sign) parts.push(`--${q.direction}`);
  if ((q.min > 0 || sign) && q.measure !== DEFAULT_MEASURE) parts.push(`--measure ${MEASURE_SHORT[q.measure]}`);
  if (q.since) parts.push(`--since ${q.since}`);
  if (q.until) parts.push(`--until ${q.until}`);
  if (!(q.kinds.length === 1 && q.kinds[0] === "earnings")) parts.push(`--kinds ${q.kinds.length === EVENT_KINDS.length ? "all" : q.kinds.join(",")}`);
  if (q.etf) parts.push(`--sector ${q.etf}`);
  if (q.includeFlagged) parts.push("--include-flagged");
  return parts.join(" ");
}

/**
 * The slash form a member types, as tool input (checked later by parseLoadEvents):
 * "/load_events --min-return 10% --since 2016 --kinds all --sector XLK --tickers AAPL,MSFT".
 * The events.ts parser reads the shared flags; --measure, --columns and --include-flagged are read here.
 * Returns null when the text is not a /load_events command.
 */
export function parseLoadEventsCommand(text: string): Input | null {
  const m = /^\s*\/load[_-]events\b(.*)$/is.exec(text);
  if (!m) return null;
  const words = m[1]!.trim().split(/\s+/).filter(Boolean);
  const own: Input = {};
  const rest: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const flag = /^--?([a-z-]+)(?:=(.*))?$/i.exec(words[k]!);
    const name = flag?.[1]?.toLowerCase();
    if (name === "include-flagged" || name === "flagged") own.include_flagged = true;
    else if (name === "measure" || name === "columns") {
      const value = flag![2] ?? words[++k];
      if (value !== undefined) own[name] = value;
    } else rest.push(words[k]!);
  }
  const shared = parseEventsCommand(`/events ${rest.join(" ")}`) ?? {};
  const { ticker, limit: _limit, ...others } = shared;
  return { ...others, ...(ticker ? { tickers: ticker } : {}), ...own };
}

/** "Loading earnings events (+10% or more, 2016-01-01 on)" / "Loaded 4,478 earnings events (...)". */
export function loadEventsLabel(input: unknown, phase: "running" | "done", rows?: number): string {
  const verb = phase === "running" ? "Loading" : "Loaded";
  try {
    const q = parseLoadEvents(input);
    const what = q.kinds.length === 1 ? `${q.kinds[0] === "operational_update" ? "operational update" : q.kinds[0]} events` : "events";
    const sign = q.direction === "up" ? "+" : q.direction === "down" ? "-" : "±";
    const bits = [
      ...(q.min > 0 ? [`${sign}${pctText(q.min)} or more${q.measure !== DEFAULT_MEASURE ? ` on ${MEASURE_SHORT[q.measure]}` : ""}`] : []),
      ...(q.tickers ? [q.tickers.length <= 3 ? q.tickers.join(", ") : `${q.tickers.length} tickers`] : []),
      ...(q.etf ? [q.etf] : []),
      ...(q.since || q.until ? [`${q.since ?? "2016"} to ${q.until ?? "today"}`] : []),
    ];
    return `${verb} ${rows !== undefined ? `${rows.toLocaleString("en-US")} ` : ""}${what}${bits.length ? ` (${bits.join(", ")})` : ""}`;
  } catch {
    return `${verb} events`;
  }
}

/* ------------------------------------------------------------------ rows and CSV */

/** One table row as read (id for paging and de-duplication). */
export type EventTableRow = {
  id: number;
  ticker: string;
  event_date: string;
  filed_at: string | null;
  accession: string;
  filing_url: string | null;
  form: string | null;
  sector_etf: string | null;
  price_source: string | null;
  flags: string[] | null;
  event_kind: string | null;
  kind_reason: string | null;
} & Partial<Record<ReturnColumn, number | null>>;

export const SELECT_COLUMNS =
  "id, ticker, event_date, filed_at, accession, filing_url, form, sector_etf, abnormal_return_d0_d1, stock_return_d0_d1, etf_return_d0_d1, abnormal_return_d0, stock_return_d0, etf_return_d0, abnormal_return_d1, stock_return_d1, etf_return_d1, price_source, flags, event_kind, kind_reason";

/** A CSV field: quoted when it holds a comma, quote, line break or edge spaces (quotes doubled). */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A decimal return, 6 decimals at most (0.0339063901768323 -> 0.033906); "" when missing. */
export function decimal(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const n = Number(v.toFixed(6));
  return String(n === 0 ? 0 : n);
}

const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export type Session = "pre_market" | "intraday" | "after_close";

/** When the filing landed relative to event_date's session (New York time). */
export function filedSession(filedAt: string | null, eventDate: string): { session: Session | null; et: string | null; utc: string | null } {
  const ms = filedAt ? Date.parse(filedAt) : NaN;
  if (!Number.isFinite(ms)) return { session: null, et: null, utc: null };
  const p = nyParts(ms);
  const session: Session = p.date < eventDate || p.minutes >= 16 * 60 ? "after_close" : p.minutes < 9 * 60 + 30 ? "pre_market" : "intraday";
  return { session, et: `${p.date} ${p.time}`, utc: isoUtc(ms) };
}

const csvTicker = (t: string) => t.trim().toUpperCase().replace(/[./]/g, "-");

/** The CSV text (header + one line per row, "\n" line ends). */
export function eventsCsv(rows: readonly EventTableRow[], columns: readonly CsvColumn[]): string {
  const lines: string[] = [columns.join(",")];
  for (const r of rows) {
    const f = columns.includes("filed_at") || columns.includes("filed_session") || columns.includes("filed_et") ? filedSession(r.filed_at, r.event_date) : null;
    const cells = columns.map((c): string => {
      switch (c) {
        case "ticker":
          return csvField(csvTicker(r.ticker));
        case "event_date":
          return r.event_date.slice(0, 10);
        case "filed_at":
          return f?.utc ?? "";
        case "filed_session":
          return f?.session ?? "";
        case "filed_et":
          return f?.et ?? "";
        case "flags":
          return csvField((r.flags ?? []).join("|"));
        case "event_kind":
          return csvField(r.event_kind ?? "earnings");
        default:
          return (RETURN_COLUMNS as readonly string[]).includes(c) ? decimal(r[c as ReturnColumn]) : csvField(r[c as keyof EventTableRow]);
      }
    });
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

/** Typical bytes per column (value + its comma), measured on the table in Nov 2026. */
const COLUMN_BYTES: Record<CsvColumn, number> = {
  ticker: 5,
  event_date: 11,
  filed_at: 21,
  filed_session: 11,
  filed_et: 17,
  event_kind: 9,
  sector_etf: 4,
  abnormal_return_d0: 10,
  stock_return_d0: 10,
  etf_return_d0: 10,
  abnormal_return_d1: 10,
  stock_return_d1: 10,
  etf_return_d1: 10,
  abnormal_return_d0_d1: 10,
  stock_return_d0_d1: 10,
  etf_return_d0_d1: 10,
  flags: 2,
  accession: 21,
  form: 4,
  price_source: 6,
  filing_url: 96,
  kind_reason: 125,
};

/** Estimated CSV size before any row is read (the guard against a file too large to build or upload). */
export function estimateCsvBytes(rows: number, columns: readonly CsvColumn[]): number {
  return Math.round((rows + 1) * columns.reduce((a, c) => a + COLUMN_BYTES[c], 0));
}

/** gzip with the web CompressionStream (Node 18+ and browsers), so this module needs no Node import. */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ paging */

/** One side of the threshold (both directions with a threshold are two reads: >= min and <= -min). */
export type Side = "up" | "down" | "any";

/** One page of matches, rows [from, to] in (event_date, id) order; `count` (the total) when asked for. */
export type PageFetcher = (side: Side, from: number, to: number, withCount: boolean, signal: AbortSignal) => Promise<{ rows: EventTableRow[]; count: number | null }>;

export const sidesOf = (q: Pick<LoadEventsQuery, "min" | "direction">): Side[] => (q.direction === "up" ? ["up"] : q.direction === "down" ? ["down"] : q.min > 0 ? ["up", "down"] : ["any"]);

/**
 * Every match of one side: the first page with the total, then the remaining
 * pages `concurrency` at a time, then on until a short page (rows added while
 * reading). A server that caps pages below `page` rows sets the step.
 */
export async function fetchSide(fetch: PageFetcher, side: Side, signal: AbortSignal, opts: { page?: number; concurrency?: number; maxRows?: number } = {}): Promise<{ rows: EventTableRow[]; total: number | null; pages: number }> {
  const size = opts.page ?? LOAD_EVENTS_LIMITS.page;
  const max = opts.maxRows ?? LOAD_EVENTS_LIMITS.maxRows;
  const first = await fetch(side, 0, size - 1, true, signal);
  const total = first.count;
  if (total !== null && total > max) throw new ToolError(`${total.toLocaleString("en-US")} events match; at most ${max.toLocaleString("en-US")} load at once. Narrow it with since/until, sector or kinds.`);
  const step = first.rows.length > 0 && first.rows.length < size && (total ?? 0) > first.rows.length ? first.rows.length : size;
  const pages: EventTableRow[][] = [first.rows];
  let fetched = 1;
  if (first.rows.length >= step && total !== null && total > step) {
    const offsets: number[] = [];
    for (let at = step; at < total; at += step) offsets.push(at);
    const out: EventTableRow[][] = new Array(offsets.length);
    let next = 0;
    const worker = async () => {
      while (next < offsets.length) {
        const k = next++;
        if (signal.aborted) throw new Error("aborted");
        out[k] = (await fetch(side, offsets[k]!, offsets[k]! + step - 1, false, signal)).rows;
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? LOAD_EVENTS_LIMITS.concurrency, offsets.length) }, worker));
    pages.push(...out);
    fetched += offsets.length;
  }
  // No total, or the last page came back full (rows were added while reading): read on until a short page.
  let at = pages.reduce((a, p) => a + p.length, 0);
  let last = pages[pages.length - 1]!;
  while (last.length >= step && at < max) {
    if (signal.aborted) throw new Error("aborted");
    last = (await fetch(side, at, at + step - 1, false, signal)).rows;
    fetched++;
    if (!last.length) break;
    pages.push(last);
    at += last.length;
  }
  return { rows: pages.flat(), total, pages: fetched };
}

/** Every match of the query (all its sides), de-duplicated by id, ordered by event_date, filed_at, ticker. */
export async function fetchAllEvents(fetch: PageFetcher, q: Pick<LoadEventsQuery, "min" | "direction">, signal: AbortSignal, opts?: { page?: number; concurrency?: number; maxRows?: number }): Promise<{ rows: EventTableRow[]; pages: number }> {
  const parts = await Promise.all(sidesOf(q).map((s) => fetchSide(fetch, s, signal, opts)));
  const seen = new Set<number>();
  const rows: EventTableRow[] = [];
  for (const p of parts)
    for (const r of p.rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
  rows.sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : (a.filed_at ?? "").localeCompare(b.filed_at ?? "") || a.ticker.localeCompare(b.ticker) || a.id - b.id));
  return { rows, pages: parts.reduce((a, p) => a + p.pages, 0) };
}

const admin = async () => (await import("../../supabase-admin")).getSupabaseAdmin();

/** The Supabase reads (service client, read-only): pages of matches, and the count of rows left out as flagged. */
export function supabaseEventPages(q: LoadEventsQuery): { fetch: PageFetcher; countFlagged: (signal: AbortSignal) => Promise<number> } {
  const caveats = `{${CAVEAT_FLAGS.join(",")}}`;
  // Typed loosely: the builder's generic types differ between select() with and without head.
  const filtered = (b: any, side: Side, caveat: "exclude" | "only" | "any") => {
    if (q.tickers) b = b.in("ticker", tickerVariants(q.tickers));
    if (q.since) b = b.gte("event_date", q.since);
    if (q.until) b = b.lte("event_date", q.until);
    if (q.etf) b = b.eq("sector_etf", q.etf);
    if (q.kinds.length < EVENT_KINDS.length) b = b.in("event_kind", q.kinds);
    if (caveat === "exclude") b = b.or(`flags.is.null,flags.not.ov.${caveats}`);
    else if (caveat === "only") b = b.overlaps("flags", [...CAVEAT_FLAGS]);
    if (side === "up") b = q.min > 0 ? b.gte(q.measure, q.min) : b.gt(q.measure, 0);
    else if (side === "down") b = q.min > 0 ? b.lte(q.measure, -q.min) : b.lt(q.measure, 0);
    return b;
  };
  const fail = (error: { code?: string; message?: string }) => {
    if (isMissingTable(error)) throw new ToolError("Falcon's historical events are still loading. Say so; they will be available soon.");
    throw new Error(error.message ?? "query failed");
  };
  return {
    async fetch(side, from, to, withCount, signal) {
      const sb = await admin();
      const b = filtered(sb.from(EVENTS_TABLE).select(SELECT_COLUMNS, withCount ? { count: "exact" } : undefined), side, q.includeFlagged ? "any" : "exclude");
      const res = await b.order("event_date", { ascending: true }).order("id", { ascending: true }).range(from, to).abortSignal(signal);
      if (res.error) fail(res.error);
      return { rows: (res.data ?? []) as EventTableRow[], count: res.count ?? null };
    },
    async countFlagged(signal) {
      if (q.includeFlagged) return 0;
      const sb = await admin();
      const counts = await Promise.all(
        sidesOf(q).map(async (side) => {
          const res = await filtered(sb.from(EVENTS_TABLE).select("id", { count: "exact", head: true }), side, "only").abortSignal(signal);
          if (res.error) fail(res.error);
          return (res.count as number | null) ?? 0;
        }),
      );
      return counts.reduce((a, b) => a + b, 0);
    },
  };
}

/* ------------------------------------------------------------------ summary */

const tally = (xs: Iterable<string>) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};

/** Counts the model gets with the file (tickers, kinds, years, sessions, flags, price sources). */
export function summarizeRows(rows: readonly EventTableRow[]) {
  const tickers = tally(rows.map((r) => csvTicker(r.ticker)));
  return {
    first: rows[0]?.event_date ?? null,
    last: rows[rows.length - 1]?.event_date ?? null,
    tickers: Object.keys(tickers).length,
    ticker_list: Object.keys(tickers).sort(),
    most_events: Object.entries(tickers)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([ticker, n]) => ({ ticker, n })),
    by_kind: tally(rows.map((r) => r.event_kind ?? "earnings")),
    by_year: tally(rows.map((r) => r.event_date.slice(0, 4))),
    by_session: tally(rows.map((r) => filedSession(r.filed_at, r.event_date).session ?? "unknown")),
    flags: tally(rows.flatMap((r) => r.flags ?? [])),
    price_source: tally(rows.map((r) => r.price_source ?? "unknown")),
  };
}

/* ------------------------------------------------------------------ load_prices from an events file */

type TurnLike = { role: string; content: unknown };

/** The ticker list of a load_events result in these turns: the one whose file is `name`, else the latest. */
export function eventTickersInTurns(turns: readonly object[], name: string): { file: string; tickers: string[] } | null {
  const calls = new Set<string>();
  let named: { file: string; tickers: string[] } | null = null;
  let latest: { file: string; tickers: string[] } | null = null;
  for (const t of turns as readonly TurnLike[]) {
    if (!Array.isArray(t.content)) continue;
    for (const b of t.content as Record<string, unknown>[]) {
      if (t.role === "assistant" && b.type === "tool_use" && b.name === LOAD_EVENTS_TOOL_NAME && typeof b.id === "string") calls.add(b.id);
      if (t.role !== "user" || b.type !== "tool_result" || !calls.has(String(b.tool_use_id)) || b.is_error) continue;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map((x) => x.text ?? "").join("") : "";
      // Results carry a source-id line first (lib/desk/citations.ts withSourceId).
      const json = text.slice(text.indexOf("{"));
      try {
        const d = JSON.parse(json) as { file?: unknown; ticker_list?: unknown };
        if (typeof d.file !== "string" || typeof d.ticker_list !== "string" || !d.ticker_list) continue;
        const hit = { file: d.file, tickers: d.ticker_list.split(",").filter(Boolean) };
        latest = hit;
        if (d.file === name.trim()) named = hit;
      } catch {
        // not a load_events result with a file
      }
    }
  }
  return named ?? latest;
}

/**
 * A load_prices input with tickers_from_events, its tickers filled in from that load_events result (the route
 * runs this before runLoadPrices, so the model never has to type a thousand symbols). Other inputs pass unchanged.
 */
export function withEventTickers(input: unknown, turns: readonly object[]): { input: unknown; error?: string } {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  if (typeof i.tickers_from_events !== "string" || !i.tickers_from_events.trim()) return { input };
  const hit = eventTickersInTurns(turns, i.tickers_from_events);
  if (!hit) return { input, error: `No load_events file ${i.tickers_from_events.slice(0, 40)} in this reply yet. Call load_events first (in an earlier step), then pass the file name it returns.` };
  const own = Array.isArray(i.tickers) ? i.tickers : [];
  return { input: { ...i, tickers: [...own, ...hit.tickers] } };
}

/* ------------------------------------------------------------------ run */

export type LoadEventsOutcome = {
  ok: boolean;
  /** tool_result text for the model. */
  content: string;
  label: string;
  /** The uploaded file, for the container_upload block. */
  fileId?: string;
  /** One line for the results panel's log. */
  log?: string;
  ms: number;
};

type Built = { csvBytes: number; gz: Uint8Array; rows: EventTableRow[]; flaggedOut: number; pages: number; preview: string };

/** Built files by query, so a call made again (a resumed reply, a second test) skips the reads. */
const built = new Map<string, { at: number; value: Built }>();
const BUILT_TTL_MS = 15 * 60_000;
const BUILT_MAX = 3;

export function resetLoadEvents(): void {
  built.clear();
}

const mb = (n: number) => `${(n / 1_048_576).toFixed(n < 1_048_576 ? 2 : 1)} MB`;

const POINT_IN_TIME =
  "Point in time: an event is public from filed_at, never before. event_date (d0) is its first trading day; a filter on a d0 return is known only at d0's close and one on d1 or d0_d1 only at d1's close, so trade after that close (e.g. the next day's open), never at a price before it. For filed_session intraday, d0's open is before the news.";

/**
 * Reads every match, writes and uploads the CSV. Never throws. `deps` replaces
 * the Supabase reads in tests.
 */
export async function runLoadEvents(
  client: Pick<Anthropic, "files">,
  input: unknown,
  signal: AbortSignal,
  deps: { pages?: ReturnType<typeof supabaseEventPages>; now?: () => number } = {},
): Promise<LoadEventsOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const runningLabel = loadEventsLabel(input, "done");
  const fail = (error: string): LoadEventsOutcome => ({ ok: false, content: JSON.stringify({ error }), label: runningLabel, log: `load_events failed: ${error}`, ms: now() - started });
  let q: LoadEventsQuery;
  try {
    q = parseLoadEvents(input);
  } catch (error) {
    return fail(error instanceof ToolError ? error.message : "Bad input.");
  }
  try {
    const key = JSON.stringify(q);
    let b = built.get(key);
    if (b && now() - b.at > BUILT_TTL_MS) {
      built.delete(key);
      b = undefined;
    }
    let data: Built;
    if (b) data = b.value;
    else {
      const pages = deps.pages ?? supabaseEventPages(q);
      const [all, flaggedOut] = await Promise.all([fetchAllEvents(pages.fetch, q, signal), pages.countFlagged(signal).catch(() => -1)]);
      if (!all.rows.length) {
        return { ok: true, content: JSON.stringify({ rows: 0, filters: filtersOf(q), note: "No events match these filters; nothing was uploaded. Widen them (since, kinds, min_abs_return) or say so." }), label: loadEventsLabel(input, "done", 0), ms: now() - started };
      }
      const estimate = estimateCsvBytes(all.rows.length, q.columns);
      if (estimate > LOAD_EVENTS_LIMITS.maxCsvBytes) return fail(`The file would be about ${mb(estimate)}; narrow the filters or ask for fewer columns.`);
      const csv = eventsCsv(all.rows, q.columns);
      const gz = await gzip(csv);
      const lines = csv.split("\n", 6);
      data = { csvBytes: new TextEncoder().encode(csv).length, gz, rows: all.rows, flaggedOut, pages: all.pages, preview: lines.join("\n") };
      built.set(key, { at: now(), value: data });
      while (built.size > BUILT_MAX) built.delete(built.keys().next().value!);
    }
    if (signal.aborted) return fail("Time ran out before the file was uploaded. Call load_events again with the same input (the rows are cached now).");
    const name = `events_${Math.random().toString(16).slice(2, 8)}.csv.gz`;
    const file = await client.files.upload({ file: new File([data.gz as BlobPart], name, { type: "application/gzip" }) }, { signal });
    const s = summarizeRows(data.rows);
    const label = loadEventsLabel(input, "done", data.rows.length);
    const notes = [
      POINT_IN_TIME,
      "Returns are decimals (0.1 = +10%), close to close on adjusted closes; an empty cell is a missing return (no price that day). Abnormal = stock minus its sector ETF.",
      `Prices for entries and exits come from load_prices: pass tickers_from_events: "${name}" instead of listing the ${s.tickers.toLocaleString("en-US")} tickers (ticker_list). One call loads any span from 2015-01-01 to today (e.g. start 2016-01-01 for events since 2016): never split it into periods.`,
      "Tickers are the filers' current symbols in Falcon's graph (about 1,400 US companies, foreign 20-F filers excluded): a test over past years carries survivorship bias. Say so in warnings.",
      ...(q.kinds.length === 1 && q.kinds[0] === "earnings" ? ["Only quarterly earnings releases are loaded (kinds: earnings); preliminary results, operational updates and other Item 2.02 filings are left out."] : []),
      ...(data.flaggedOut > 0 ? [`${data.flaggedOut.toLocaleString("en-US")} rows flagged cik_mismatch or price_source_disagree are left out (include_flagged loads them).`] : []),
      "suspicious_move in flags marks an extreme move to check (split, merger, data error); consider excluding or reporting them apart. No EPS surprise is available yet.",
    ];
    const content = JSON.stringify({
      file: name,
      path: `/files/input/*/${name} (glob it: glob.glob("/files/input/*/${name}")[0]; also in $INPUT_DIR when set)`,
      read_with: `pd.read_csv(path, parse_dates=["event_date"], keep_default_na=False, na_values=[""]); filed_at: pd.to_datetime(df["filed_at"], utc=True); flags: df["flags"].str.split("|")`,
      rows: data.rows.length,
      size: { csv_bytes: data.csvBytes, gzip_bytes: data.gz.length },
      filters: filtersOf(q),
      date_range: { first: s.first, last: s.last },
      columns: Object.fromEntries(q.columns.map((c) => [c, COLUMN_DOCS[c]])),
      counts: { tickers: s.tickers, by_kind: s.by_kind, by_year: s.by_year, filed_session: s.by_session, flags: s.flags, price_source: s.price_source, most_events: s.most_events },
      ...(data.flaggedOut > 0 ? { left_out_flagged: data.flaggedOut } : {}),
      preview: data.preview,
      ticker_list: s.ticker_list.join(","),
      source: `Falcon historical events (SEC 8-K Item 2.02 filings, ${s.first} to ${s.last}); prices: ${Object.keys(s.price_source).join(", ")}`,
      notes,
    });
    return {
      ok: true,
      content,
      label,
      fileId: file.id,
      log: `Loaded ${data.rows.length.toLocaleString("en-US")} events (${s.tickers.toLocaleString("en-US")} tickers, ${s.first} to ${s.last}), ${mb(data.csvBytes)} CSV, ${mb(data.gz.length)} gzipped.`,
      ms: now() - started,
    };
  } catch (error) {
    if (error instanceof ToolError) return fail(error.message);
    if (signal.aborted) return fail("Time ran out while loading the events. Call load_events again with the same input.");
    console.error("[desk/load_events]", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return fail("The events file could not be prepared. Try again in a minute.");
  }
}

function filtersOf(q: LoadEventsQuery) {
  return {
    kinds: q.kinds,
    ...(q.min > 0 || q.direction !== "both" ? { min_abs_return: q.min > 0 ? pctText(q.min) : null, measure: q.measure, direction: q.direction } : {}),
    since: q.since,
    until: q.until,
    sector_etf: q.etf,
    tickers: q.tickers ? (q.tickers.length <= 20 ? q.tickers : `${q.tickers.length} tickers`) : null,
    include_flagged: q.includeFlagged,
  };
}
