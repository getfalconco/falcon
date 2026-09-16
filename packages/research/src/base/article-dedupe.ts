/**
 * Cross-ticker article deduplication — the decision layer of B2.
 *
 * A syndicated article lands on every ticker it names within the same poll,
 * and each arrival would be its own Classifier request. In the pilot shadow
 * data 1008 news_item messages carried only 783 distinct articles: 22% of the
 * Classifier budget spent re-classifying the same text.
 *
 * This module decides, purely and deterministically, which arrival of an
 * article is the *first* (and so the one that goes to the Classifier) and
 * which are *followers* that wait for its verdict. The in-flight tracking,
 * verdict fan-out and budget accounting belong to the §5 dispatch loop and are
 * not here.
 */

import { createHash } from "node:crypto";
import type {
  NewsItemPayload,
} from "../tracker/types.js";
import type { BaseConfig } from "./config.js";
import type { BaseMessage } from "./types.js";

/** How the identity was derived, most to least reliable. */
export type ArticleKeySource = "article_id" | "url" | "headline";

export type ArticleKey = {
  key: string;
  source: ArticleKeySource;
};

/**
 * Canonical identity for an article: article_id when the provider gives one,
 * else a normalised URL, else (source, headline). Each fallback is strictly
 * weaker — two different articles can share a headline — so the source is
 * reported alongside the key.
 */
export function articleKey(message: BaseMessage, config: BaseConfig): ArticleKey | null {
  if (message.type !== "news_item") return null;
  const p = message.payload as NewsItemPayload;
  const id = p.article_id?.trim();
  if (id) return { key: `id:${id}`, source: "article_id" };
  const url = normaliseUrl(p.url, config);
  if (url) return { key: `url:${sha(url)}`, source: "url" };
  const headline = p.headline?.trim().toLowerCase().replace(/\s+/g, " ");
  if (headline) return { key: `hl:${sha(`${(p.source ?? "").toLowerCase()}|${headline}`)}`, source: "headline" };
  return null;
}

/** Strip scheme, www, tracking params, fragment and trailing slash. */
export function normaliseUrl(raw: string | undefined, config: BaseConfig): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const drop = new Set(config.dedupe.strippedQueryParams.map((s) => s.toLowerCase()));
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !drop.has(k.toLowerCase()) && !/^utm_/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `${host}${path}${query}`;
  } catch {
    return null;
  }
}

function sha(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Decisions over a message set
// ---------------------------------------------------------------------------

export type ArticleDecision =
  /** First arrival inside the TTL: this one goes to the Classifier. */
  | { role: "lead"; key: ArticleKey }
  /** Same article already led within the TTL: wait for that verdict. */
  | { role: "follower"; key: ArticleKey; lead_message_id: string }
  /** Not a news_item, or no identity derivable: never deduped. */
  | { role: "none" };

export type ArticleGroup = {
  key: ArticleKey;
  lead_message_id: string;
  /** Every message carrying the article, lead first, in arrival order. */
  message_ids: string[];
  /** Distinct tickers the article landed on. */
  tickers: string[];
  /** ≥ config.dedupe.syndicatedMinTickers tickers — a materiality hint. */
  syndicated: boolean;
};

export type ArticleDedupeResult = {
  decisions: Map<string, ArticleDecision>;
  groups: ArticleGroup[];
  /** news_item messages in the input. */
  news_count: number;
  /** Distinct articles — the Classifier requests that would actually go out. */
  lead_count: number;
  /** news_count - lead_count: requests the dedupe saves. */
  follower_count: number;
  /** Per key-source histogram, to see how often the weaker fallbacks are used. */
  by_key_source: Record<ArticleKeySource, number>;
};

/**
 * Assign lead/follower roles across a message stream. Deterministic: the
 * stream is ordered by (timestamp, id) first, so the lead is always the same
 * message regardless of arrival order (§8).
 *
 * TTL: a second arrival more than `ttlMs` after the lead is a new lead — the
 * article has aged out of the cache and would be re-classified.
 */
export function dedupeArticles(messages: BaseMessage[], config: BaseConfig): ArticleDedupeResult {
  const ordered = [...messages].sort((a, b) => {
    const d = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const decisions = new Map<string, ArticleDecision>();
  const groups = new Map<string, ArticleGroup & { lead_at: number }>();
  const by_key_source: Record<ArticleKeySource, number> = { article_id: 0, url: 0, headline: 0 };
  let news_count = 0;
  let lead_count = 0;

  for (const m of ordered) {
    if (m.type !== "news_item") {
      decisions.set(m.id, { role: "none" });
      continue;
    }
    news_count += 1;
    const key = config.dedupe.enabled ? articleKey(m, config) : null;
    if (!key) {
      decisions.set(m.id, { role: "none" });
      lead_count += 1; // no identity -> cannot be deduped -> its own request
      continue;
    }
    by_key_source[key.source] += 1;
    const at = Date.parse(m.timestamp);
    const existing = groups.get(key.key);
    if (existing && at - existing.lead_at <= config.dedupe.ttlMs) {
      existing.message_ids.push(m.id);
      if (!existing.tickers.includes(m.ticker)) existing.tickers.push(m.ticker);
      decisions.set(m.id, { role: "follower", key, lead_message_id: existing.lead_message_id });
      continue;
    }
    // First arrival, or the prior lead aged out of the TTL.
    lead_count += 1;
    groups.set(key.key, {
      key,
      lead_message_id: m.id,
      message_ids: [m.id],
      tickers: [m.ticker],
      syndicated: false,
      lead_at: at,
    });
    decisions.set(m.id, { role: "lead", key });
  }

  const out: ArticleGroup[] = [...groups.values()].map(({ lead_at: _a, ...g }) => ({
    ...g,
    syndicated: g.tickers.length >= config.dedupe.syndicatedMinTickers,
  }));

  return {
    decisions,
    groups: out,
    news_count,
    lead_count,
    follower_count: news_count - lead_count,
    by_key_source,
  };
}
