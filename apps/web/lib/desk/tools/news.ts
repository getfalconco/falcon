/**
 * News for Falcon AI, from Falcon's Finnhub company-news store
 * (public.news_items, lib/news/store.ts):
 *
 * - `list_news` (/news, /news AAPL): the latest articles, or one ticker's,
 *   newest first, with headline, publisher, time, tickers and Finnhub's summary.
 * - `get_news_article`: the readable text of one of those articles, by its id.
 *   The URL always comes from news_items, never from the model. The fetch is
 *   http/https only on ports 80/443, refuses hosts that resolve to private,
 *   loopback or link-local addresses (checked again on every redirect hop, at
 *   most MAX_REDIRECTS), sends no cookies, stops after ARTICLE_TIMEOUT_MS and
 *   reads at most MAX_HTML_BYTES. Paywalled or blocked pages come back as
 *   `content: "unavailable"` with the summary, not as an error.
 *
 * Server-only (pg, node:dns). The runners never throw. extractArticleText and
 * isBlockedAddress are pure.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type pg from "pg";
import type { DeskToolOutcome } from "./index";
import { DEFAULT_TOOL_TIMEOUT_MS, TtlCache, ToolError, deadline, fitResult, nyStamp, type DeskToolContext } from "./util";

export const NEWS_TOOL_NAME = "list_news";
export const NEWS_ARTICLE_TOOL_NAME = "get_news_article";

const LIST_DEFAULT = 15;
const LIST_MAX = 30;
const SUMMARY_CHARS = 300;
/** Article text handed to the model (the whole result stays under fitResult's cap). */
const ARTICLE_CHARS = 8_000;
/** Below this much readable text the page is treated as a paywall, a video or a consent wall. */
const MIN_ARTICLE_CHARS = 400;
/** Under this much text the result carries a note that it may be a teaser or a video page. */
const SHORT_ARTICLE_CHARS = 2_500;
const ARTICLE_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; FalconNewsReader/1.0; +https://getfalcon.co)";

const symbol = {
  type: "string",
  maxLength: 12,
  description: "A US ticker (e.g. AAPL, BRK.B) to list only that company's news. Leave out for the latest news across all companies.",
} as const;

export const NEWS_TOOL = {
  name: NEWS_TOOL_NAME,
  description:
    "Recent company news for US-listed stocks from Falcon's news store (Finnhub company news, about 5,500 companies, the last 14 days; Yahoo, Benzinga, Seeking Alpha, CNBC and other publishers). Newest first: each article's id, publication time (ET), publisher, headline, the tickers it is tagged with and a short summary. " +
    "Without symbol: the latest articles across all companies; with symbol: that company's articles. Use it for /news and /news TICKER, and whenever recent news would help an answer (why a stock moved, what is new at a company). The summaries are short: call get_news_article with an id to read the full article before describing what it says in detail.",
  input_schema: {
    type: "object",
    properties: {
      symbol,
      limit: { type: "integer", minimum: 1, maximum: LIST_MAX, description: `How many articles (default ${LIST_DEFAULT}).` },
      before: { type: "string", maxLength: 40, description: "Only articles published before this ISO time (to page back with the previous result's next_before)." },
    },
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

export const NEWS_ARTICLE_TOOL = {
  name: NEWS_ARTICLE_TOOL_NAME,
  description:
    "Reads the full text of one article from list_news, by its id (the publisher's page, fetched now; at most about 8,000 characters, `truncated` when cut). Some publishers are paywalled or block automated reads: then `content` is \"unavailable\" with the reason, and you answer from the summary and say the full text could not be read. Only ids from list_news work.",
  input_schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1, description: "The article id from list_news." } },
    required: ["id"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

export const NEWS_TOOLS = [NEWS_TOOL, NEWS_ARTICLE_TOOL];
export const isNewsTool = (name: string) => name === NEWS_TOOL_NAME || name === NEWS_ARTICLE_TOOL_NAME;

/* ------------------------------------------------------------------ input */

type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {});

/** "$brk.b" -> "BRK.B" (news_items keeps Finnhub's dotted class shares). Throws ToolError. */
export function newsSymbol(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolError("symbol must be a US ticker such as AAPL.");
  const s = v.trim().toUpperCase().replace(/^\$/, "").replace(/[-/]/g, ".");
  if (!s) return undefined;
  if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(s)) throw new ToolError(`"${v.slice(0, 20)}" is not a US stock ticker. Use the symbol, e.g. AAPL.`);
  return s;
}

function articleId(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new ToolError("id must be an article id from list_news.");
  return n;
}

export function newsLabel(name: string, input: unknown, phase: "running" | "done" = "done"): string {
  const run = phase === "running";
  if (name === NEWS_ARTICLE_TOOL_NAME) return `${run ? "Reading" : "Read"} news article`;
  let s: string | undefined;
  try {
    s = newsSymbol(asInput(input).symbol);
  } catch {
    s = undefined;
  }
  return `${run ? "Reading" : "Read"} ${s ? `${s} news` : "latest news"}`;
}

/* ------------------------------------------------------------------ store */

export type NewsArticleRow = {
  id: number;
  symbols: string[];
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
};

export type NewsStore = {
  list(opts: { symbol?: string; limit: number; before?: string }): Promise<NewsArticleRow[]>;
  get(id: number): Promise<NewsArticleRow | null>;
};

let pool: pg.Pool | null = null;

/** news_items through DATABASE_URL (one small pool per instance). */
export function pgNewsStore(): NewsStore {
  const get = async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new ToolError("Falcon's news store is not configured. Answer without news and say so.");
    const store = await import("../../news/store");
    pool ??= store.createNewsPool(url, 2);
    return { store, pool };
  };
  return {
    async list(opts) {
      const { store, pool } = await get();
      return store.readNews(pool, opts);
    },
    async get(id) {
      const { store, pool } = await get();
      return store.readNewsItem(pool, id);
    },
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}...` : s);

const listCache = new TtlCache<unknown>(60_000, 100);
const articleCache = new TtlCache<unknown>(30 * 60_000, 100);

/** list_news's result. Throws ToolError for bad input. */
export async function listNews(input: unknown, store: NewsStore, signal: AbortSignal): Promise<unknown> {
  const i = asInput(input);
  const sym = newsSymbol(i.symbol);
  const limit = Math.max(1, Math.min(LIST_MAX, Math.round(typeof i.limit === "number" && Number.isFinite(i.limit) ? i.limit : LIST_DEFAULT)));
  let before: string | undefined;
  if (typeof i.before === "string" && i.before.trim()) {
    const t = Date.parse(i.before);
    if (Number.isNaN(t)) throw new ToolError("before must be an ISO time, e.g. 2026-11-20T15:00:00Z.");
    before = new Date(t).toISOString();
  }
  const key = JSON.stringify([sym, limit, before]);
  const hit = listCache.get(key);
  if (hit) return hit;
  const rows = await abortable(store.list({ symbol: sym, limit, before }), signal);
  const out = {
    source: "Finnhub company news (Falcon news store)",
    ...(sym ? { symbol: sym } : {}),
    count: rows.length,
    ...(rows.length === 0 ? { note: sym ? `No articles tagged ${sym} in the last 14 days of Falcon's news store.` : "Falcon's news store has no articles yet." } : {}),
    articles: rows.map((r) => ({
      id: r.id,
      published: nyStamp(Date.parse(r.publishedAt)),
      publisher: r.source,
      headline: r.headline,
      tickers: r.symbols.slice(0, 8),
      summary: clip(r.summary.replace(/\s+/g, " ").trim(), SUMMARY_CHARS),
    })),
    next_before: rows.length === limit ? rows[rows.length - 1]!.publishedAt : null,
  };
  listCache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ safe fetch */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** IPv4 carried inside an IPv6 address (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16), else null. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  const m = hex ?? sixToFour;
  if (!m) return null;
  const a = parseInt(m[1]!, 16);
  const b = parseInt(m[2]!, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and documentation addresses. Pure. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    const inner = embeddedV4(ip);
    if (inner) return isBlockedAddress(inner);
    return blocked.check(ip, "ipv6");
  }
  return true;
}

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

class Unavailable extends Error {}

/** Throws Unavailable unless `url` is http(s) on a default port and every address its host resolves to is public. */
export async function checkPublicUrl(url: URL, lookup: Lookup = systemLookup): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Unavailable("not an http(s) link");
  if (url.username || url.password) throw new Unavailable("link carries credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Unavailable("non-standard port");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal|home|lan|intranet|corp)$/.test(host) || (!host.includes(".") && !isIP(host))) {
    throw new Unavailable("private host");
  }
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new Unavailable("the publisher's site could not be reached");
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) throw new Unavailable("private address");
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const take = p.subarray(0, out.length - at);
    out.set(take, at);
    at += take.byteLength;
  }
  return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export type FetchDeps = { fetch?: typeof fetch; lookup?: Lookup };

/** The page's HTML after following at most MAX_REDIRECTS redirects, each hop checked. Throws Unavailable. */
export async function fetchArticleHtml(start: string, signal: AbortSignal, deps: FetchDeps = {}): Promise<{ html: string; finalUrl: string }> {
  const doFetch = deps.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new Unavailable("the stored link is not a valid URL");
  }
  for (let hop = 0; ; hop++) {
    await checkPublicUrl(url, deps.lookup);
    const res = await doFetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" },
    });
    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get("location");
      if (!loc) throw new Unavailable(`redirect without a location (HTTP ${res.status})`);
      if (hop >= MAX_REDIRECTS) throw new Unavailable("too many redirects");
      try {
        url = new URL(loc, url);
      } catch {
        throw new Unavailable("bad redirect");
      }
      continue;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      const why = res.status === 401 || res.status === 402 || res.status === 403 ? "the publisher refused the request (paywall or blocked)" : res.status === 404 || res.status === 410 ? "the article is no longer online" : res.status === 429 ? "the publisher is rate-limiting requests" : "the publisher's site returned an error";
      throw new Unavailable(`${why} (HTTP ${res.status})`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      res.body?.cancel().catch(() => undefined);
      throw new Unavailable(`not a text page (${type.split(";")[0]})`);
    }
    const bytes = await readCapped(res, MAX_HTML_BYTES);
    return { html: decode(bytes, type), finalUrl: url.toString() };
  }
}

/* ------------------------------------------------------------------ text extraction */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", cent: "¢", deg: "°", middot: "·", bull: "•", times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const tidy = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/[ \t\r\f\v ]+/g, " ").trim();

/** articleBody from the page's JSON-LD (NewsArticle and friends), the cleanest source when present. */
function jsonLdBody(html: string): string | null {
  let best: string | null = null;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.articleBody === "string" && o.articleBody.length > (best?.length ?? 0)) best = o.articleBody;
    if (o["@graph"]) visit(o["@graph"]);
  };
  for (const m of html.matchAll(/<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]!.trim()));
    } catch {
      // A malformed block: skip it.
    }
  }
  if (!best) return null;
  const text = tidy(best as string).replace(/\s*\n\s*/g, "\n");
  return text.length >= MIN_ARTICLE_CHARS ? text : null;
}

/** The largest <article> (else <main>, else <body>), without page chrome. */
function mainRegion(html: string): string {
  const pick = (tag: string) => {
    let best = "";
    for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))) if (m[1]!.length > best.length) best = m[1]!;
    return best;
  };
  return pick("article") || pick("main") || /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] || html;
}

/**
 * Readable text of an article page: JSON-LD articleBody when the page has one,
 * else the paragraphs of its main region (scripts, styles, navigation, headers,
 * footers, forms and asides removed). Paragraphs are separated by blank lines. Pure.
 */
export function extractArticleText(html: string): { title: string | null; text: string } {
  const title = (() => {
    const og = /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1];
    const t = og ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    return t ? tidy(t) || null : null;
  })();
  const ld = jsonLdBody(html);
  if (ld) return { title, text: ld };

  let body = mainRegion(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select|nav|header|footer|aside|figure|figcaption)\b[\s\S]*?<\/\1>/gi, " ");
  const paragraphs: string[] = [];
  for (const m of body.matchAll(/<(p|h[1-4]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = tidy(m[2]!);
    if (t.length >= (m[1]!.toLowerCase() === "p" ? 25 : 40)) paragraphs.push(t);
  }
  let text = paragraphs.join("\n\n");
  if (text.length < MIN_ARTICLE_CHARS) {
    // No paragraph markup: the region's text with block tags as line breaks.
    body = body.replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section)\b[^>]*>/gi, "\n");
    text = tidy(body)
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 40)
      .join("\n\n");
  }
  return { title, text };
}

/** Cut at a sentence or word end near `max`. */
function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return { text: `${end > max * 0.8 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")} [cut]`, truncated: true };
}

/** get_news_article's result. Throws ToolError for a bad or unknown id. */
export async function getNewsArticle(input: unknown, store: NewsStore, signal: AbortSignal, deps: FetchDeps = {}): Promise<unknown> {
  const id = articleId(asInput(input).id);
  const hit = articleCache.get(String(id));
  if (hit) return hit;
  const row = await abortable(store.get(id), signal);
  if (!row) throw new ToolError(`No article with id ${id} in Falcon's news store. Use an id from list_news.`);
  const meta = {
    id: row.id,
    headline: row.headline,
    publisher: row.source,
    published: nyStamp(Date.parse(row.publishedAt)),
    tickers: row.symbols.slice(0, 8),
  };
  const unavailable = (reason: string) => ({
    ...meta,
    content: "unavailable",
    reason,
    summary: row.summary.replace(/\s+/g, " ").trim(),
    note: "The full text could not be read. Answer from the summary and say the full article could not be read.",
  });
  let out: unknown;
  let keep = true;
  try {
    const { html, finalUrl } = await fetchArticleHtml(row.url, signal, deps);
    const { text } = extractArticleText(html);
    if (text.length < MIN_ARTICLE_CHARS) out = unavailable("too little readable text on the page (likely a paywall, a sign-in or consent wall, or a video page)");
    else {
      const capped = capText(text, ARTICLE_CHARS);
      out = {
        ...meta,
        url: finalUrl.slice(0, 300),
        content: "full_text",
        chars: text.length,
        truncated: capped.truncated,
        ...(text.length < SHORT_ARTICLE_CHARS ? { note: "Short text: it may be only a teaser of a paywalled article or a video page, and can include unrelated page text. Say so if it looks incomplete." } : {}),
        text: capped.text,
      };
    }
  } catch (err) {
    // Timeouts and network errors are not cached: the next call tries again.
    keep = err instanceof Unavailable;
    out = unavailable(err instanceof Unavailable ? err.message : signal.aborted ? "the publisher's site did not answer in time" : "the publisher's site could not be reached");
  }
  if (keep) articleCache.set(String(id), out);
  return out;
}

/* ------------------------------------------------------------------ runners */

export type NewsToolContext = DeskToolContext & { store?: NewsStore; deps?: FetchDeps };

/** Runs list_news or get_news_article. Never throws. */
export async function runNewsTool(name: string, input: unknown, ctx: NewsToolContext = {}): Promise<DeskToolOutcome> {
  const started = Date.now();
  const label = newsLabel(name, input, "done");
  const budget = Math.min(ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, ARTICLE_TIMEOUT_MS);
  const signal = deadline(ctx, budget);
  const store = ctx.store ?? pgNewsStore();
  try {
    const result = name === NEWS_ARTICLE_TOOL_NAME ? await getNewsArticle(input, store, signal, ctx.deps) : name === NEWS_TOOL_NAME ? await listNews(input, store, signal) : null;
    if (result === null) throw new ToolError(`Unknown tool "${name}".`);
    return { name, ok: true, content: fitResult(result), label, ms: Date.now() - started };
  } catch (err) {
    const known = err instanceof ToolError;
    if (!known) console.error("[desk/news]", JSON.stringify({ tool: name, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: Date.now() - started }));
    const message = known
      ? (err as Error).message
      : ctx.signal?.aborted
        ? "Cancelled."
        : signal.aborted
          ? "Falcon's news did not answer in time. Try again, or answer without it and say so."
          : "Falcon's news is unavailable right now. Answer without it and say so.";
    return { name, ok: false, content: JSON.stringify({ error: message }), label, ms: Date.now() - started };
  }
}

/** For tests: forget cached lists and articles. */
export function resetNewsCache(): void {
  listCache.clear();
  articleCache.clear();
}
