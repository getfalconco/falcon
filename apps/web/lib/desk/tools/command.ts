/**
 * The command form of a Desk tool call, for the chat's tool rows:
 * quote(AAPL) -> "/quote AAPL", filings(NVDA, 8-K) -> "/filings NVDA 8-K".
 * Pure (no server imports), so the client can use it too. The route sends it
 * with each tool's "running" event as `cmd`; `ref` carries a filing URL so the
 * client can name the filing's form and date from an earlier filings result.
 */

import { EVENTS_TOOL_NAME, eventsCommand } from "./events";
import { LOAD_EVENTS_TOOL_NAME, loadEventsCommand } from "./load-events";
import { LOAD_GRAPH_TOOL_NAME, loadGraphCommand } from "./load-graph";

type Input = Record<string, unknown>;

const MAX_ARG = 32;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const clip = (s: string, n = MAX_ARG) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quoted = (s: string) => `"${clip(s.replace(/"/g, "'"))}"`;

function ticker(i: Input): string {
  const t = str(i.ticker);
  return t ? clip(t.toUpperCase().replace(/^\$/, ""), 10) : "?";
}

/** "nvda-20240128.htm" -> { ticker: "NVDA", date: "2024-01-28" }; the document name otherwise. */
export function filingDoc(url: string): { ticker?: string; date?: string; name: string } {
  const file = (/\/([^/?#]+)$/.exec(url)?.[1] ?? url).replace(/\.(htm|html|xml|txt)$/i, "");
  const m = /^([a-z]{1,5})-(\d{4})(\d{2})(\d{2})/i.exec(file);
  return m ? { ticker: m[1]!.toUpperCase(), date: `${m[2]}-${m[3]}-${m[4]}`, name: file } : { name: file };
}

/** "2020-01-02" and "2025-06-30" -> "2020-2025"; one year -> "2024". */
function years(start: unknown, end: unknown): string | undefined {
  const a = str(start)?.slice(0, 4);
  const b = str(end)?.slice(0, 4);
  if (a && b) return a === b ? a : `${a}-${b}`;
  return a ? `${a}-now` : b;
}

/** Any other tool: "/name" and its short arguments (lists counted, dates folded into years). */
function generic(name: string, i: Input): string {
  if (/code_execution|python/i.test(name)) return /bash/i.test(name) ? "/run bash" : /editor/i.test(name) ? "/edit file" : "/run python";
  const args: string[] = [];
  const span = years(i.start, i.end);
  for (const [k, v] of Object.entries(i)) {
    if (k === "start" || k === "end" || v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (k === "fields") continue;
      args.push(v.length <= 3 && v.every((x) => typeof x === "string") ? v.map((x) => clip(String(x), 10)).join(" ") : `${v.length} ${k}`);
    } else if (typeof v === "string") args.push(/\s/.test(v) ? quoted(v) : clip(v));
    else if (typeof v === "number" && /^(ticker|universe|range|form|days)$/.test(k)) args.push(String(v));
    if (args.length >= 3) break;
  }
  if (span) args.push(span);
  return [`/${name}`, ...args].join(" ");
}

export function deskToolCommand(name: string, input: unknown): { cmd: string; ref?: string } {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  switch (name) {
    case "quote":
    case "fundamentals":
    case "earnings":
    case "insiders":
      return { cmd: `/${name} ${ticker(i)}` };
    case "history":
      return { cmd: `/history ${ticker(i)} ${str(i.range) ?? "1y"}` };
    case "filings": {
      const form = str(i.form) && i.form !== "any" ? ` ${str(i.form)}` : "";
      const q = str(i.query);
      return { cmd: `/filings ${ticker(i)}${form}${q ? ` ${quoted(q)}` : ""}` };
    }
    case "filing_text": {
      const url = str(i.url) ?? "";
      const doc = filingDoc(url);
      const head = doc.ticker ? `${doc.ticker}${doc.date ? ` ${doc.date}` : ""}` : clip(doc.name || "document");
      const q = str(i.query);
      return { cmd: `/filing ${head}${q ? ` ${quoted(q)}` : ""}`, ...(url ? { ref: url.slice(0, 300) } : {}) };
    }
    case "show_chart": {
      const title = str(i.title);
      return { cmd: `/chart ${clip(str(i.kind) ?? "line", 12)}${title ? ` ${quoted(title)}` : ""}` };
    }
    case "remember":
    case "forget": {
      // lib/desk/tools/memory.ts
      const what = str(i.text) ?? str(i.id);
      return { cmd: `/${name}${what ? ` ${quoted(what)}` : ""}` };
    }
    // Falcon's own data and the app actions (lib/desk/tools/falcon.ts).
    case "falcon_sightings": {
      const list = str(i.list) && i.list !== "all" ? ` ${str(i.list)}` : "";
      return { cmd: `/sightings${list}${str(i.ticker) ? ` ${ticker(i)}` : ""}${str(i.sector) ? ` ${quoted(str(i.sector)!)}` : ""}` };
    }
    case "falcon_graph":
      return { cmd: `/graph ${ticker(i)}${str(i.relation) ? ` ${str(i.relation)}` : ""}${str(i.as_of) ? ` --as-of ${clip(str(i.as_of)!, 10)}` : ""}` };
    case LOAD_GRAPH_TOOL_NAME:
      // lib/desk/tools/load-graph.ts: "/load_graph --as-of 2018-06-30 [--include-ended] [--tickers NVDA]"
      return { cmd: loadGraphCommand(i) };
    case "falcon_options": {
      // lib/desk/tools/iv.ts
      const detail = str(i.detail) && i.detail !== "summary" ? ` ${clip(str(i.detail)!, 8)}` : "";
      const exp = str(i.expiration) ? ` ${clip(str(i.expiration)!, 10)}` : "";
      const range = i.detail === "history" ? ` ${clip(str(i.range) ?? "1y", 3)}` : "";
      return { cmd: `/options ${ticker(i)}${detail}${range}${exp}${i.live === true ? " live" : ""}` };
    }
    case "falcon_company":
      return { cmd: `/company ${ticker(i)}` };
    case EVENTS_TOOL_NAME:
      // lib/desk/tools/events.ts: "/events NVDA", "/events --min-return 10% --since 2024-01-01"
      return { cmd: eventsCommand(i) };
    case LOAD_EVENTS_TOOL_NAME:
      // lib/desk/tools/load-events.ts: "/load_events --min-return 10% --since 2016-01-01 [--kinds all] [--sector XLK] [--tickers AAPL,MSFT]"
      return { cmd: loadEventsCommand(i) };
    case "falcon_scoreboard":
      // lib/desk/tools/scoreboard.ts: "/scoreboard", "/scoreboard NVDA", "/scoreboard documented", "/scoreboard earnings"
      return { cmd: ["/scoreboard", str(i.ticker) ? ticker(i) : "", clip(str(i.tier)?.toLowerCase() ?? "", 12), i.kind === "earnings" ? "earnings" : ""].filter(Boolean).join(" ") };
    // News (lib/desk/tools/news.ts): "/news", "/news AAPL"; an article's text: "/article 144023649".
    case "list_news":
      return { cmd: str(i.symbol) ? `/news ${clip(str(i.symbol)!.toUpperCase().replace(/^\$/, ""), 10)}` : "/news" };
    case "get_news_article":
      return { cmd: `/article ${typeof i.id === "number" || typeof i.id === "string" ? clip(String(i.id), 20) : "?"}` };
    case "open_ticker":
      return { cmd: `/open ${ticker(i)}` };
    case "show_in_graph":
      return { cmd: `/show-graph ${ticker(i)}` };
    case "set_graph_filters":
      return { cmd: i.clear === true && Object.keys(i).length === 1 ? "/filter graph clear" : "/filter graph" };
    case "open_sighting":
      return { cmd: "/open sighting" };
    case "open_dashboard":
      return { cmd: `/open ${i.view === "sightings" ? "sightings" : "dashboard"}` };
    default:
      return { cmd: generic(name, i) };
  }
}
