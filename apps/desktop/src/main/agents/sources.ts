/**
 * What the agent engine reads from the world, as one interface.
 *
 * The trigger rules and the write-ups only ever see `AgentDataSources`, so a
 * test hands in a fake and the engine never touches a provider. The live
 * implementation (`sources-live.ts`) maps each method onto services the app
 * already has: Yahoo through `main/stock/market-data-service.ts` (quotes,
 * charts, news, the earnings calendar, consensus), SEC EDGAR through
 * `edgar.ts`, the curated macro calendar shipped in @meridian/research, and
 * the US stock catalog. None of them spends the shared Finnhub quota.
 *
 * The parsers at the bottom are pure and tested.
 */

export type FilingRef = {
  cik: string;
  form: string;
  accession: string;
  /** "YYYY-MM-DD" */
  filedAt: string;
  /** ISO instant EDGAR accepted it, when the index carries one. */
  acceptedAt: string | null;
  /** 8-K item codes ("2.02", "7.01"). */
  items: string[];
  primaryDocument: string | null;
  /** Human-readable document on sec.gov. */
  url: string;
};

export type FilingText = { title: string; url: string; text: string };

export type InsiderTxn = {
  insiderName: string;
  role: string;
  /** P purchase, S sale, A award, M exercise, F tax, G gift. */
  code: string;
  shares: number | null;
  price: number | null;
  value: number | null;
  direction: "acquired" | "disposed" | null;
  date: string | null;
  plan10b51: boolean;
};

export type NewsItem = { id: string; title: string; url: string; source?: string; publishedAt?: string };

export type QuoteRead = {
  symbol: string;
  price: number;
  /** Move against the previous close including extended hours, in percent. */
  changePct: number;
  /** Regular-session move against the previous close, in percent, when known. */
  regularChangePct: number | null;
  previousClose: number | null;
  session: "pre" | "regular" | "post" | "closed";
  asOf: string;
};

export type DailyClose = { date: string; close: number };

export type ConsensusRead = {
  /** Plain lines with the figures, quoted to the model and checked against. */
  lines: string[];
  readAt: string;
};

export type MacroEventRead = {
  date: string;
  timeEt: string | null;
  code: string;
  title: string;
  period?: string;
  importance: 1 | 2 | 3;
};

export type CatalogLookup = { symbol: string; companyName: string } | null;

export interface AgentDataSources {
  /** Upcoming and recent earnings dates (YYYY-MM-DD), soonest first. */
  earningsDates(ticker: string): Promise<{ dates: string[]; estimated: boolean | null }>;
  /** Recent filings, newest first. */
  filings(ticker: string): Promise<FilingRef[]>;
  /** A filing's text: the press release exhibit for an 8-K when there is one. */
  filingText(filing: FilingRef): Promise<FilingText>;
  /** The first transaction of a Form 4. */
  insiderTxn(filing: FilingRef): Promise<InsiderTxn | null>;
  quote(ticker: string): Promise<QuoteRead>;
  /** One close per session, oldest first, roughly the last month. */
  dailyCloses(ticker: string): Promise<DailyClose[]>;
  news(ticker: string): Promise<NewsItem[]>;
  marketNews(sinceIso: string): Promise<NewsItem[]>;
  consensus(ticker: string): Promise<ConsensusRead | null>;
  macroEvents(fromYmd: string, toYmd: string): MacroEventRead[];
  /** Last date the shipped macro calendar is complete for. */
  macroCoverageUntil(): string;
  /** The catalog entry for a ticker; null when it is not listed; throws when the catalog cannot be read. */
  lookupTicker(ticker: string): Promise<CatalogLookup>;
  /** Best catalog matches for a company name. */
  searchCompany(query: string): Promise<CatalogLookup[]>;
}

/* ------------------------------------------------------------------ */
/* Pure parsers                                                         */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  mdash: ", ",
  ndash: "-",
  hellip: "...",
  bull: "*",
};

/** Filing HTML to plain text: tags out, entities decoded, tables kept one row per line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return code === 8212 ? ", " : code === 8211 ? "-" : code === 160 ? " " : String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/( \| ){2,}/g, " | ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The parts of a long document worth a model's attention: the opening (where
 * a press release puts its headline numbers) plus every paragraph that names
 * one of `terms`, up to `max` characters. Kept in document order.
 */
export function focusText(text: string, terms: readonly string[], max = 24_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.45));
  const rest = text.slice(head.length);
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  const blocks = rest.split(/\n+/);
  const picked: string[] = [];
  let used = head.length;
  for (const block of blocks) {
    const lower = block.toLowerCase();
    if (!needles.some((n) => lower.includes(n))) continue;
    const piece = block.slice(0, 1200);
    if (used + piece.length + 1 > max) break;
    picked.push(piece);
    used += piece.length + 1;
  }
  return [head, ...picked].join("\n");
}

type Raw = { raw?: unknown; fmt?: unknown } | number | undefined | null;

function rawNum(v: Raw): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && typeof v.raw === "number" && Number.isFinite(v.raw)) return v.raw;
  return null;
}

function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString("en-US");
  return String(Math.round(n * 100) / 100);
}

/**
 * Consensus lines from Yahoo's `earningsTrend` + `earningsHistory` modules.
 * Every figure is the provider's own, printed as it came, so the grounding
 * check can find it again in the write-up.
 */
export function parseConsensus(modules: Record<string, unknown> | null, readAt: string): ConsensusRead | null {
  if (!modules) return null;
  const lines: string[] = [];
  const trend = (modules.earningsTrend as { trend?: Array<Record<string, unknown>> } | undefined)?.trend ?? [];
  for (const t of trend) {
    const period = t.period;
    if (period !== "0q" && period !== "+1q") continue;
    const end = typeof t.endDate === "string" ? t.endDate : "unknown";
    const eps = t.earningsEstimate as Record<string, Raw> | undefined;
    const rev = t.revenueEstimate as Record<string, Raw> | undefined;
    const parts: string[] = [];
    const epsAvg = rawNum(eps?.avg);
    const epsN = rawNum(eps?.numberOfAnalysts);
    const revAvg = rawNum(rev?.avg);
    const revN = rawNum(rev?.numberOfAnalysts);
    const revAgo = rawNum(rev?.yearAgoRevenue);
    const epsAgo = rawNum(eps?.yearAgoEps);
    if (epsAvg !== null) parts.push(`EPS estimate ${fmtNum(epsAvg)}${epsN !== null ? ` (${fmtNum(epsN)} analysts)` : ""}`);
    if (epsAgo !== null) parts.push(`EPS a year earlier ${fmtNum(epsAgo)}`);
    if (revAvg !== null) parts.push(`revenue estimate ${fmtNum(revAvg)}${revN !== null ? ` (${fmtNum(revN)} analysts)` : ""}`);
    if (revAgo !== null) parts.push(`revenue a year earlier ${fmtNum(revAgo)}`);
    if (parts.length === 0) continue;
    const label = period === "0q" ? "Current quarter" : "Next quarter";
    lines.push(`${label} ending ${end}: ${parts.join("; ")}.`);
  }
  const history = (modules.earningsHistory as { history?: Array<Record<string, unknown>> } | undefined)?.history ?? [];
  for (const h of history.slice(-2)) {
    const actual = rawNum(h.epsActual as Raw);
    const estimate = rawNum(h.epsEstimate as Raw);
    const quarter = (h.quarter as { fmt?: unknown } | undefined)?.fmt;
    if (actual === null && estimate === null) continue;
    lines.push(
      `Reported quarter ${typeof quarter === "string" ? quarter : "unknown"}: EPS actual ${actual !== null ? fmtNum(actual) : "n/a"}, estimate ${estimate !== null ? fmtNum(estimate) : "n/a"}.`,
    );
  }
  return lines.length > 0 ? { lines, readAt } : null;
}

/** The first non-derivative transaction of a Form 4 ownership document. */
export function parseForm4(xml: string): InsiderTxn | null {
  if (!/<ownershipDocument/i.test(xml)) return null;
  const tag = (name: string, scope = xml): string | null => {
    const m = scope.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"));
    return m ? m[1]!.trim() : null;
  };
  const valueOf = (name: string, scope: string): string | null => {
    const m = scope.match(new RegExp(`<${name}>[\\s\\S]*?<value>\\s*([^<]*?)\\s*</value>[\\s\\S]*?</${name}>`, "i"));
    return m ? m[1]!.trim() : null;
  };
  const yes = (v: string | null) => v === "1" || v?.toLowerCase() === "true";
  const role =
    tag("officerTitle") ||
    (yes(tag("isOfficer")) ? "officer" : yes(tag("isDirector")) ? "director" : yes(tag("isTenPercentOwner")) ? "10% owner" : "insider");
  const txn = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/i)?.[0];
  if (!txn) return null;
  const num = (v: string | null) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const shares = num(valueOf("transactionShares", txn));
  const price = num(valueOf("transactionPricePerShare", txn));
  const ad = valueOf("transactionAcquiredDisposedCode", txn);
  const date = valueOf("transactionDate", txn);
  return {
    insiderName: tag("rptOwnerName") ?? "unknown",
    role,
    code: (tag("transactionCode", txn) ?? "").toUpperCase(),
    shares,
    price,
    value: shares !== null && price !== null ? Math.round(shares * price) : null,
    direction: ad === "A" ? "acquired" : ad === "D" ? "disposed" : null,
    date: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
    plan10b51: yes(tag("aff10b5One")),
  };
}
