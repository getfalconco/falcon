import type { GlossModelCaller } from "@meridian/research/gloss";
import { repairMojibake } from "@meridian/research/news";
import { readArticleBody } from "./article-fetch";
import { InFlight, TtlCache } from "./ttl-cache";
import { NewsAnalysisError, NEWS_ANALYSIS_VERSION, analysisSource, analyzeNewsArticle, newsModel } from "./news-analysis";
import type { ClassifierVerdict } from "../../shared/classifier-types";
import type {
  NewsAnalysis,
  NewsAnalysisRequest,
  NewsAnalysisResult,
  NewsArticleBody,
  NewsArticleBodyResult,
  NewsArticleReadingResult,
  NewsArticleRequest,
} from "../../shared/news-article";

/**
 * The news panel's three answers, with their caches, in one place that does
 * not touch Electron, so the whole flow runs under `node --test`:
 *
 *   body      the article's text: memory + disk cache, 24 h for text and a
 *             few hours for a refusal, one fetch per article at a time
 *   reading   the server classifier's verdict for `id:<article id>`, looked up
 *             in its recent verdicts (held for a minute, one request at a time).
 *             "No verdict" (the lookup answered, the server has none) and "lookup
 *             failed" (engine out of reach, timeout, an error reply) are kept
 *             apart: only the first may lead to a paid read on its own.
 *   analysis  Falcon's read, cached per article, language and prompt version,
 *             one model call per key at a time, and a per-minute ceiling. An
 *             automatic request checks the verdict lookup first and makes no
 *             model call when it failed; a manual one (the reader pressed "Get
 *             Falcon's read") goes ahead.
 */

const DAY_MS = 24 * 60 * 60_000;
export const BODY_TTL_MS = DAY_MS;
/** A refusal, a wall or an empty page is retried after a few hours: it is often a passing state. */
export const BODY_FAILURE_TTL_MS = 3 * 60 * 60_000;
/** A page that could not be reached at all (timeout, network) is retried soon. */
export const BODY_ERROR_TTL_MS = 10 * 60_000;
export const ANALYSIS_TTL_MS = 7 * DAY_MS;
export const VERDICTS_FRESH_MS = 60_000;
/** Verdicts read per lookup: the classifier's recent output covers the feed's three days. */
export const VERDICTS_LIMIT = 1000;
const ANALYSIS_RATE_WINDOW_MS = 60_000;
const ANALYSIS_RATE_MAX = 12;

export type NewsArticleServiceDeps = {
  /** `<data root>/news`, resolved lazily. */
  dataDir: () => string;
  readBody?: (request: NewsArticleRequest) => Promise<NewsArticleBody>;
  listVerdicts: () => Promise<ClassifierVerdict[]>;
  relationships: (tickers: readonly string[]) => Promise<string[]>;
  caller: GlossModelCaller;
  configured: () => boolean;
  /** The main process's UI language, for a request that does not name one. */
  language: () => string;
  isLanguage: (value: unknown) => boolean;
  model?: () => string;
  now?: () => number;
};

/** The renderer's request, checked: it crosses a process boundary. */
export function sanitizeRequest(raw: unknown): NewsArticleRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" && Number.isFinite(r.id) ? Math.trunc(r.id) : 0;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const url = str(r.url, 2048).trim();
  // Provider mojibake ("weekÃ¢â‚¬â„¢s") is repaired here too, so neither the
  // model nor the panel reads it, whatever fed the request.
  const headline = repairMojibake(str(r.headline, 600)).trim();
  if (!headline && !url) return null;
  const tickers = Array.isArray(r.tickers)
    ? [...new Set(r.tickers.filter((t): t is string => typeof t === "string").map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z0-9.\-]{1,12}$/.test(t)))].slice(0, 12)
    : [];
  return {
    id,
    headline,
    summary: repairMojibake(str(r.summary, 20_000)),
    url,
    source: repairMojibake(str(r.source, 120)).trim(),
    datetime: typeof r.datetime === "number" && Number.isFinite(r.datetime) ? r.datetime : 0,
    tickers,
  };
}

/** FNV-1a, short and stable: a key for an article with no provider id. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function articleKey(request: NewsArticleRequest): string {
  return request.id > 0 ? `id:${request.id}` : `url:${hash(request.url || request.headline)}`;
}

function bodyTtl(body: NewsArticleBody): number {
  if (body.status === "full") return BODY_TTL_MS;
  // "summary" is what an unreachable or empty page falls back to; an
  // unreachable one is worth another try sooner than a refusal.
  if (body.status === "error" || (body.status === "summary" && body.origin === "provider")) return BODY_ERROR_TTL_MS;
  return BODY_FAILURE_TTL_MS;
}

export function createNewsArticleService(deps: NewsArticleServiceDeps) {
  const now = deps.now ?? Date.now;
  const bodies = new TtlCache<NewsArticleBody>({
    dir: deps.dataDir,
    file: "article-text.json",
    ttlMs: BODY_TTL_MS,
    maxEntries: 150,
    now,
  });
  const reads = new TtlCache<NewsAnalysis>({
    dir: deps.dataDir,
    file: "article-reads.json",
    ttlMs: ANALYSIS_TTL_MS,
    maxEntries: 300,
    now,
  });
  const bodyFlight = new InFlight<NewsArticleBody>();
  const readFlight = new InFlight<NewsAnalysisResult>();
  const verdictFlight = new InFlight<ClassifierVerdict[]>();
  let verdicts: { at: number; byKey: Map<string, ClassifierVerdict> } | null = null;
  let recent: number[] = [];

  async function body(request: NewsArticleRequest): Promise<NewsArticleBody> {
    const key = articleKey(request);
    const hit = bodies.get(key);
    if (hit) return hit;
    return bodyFlight.run(key, async () => {
      const read = deps.readBody ?? ((r: NewsArticleRequest) => readArticleBody(r, { now }));
      const result = await read(request);
      bodies.set(key, result, bodyTtl(result));
      return result;
    });
  }

  async function verdictIndex(): Promise<Map<string, ClassifierVerdict>> {
    if (verdicts && now() - verdicts.at < VERDICTS_FRESH_MS) return verdicts.byKey;
    const list = await verdictFlight.run("all", deps.listVerdicts);
    const byKey = new Map<string, ClassifierVerdict>();
    // Newest first from the store; the first one seen for a key is kept.
    for (const v of list) if (v?.article_key && !byKey.has(v.article_key)) byKey.set(v.article_key, v);
    verdicts = { at: now(), byKey };
    return byKey;
  }

  async function reading(request: NewsArticleRequest): Promise<NewsArticleReadingResult> {
    try {
      const index = await verdictIndex();
      const verdict = index.get(articleKey(request)) ?? null;
      return { ok: true, verdict: verdict && verdict.status === "ok" ? verdict : null };
    } catch (err) {
      // The engine out of reach, a timeout or an error reply: not "no verdict".
      return { ok: false, error: err instanceof Error ? err.message : String(err), reason: "lookup_failed" };
    }
  }

  function withinRate(): boolean {
    const t = now();
    recent = recent.filter((at) => t - at < ANALYSIS_RATE_WINDOW_MS);
    if (recent.length >= ANALYSIS_RATE_MAX) return false;
    recent.push(t);
    return true;
  }

  async function analysis(raw: NewsAnalysisRequest): Promise<NewsAnalysisResult> {
    const request = sanitizeRequest(raw);
    if (!request) return { ok: false, error: "no article", reason: "failed" };
    const language = deps.isLanguage(raw.language) ? (raw.language as string) : deps.language();
    const key = `${articleKey(request)}|${language}|${NEWS_ANALYSIS_VERSION}`;
    const hit = reads.get(key);
    if (hit) return { ok: true, analysis: hit, cached: true };
    if (!deps.configured()) return { ok: false, error: "no model configured", reason: "unavailable" };
    // An automatic read is only for an article the server has no verdict on.
    // When the lookup itself failed the server may well have one, so no model
    // call is made until the reader asks for it (`trigger: "manual"`). The
    // index is held for a minute, so this is normally the lookup the panel's
    // own reading request just made, not another one.
    if (raw.trigger !== "manual") {
      try {
        await verdictIndex();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), reason: "lookup_failed" };
      }
    }
    if (!readFlight.has(key) && !withinRate()) return { ok: false, error: "too many reads at once", reason: "busy" };

    return readFlight.run(key, async () => {
      try {
        const text = await body(request);
        const source = analysisSource(request, text);
        if (!source) return { ok: false as const, error: "not enough of the article to read", reason: "thin" as const };
        const relationships = await deps.relationships(request.tickers).catch(() => []);
        const result = await analyzeNewsArticle(request, source, relationships, language, {
          caller: deps.caller,
          model: (deps.model ?? newsModel)(),
          now: () => new Date(now()),
        });
        reads.set(key, result);
        return { ok: true as const, analysis: result, cached: false };
      } catch (err) {
        if (!(err instanceof NewsAnalysisError)) console.error("[news-article] analysis failed:", err);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err), reason: "failed" as const };
      }
    });
  }

  return {
    async body(raw: unknown): Promise<NewsArticleBodyResult> {
      const request = sanitizeRequest(raw);
      if (!request) return { ok: false, error: "no article" };
      try {
        return { ok: true, body: await body(request) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async reading(raw: unknown): Promise<NewsArticleReadingResult> {
      const request = sanitizeRequest(raw);
      if (!request) return { ok: false, error: "no article", reason: "bad_request" };
      return reading(request);
    },
    analysis,
    /** For tests and shutdown: write both cache files now. */
    flush(): void {
      bodies.flush();
      reads.flush();
    },
  };
}

export type NewsArticleService = ReturnType<typeof createNewsArticleService>;
