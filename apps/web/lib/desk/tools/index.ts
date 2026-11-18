/**
 * The Desk AI's data tools: Anthropic tool definitions (DESK_TOOLS), one
 * executor (runDeskTool) that never throws and returns compact JSON for a
 * tool_result, and short labels for the UI (deskToolLabel). Server-only.
 * Wiring into /api/desk/chat: see README.md in this folder.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { DeadlineError } from "@falcon/backtest/data";
import { earningsTool } from "./earnings";
import { FORM_FILTERS, MAX_LIMIT, filingTextTool, filingsTool, type FormFilter } from "./filings";
import { fundamentalsTool } from "./fundamentals";
import { HISTORY_RANGES, historyTool, type HistoryRange } from "./history";
import { flowTool } from "./flow";
import { insidersTool } from "./insiders";
import { quoteTool } from "./quote";
import { SecError } from "./sec";
import { DEFAULT_TOOL_TIMEOUT_MS, ToolError, deadline, fitResult, normalizeTicker, type DeskToolContext } from "./util";

export type { DeskToolContext } from "./util";

const ticker = {
  type: "string",
  description: "US stock ticker, e.g. AAPL, NVDA, BRK.B. Symbols only, not company names.",
  minLength: 1,
  maxLength: 10,
} as const;

/** Tool definitions in the order the model sees them (keep it fixed: it is part of the cached prefix). */
export const DESK_TOOLS = [
  {
    name: "quote",
    description:
      "Last close of a US-listed stock: Databento end-of-day data (the last completed session, not a live price): close, change and % change on the day, previous close, open, day range, volume, 52-week range and its date. Falls back to Yahoo Finance (with market cap, market state and after-hours price) for a ticker Databento does not cover. Use for any question about where a stock closed or how it moved last session.",
    input_schema: { type: "object", properties: { ticker }, required: ["ticker"], additionalProperties: false },
  },
  {
    name: "history",
    description:
      "Price history summary for a US stock over a range (daily bars; weekly for 10y and max): start and end close, price return and total return with dividends, high and low with dates, maximum drawdown, annualized volatility, average volume, and up to 120 evenly spaced closes to describe the path. Use for performance over a period, drawdowns, ranges or trends. Ranges: 1m, 3m, 6m, ytd, 1y, 2y, 5y, 10y, max.",
    input_schema: {
      type: "object",
      properties: { ticker, range: { type: "string", enum: [...HISTORY_RANGES], description: "Period ending today. Default 1y." } },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "fundamentals",
    description:
      "Financials from the company's own SEC XBRL filings: revenue (TTM, last 4 quarters, last 4 fiscal years), gross / operating / net margins (TTM, last quarter, last fiscal year), diluted EPS (TTM and quarters), shares outstanding, cash and debt; plus market cap, P/E, price-to-sales and EV/EBITDA from Yahoo's last price. Each figure carries its period end; money is in the filing currency as reported (not millions). US filers have quarters; foreign filers (20-F) usually annual figures only.",
    input_schema: { type: "object", properties: { ticker }, required: ["ticker"], additionalProperties: false },
  },
  {
    name: "earnings",
    description:
      "Earnings record from Yahoo Finance: the last 8 reported quarters (release date, before/after the market, EPS estimate, actual and surprise %) and the next earnings date with the EPS and revenue consensus when known. EPS is Yahoo's figure (usually adjusted, non-GAAP).",
    input_schema: { type: "object", properties: { ticker }, required: ["ticker"], additionalProperties: false },
  },
  {
    name: "filings",
    description:
      "A company's SEC filings. Without query: its filings newest first, with date, form, 8-K item numbers and meanings, title and document URL (insider and routine paperwork left out unless you filter for form 4 or 144). With query: EDGAR full-text search of the company's filings (last 3 years unless days is set, up to 10 years; newest matches first; use double quotes for an exact phrase). Follow up with filing_text to read and quote a filing.",
    input_schema: {
      type: "object",
      properties: {
        ticker,
        form: { type: "string", enum: [...FORM_FILTERS], description: "Form type filter (amendments included). SC 13D / SC 13G include the newer SCHEDULE 13D/G names. Default: all material filings." },
        query: { type: "string", maxLength: 200, description: "Words or a quoted phrase to search the filings' full text for." },
        days: { type: "integer", minimum: 1, maximum: 3650, description: "Only filings from the last N days." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "How many filings to return (default 15)." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "filing_text",
    description:
      "Reads one SEC filing document (a URL from the filings tool, https://www.sec.gov/Archives/edgar/data/...) and returns a bounded excerpt: the passages that best match query, with a paragraph of context, or the start of the document and its section headings without one. Use it before quoting or describing what a filing says; quote only text in the excerpts.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 300, description: "SEC archive document or filing index URL from the filings tool." },
        query: { type: "string", maxLength: 200, description: "What to find, e.g. 'risk factors China', 'guidance', 'Item 2.02'." },
        maxChars: { type: "integer", minimum: 1000, maximum: 9000, description: "Excerpt length (default 6000)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "insiders",
    description:
      "Insider trading at a company from SEC Form 4 filings: open-market purchases and sales by officers, directors and 10% owners, with 10b5-1 plan trades and routine insiders (Cohen-Malloy-Pomorski: trades in the same month every year) set aside and counted separately, totals per insider, and cluster flags (3+ insiders buying or selling within 5 business days; officer or director purchases of $100k+). Reads up to the 40 newest Form 4s in the window.",
    input_schema: {
      type: "object",
      properties: { ticker, days: { type: "integer", minimum: 7, maximum: 365, description: "Look-back window in days (default 180)." } },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "flow",
    description:
      "Volume delta (aggressor buy volume minus aggressor sell volume) for a US stock over the last 1 to 5 completed regular sessions, from Nasdaq's own trade feed (Databento XNAS.ITCH): per session buy and sell volume, delta and delta % of volume, cumulative delta every 30 minutes with the price, VWAP, close-to-close change, Nasdaq's share of consolidated volume and the 5 largest prints with their side; plus the multi-day cumulative delta. Nasdaq prints only (about 10-15% of all volume; no NYSE, other venues or dark pools). Paid data: call only when the member asks about buying/selling pressure, order flow or volume delta, with the fewest days that answer it.",
    input_schema: {
      type: "object",
      properties: {
        ticker,
        days: { type: "integer", minimum: 1, maximum: 5, description: "Completed sessions to cover, newest last (default 1)." },
        session: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last session to include (YYYY-MM-DD, New York date). Default: the latest completed session." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
] satisfies Anthropic.Beta.BetaTool[];

export type DeskToolName = (typeof DESK_TOOLS)[number]["name"];
export const DESK_TOOL_NAMES = DESK_TOOLS.map((t) => t.name) as DeskToolName[];

export type DeskToolOutcome = {
  name: string;
  /** False when the result is `{ error }` (send it with is_error: true). */
  ok: boolean;
  /** JSON for the tool_result content (at most about 4k tokens). */
  content: string;
  /** For the UI, past tense: "Looked up AAPL quote". */
  label: string;
  ms: number;
};

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : undefined);

function docName(url: unknown): string {
  const m = typeof url === "string" ? /\/data\/(\d+)\/\d{18}\/([^/?#]+)$/.exec(url) : null;
  return m ? m[2]!.replace(/\.(htm|html|xml|txt)$/i, "") : "SEC filing";
}

function safeTicker(input: Input): string {
  try {
    return normalizeTicker(input.ticker).replace("-", ".");
  } catch {
    return typeof input.ticker === "string" ? input.ticker.slice(0, 10).toUpperCase() : "?";
  }
}

/**
 * A short line for the UI. `running`: "Looking up AAPL quote" (show with an
 * ellipsis while the tool runs); `done`: "Looked up AAPL quote".
 */
export function deskToolLabel(name: string, input: unknown, phase: "running" | "done" = "done"): string {
  const i = (input && typeof input === "object" ? input : {}) as Input;
  const t = safeTicker(i);
  const run = phase === "running";
  switch (name) {
    case "quote":
      return `${run ? "Looking up" : "Looked up"} ${t} quote`;
    case "history":
      return `${run ? "Loading" : "Loaded"} ${t} ${str(i.range) ?? "1y"} price history`;
    case "fundamentals":
      return `${run ? "Reading" : "Read"} ${t} fundamentals from SEC filings`;
    case "earnings":
      return `${run ? "Checking" : "Checked"} ${t} earnings record`;
    case "filings": {
      const q = str(i.query)?.trim();
      const form = str(i.form) && i.form !== "any" ? `${i.form} ` : "";
      if (q) return `${run ? "Searching" : "Searched"} ${t} ${form}filings for "${q.length > 40 ? `${q.slice(0, 40)}...` : q}"`;
      return `${run ? "Listing" : "Listed"} ${t} ${form}filings`;
    }
    case "filing_text":
      return `${run ? "Reading" : "Read"} ${docName(i.url)}`;
    case "insiders":
      return `${run ? "Checking" : "Checked"} ${t} insider trades`;
    case "flow": {
      const n = int(i.days) ?? 1;
      return `${run ? "Measuring" : "Measured"} ${t} volume delta${n > 1 ? ` over ${n} sessions` : ""}`;
    }
    default:
      return run ? `Running ${name}` : `Ran ${name}`;
  }
}

function errorMessage(err: unknown, signal: AbortSignal, parentAborted: boolean): string {
  if (err instanceof ToolError) return err.message;
  if (parentAborted) return "Cancelled.";
  if (err instanceof DeadlineError || signal.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) {
    return "The data source did not answer in time. Try again, or answer without this data and say so.";
  }
  if (err instanceof SecError) {
    if (err.status === 404) return "SEC has no such record for this company.";
    if (err.status === 429 || err.status === 403) return "SEC is rate-limiting requests right now. Try again shortly.";
    return `SEC EDGAR is unavailable right now (HTTP ${err.status}).`;
  }
  return "The data source is unavailable right now. Answer without it and say so.";
}

async function dispatch(name: string, input: Input, ctx: DeskToolContext, signal: AbortSignal, budgetMs: number): Promise<unknown> {
  switch (name) {
    case "quote":
      return quoteTool(normalizeTicker(input.ticker), ctx, signal);
    case "history": {
      const range = (str(input.range) ?? "1y").toLowerCase();
      if (!(HISTORY_RANGES as readonly string[]).includes(range)) throw new ToolError(`range must be one of ${HISTORY_RANGES.join(", ")}.`);
      return historyTool(normalizeTicker(input.ticker), range as HistoryRange, ctx, signal);
    }
    case "fundamentals":
      return fundamentalsTool(normalizeTicker(input.ticker), ctx, signal);
    case "earnings":
      return earningsTool(normalizeTicker(input.ticker), ctx, signal);
    case "filings": {
      const form = str(input.form);
      if (form !== undefined && !(FORM_FILTERS as readonly string[]).includes(form)) throw new ToolError(`form must be one of ${FORM_FILTERS.join(", ")}.`);
      return filingsTool(normalizeTicker(input.ticker), { form: form as FormFilter | undefined, query: str(input.query), days: int(input.days), limit: int(input.limit) }, ctx, signal);
    }
    case "filing_text":
      if (!str(input.url)) throw new ToolError("url is required (a document URL from the filings tool).");
      return filingTextTool({ url: str(input.url)!, query: str(input.query), maxChars: int(input.maxChars) }, ctx, signal);
    case "insiders":
      return insidersTool(normalizeTicker(input.ticker), { days: int(input.days) }, ctx, signal, budgetMs);
    case "flow":
      return flowTool(normalizeTicker(input.ticker), { days: int(input.days), session: str(input.session) }, ctx, signal);
    default:
      throw new ToolError(`Unknown tool "${name}". Available: ${DESK_TOOL_NAMES.join(", ")}.`);
  }
}

/**
 * Runs one tool call. Never throws: failures come back as `{ "error": "..." }`
 * with ok false. The result is compact JSON (about 4k tokens at most).
 */
export async function runDeskTool(name: string, input: unknown, ctx: DeskToolContext = {}): Promise<DeskToolOutcome> {
  const started = Date.now();
  const budgetMs = ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const signal = deadline(ctx, budgetMs);
  const args = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  const label = deskToolLabel(name, args, "done");
  try {
    const result = await dispatch(name, args, ctx, signal, budgetMs);
    return { name, ok: true, content: fitResult(result), label, ms: Date.now() - started };
  } catch (err) {
    const message = errorMessage(err, signal, ctx.signal?.aborted === true);
    if (!(err instanceof ToolError)) console.error("[desk/tools]", JSON.stringify({ tool: name, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: Date.now() - started }));
    return { name, ok: false, content: JSON.stringify({ error: message }), label, ms: Date.now() - started };
  }
}
