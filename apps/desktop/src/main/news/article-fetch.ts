import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { capParagraphs, extractArticle, cleanText } from "./article-extract";
import type { NewsArticleBody, NewsArticleRequest } from "../../shared/news-article";

/**
 * The article's text, read in the main process.
 *
 * The provider's own body is used when the feed already carries one (a
 * summary long enough to be the story); otherwise the publisher's page is
 * fetched once, with a timeout, a size cap and a browser's headers, and run
 * through the readability pass in article-extract.ts. A page that refuses,
 * walls itself off or holds no text falls back to the provider's summary
 * when there is one, and otherwise says plainly which of those it was.
 *
 * Copyright: the text is kept only to be shown in the panel, capped at
 * MAX_TEXT_CHARS, and a paid page's text is never kept at all.
 */

/** A provider summary this long is the article, not a teaser: no page fetch. */
export const PROVIDER_BODY_CHARS = 900;
/** Most text kept (and cached) for one article. About 2,000 words. */
export const MAX_TEXT_CHARS = 12_000;
export const MAX_PARAGRAPHS = 60;
/** Most bytes read from a page. News pages run 200 KB to 1.5 MB with inline scripts. */
export const MAX_PAGE_BYTES = 2_500_000;
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

/** A current desktop Chrome: what most publishers serve their article page to. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Response headers allowed per page. Some publishers (Yahoo) send more than Node fetch's 16 KB. */
const MAX_HEADER_BYTES = 128 * 1024;

/**
 * One request over node:http(s), shaped as a fetch Response. The global fetch
 * refuses a response whose headers pass 16 KB (UND_ERR_HEADERS_OVERFLOW), and
 * a large publisher's cookie banner alone can pass that; this takes up to
 * MAX_HEADER_BYTES. Never follows a redirect (fetchPage checks each hop) and
 * undoes gzip, deflate and brotli.
 */
export const httpFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.request(
      target,
      {
        method: "GET",
        headers: { ...(init.headers as Record<string, string>), "Accept-Encoding": "gzip, deflate, br" },
        maxHeaderSize: MAX_HEADER_BYTES,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else headers.set(k, String(v));
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const decoded =
          encoding === "gzip" || encoding === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(zlib.createInflate())
              : encoding === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        if (decoded !== res) {
          // The body is decoded here, so its length is no longer the header's.
          headers.delete("content-length");
          headers.delete("content-encoding");
          res.on("error", (err) => decoded.destroy(err));
        }
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 304 || (status >= 300 && status < 400);
        if (noBody) res.resume();
        resolve(
          new Response(noBody ? null : (Readable.toWeb(decoded as Readable) as ReadableStream<Uint8Array>), {
            status: status < 200 || status > 599 ? 502 : status,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

/**
 * Only public http(s) pages. The URL comes from a news feed, so it is checked
 * like any outside input: no file:, no loopback, no private ranges, on every
 * hop of a redirect.
 */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return false;
    }
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe80/.test(host) || host.startsWith("::ffff:")) return false;
  }
  return true;
}

/** Reads at most `limit` bytes; anything longer is refused rather than cut. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!res.body) {
    const text = await res.text();
    return text.length > limit ? null : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const charset = /charset=([^;]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.trim().toLowerCase();
  const decoder = (() => {
    try {
      return new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8");
    } catch {
      return new TextDecoder("utf-8");
    }
  })();
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return decoder.decode(all);
}

export type PageOutcome =
  | { kind: "html"; html: string; finalUrl: string }
  | { kind: "blocked"; finalUrl: string; status: number }
  | { kind: "error"; finalUrl: string; reason: string };

export async function fetchPage(
  url: string,
  options: { fetch?: FetchLike; timeoutMs?: number; maxBytes?: number } = {},
): Promise<PageOutcome> {
  const doFetch: FetchLike = options.fetch ?? httpFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isFetchableUrl(current)) return { kind: "error", finalUrl: current, reason: "not a public web address" };
      const res = await doFetch(current, { headers: BROWSER_HEADERS, redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return { kind: "error", finalUrl: current, reason: `redirect ${res.status} without a location` };
        current = new URL(next, current).toString();
        continue;
      }
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429 || res.status === 451) {
        return { kind: "blocked", finalUrl: current, status: res.status };
      }
      if (!res.ok) return { kind: "error", finalUrl: current, reason: `HTTP ${res.status}` };
      const type = res.headers.get("content-type") ?? "";
      if (type && !/html|xml/i.test(type)) return { kind: "error", finalUrl: current, reason: `not a web page (${type.split(";")[0]})` };
      const html = await readCapped(res, options.maxBytes ?? MAX_PAGE_BYTES);
      if (html === null) return { kind: "error", finalUrl: current, reason: "page too large" };
      return { kind: "html", html, finalUrl: current };
    }
    return { kind: "error", finalUrl: current, reason: "too many redirects" };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return { kind: "error", finalUrl: current, reason: aborted ? "timed out" : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** The provider's summary as paragraphs, capped like any other text. */
function summaryParagraphs(summary: string): string[] {
  return summary
    .split(/\n\s*\n|\n/)
    .map((p) => cleanText(p))
    .filter((p) => p.length > 0);
}

/**
 * What a page that gave no text falls back to: the provider's summary when
 * there is one, else the reason. `paywall` and `blocked` keep their own
 * status even with a summary, so the panel can say why the story is short.
 */
function fallback(
  status: "paywall" | "blocked" | "empty" | "error",
  request: NewsArticleRequest,
  finalUrl: string,
  now: number,
): NewsArticleBody {
  const summary = summaryParagraphs(request.summary ?? "");
  const capped = capParagraphs(summary, MAX_TEXT_CHARS, MAX_PARAGRAPHS);
  const usable = capped.paragraphs.length > 0;
  return {
    status: usable && (status === "empty" || status === "error") ? "summary" : status,
    paragraphs: capped.paragraphs,
    truncated: capped.truncated,
    origin: usable ? "provider" : "none",
    finalUrl,
    fetchedAt: now,
  };
}

export async function readArticleBody(
  request: NewsArticleRequest,
  options: { fetch?: FetchLike; now?: () => number; timeoutMs?: number } = {},
): Promise<NewsArticleBody> {
  const now = options.now?.() ?? Date.now();
  const summary = (request.summary ?? "").trim();
  if (summary.length >= PROVIDER_BODY_CHARS) {
    const capped = capParagraphs(summaryParagraphs(summary), MAX_TEXT_CHARS, MAX_PARAGRAPHS);
    return { status: "full", paragraphs: capped.paragraphs, truncated: capped.truncated, origin: "provider", finalUrl: request.url, fetchedAt: now };
  }
  if (!request.url || !isFetchableUrl(request.url)) return fallback("error", request, request.url ?? "", now);

  const page = await fetchPage(request.url, { fetch: options.fetch, timeoutMs: options.timeoutMs });
  if (page.kind === "blocked") return fallback("blocked", request, page.finalUrl, now);
  if (page.kind === "error") {
    console.warn(`[news-article] ${request.id}: ${page.reason}`);
    return fallback("error", request, page.finalUrl, now);
  }
  const extracted = extractArticle(page.html);
  if (extracted.kind === "paywall") return fallback("paywall", request, page.finalUrl, now);
  if (extracted.kind === "empty") return fallback("empty", request, page.finalUrl, now);
  const capped = capParagraphs(extracted.paragraphs, MAX_TEXT_CHARS, MAX_PARAGRAPHS);
  return {
    status: "full",
    paragraphs: capped.paragraphs,
    truncated: capped.truncated,
    origin: "publisher",
    finalUrl: page.finalUrl,
    fetchedAt: now,
  };
}
