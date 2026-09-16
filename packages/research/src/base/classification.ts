/**
 * Base-side Classifier companion (task B9; Classifier spec §3, §9, §10).
 *
 * Base owns: the request shape (lead ticker set ≤ cap, addenda for uncovered
 * followers), the daily budget, the §10b re-score mapping, syndication
 * fan-out and propagation-candidate accumulation. All pure functions over
 * (messages, verdicts, config) — the Classifier service is called by the
 * host, never from here.
 */

import type { TickerContext, TickerVerdict, Verdict } from "../classifier/types.js";
import { describeItemCode } from "../classifier/filing-items.js";
import type {
  FilingItemPayload,
  NewsItemPayload,
} from "../tracker/types.js";
import { articleKey, dedupeArticles } from "./article-dedupe.js";
import type { BaseConfig } from "./config.js";
import { routeMessage } from "./routing.js";
import type {
  BaseMessage,
  PropagationCandidate,
} from "./types.js";
import type { ClassificationRequest } from "../classifier/types.js";

// ---------------------------------------------------------------------------
// Article identity shared with the Classifier
// ---------------------------------------------------------------------------

/** Canonical article_key for a message: Base's dedupe key for news, `8k:<accession>` for filings. */
export function classificationKey(message: BaseMessage, config: BaseConfig): string | null {
  if (message.type === "news_item") return articleKey(message, config)?.key ?? null;
  if (message.type === "filing_item") {
    const p = message.payload as FilingItemPayload;
    return p.accession_number ? `8k:${p.accession_number}` : null;
  }
  return null;
}

/** True when the routing table sends this message to the Classifier. */
export function isClassifierBound(message: BaseMessage, config: BaseConfig): boolean {
  if (message.type !== "news_item" && message.type !== "filing_item") return false;
  const outcome = routeMessage(
    message,
    { composite_tags: [], priority_band: "P3", trigger_type: "organic" },
    config,
  );
  return outcome.action === "route" && outcome.destination === "classifier";
}

// ---------------------------------------------------------------------------
// Per-message classification state + §10b mapping
// ---------------------------------------------------------------------------

export type MessageClassification =
  /** No verdict for this article yet (or not classifier-bound). */
  | { state: "unclassified" }
  /** Verdict exists but is `status: "failed"` — base severity stands (§9). */
  | { state: "failed"; verdict: Verdict }
  /** Verdict exists but this ticker was beyond the cap — base severity stands. */
  | { state: "unassessed"; verdict: Verdict }
  | {
      state: "classified";
      verdict: Verdict;
      entry: TickerVerdict;
      /**
       * Set by the pre-earnings preview cap (config.classifier.preEarningsPreview):
       * the entry's materiality has been capped to `low` because the article
       * was published inside the window before the ticker's known earnings
       * due_at. Never a propagation candidate.
       */
      pre_earnings_preview?: boolean;
    };

export type VerdictLookup = (message: BaseMessage) => MessageClassification;

const MATERIALITY_RANK = { low: 0, standard: 1, high: 2 } as const;

/**
 * §10b: severity contribution for a classified message. Pure function of the
 * classification state and config — the table is data, not code.
 */
export function classifiedSeverity(classification: MessageClassification, config: BaseConfig): number {
  const m = config.classifier.severityMapping;
  switch (classification.state) {
    case "unclassified":
    case "failed":
    case "unassessed":
      return m.unassessed;
    case "classified": {
      const entry = classification.entry;
      if (entry.relevance === "none") return m.none;
      return m[entry.relevance][entry.materiality];
    }
  }
}

/** Build a lookup over a set of verdicts keyed by article_key. */
export function verdictLookupFrom(
  resolve: (articleKey: string) => Verdict | null,
  config: BaseConfig,
): VerdictLookup {
  return (message) => {
    const key = classificationKey(message, config);
    if (!key) return { state: "unclassified" };
    const verdict = resolve(key);
    if (!verdict) return { state: "unclassified" };
    if (verdict.status !== "ok") return { state: "failed", verdict };
    const ticker = message.ticker.toUpperCase();
    const entry = verdict.tickers.find((t) => t.ticker.toUpperCase() === ticker);
    if (entry) return { state: "classified", verdict, entry };
    return { state: "unassessed", verdict };
  };
}

export function lookupFromVerdicts(verdicts: Iterable<Verdict>, config: BaseConfig): VerdictLookup {
  const byKey = new Map<string, Verdict>();
  for (const v of verdicts) {
    const prior = byKey.get(v.article_key);
    // Prefer an ok verdict; among equals the latest.
    if (!prior || (prior.status !== "ok" && v.status === "ok") || (prior.status === v.status && v.classified_at > prior.classified_at)) {
      byKey.set(v.article_key, v);
    }
  }
  return verdictLookupFrom((key) => byKey.get(key) ?? null, config);
}

export const NO_VERDICTS: VerdictLookup = () => ({ state: "unclassified" });

// ---------------------------------------------------------------------------
// §10c propagation candidates
// ---------------------------------------------------------------------------

/**
 * A verdict with relevance direct, materiality ≥ the configured minimum and a
 * network-relevant event type becomes a propagation candidate. Data
 * accumulation for the future Propagation engine — not a routing row.
 */
export function propagationCandidatesFor(
  messages: BaseMessage[],
  lookup: VerdictLookup,
  config: BaseConfig,
): PropagationCandidate[] {
  const out: PropagationCandidate[] = [];
  const seen = new Set<string>();
  const minRank = MATERIALITY_RANK[config.classifier.propagationMinMateriality];
  for (const message of messages) {
    const c = lookup(message);
    if (c.state !== "classified") continue;
    // A pre-earnings preview is never a candidate, whatever its capped materiality.
    if (c.pre_earnings_preview) continue;
    const entry = c.entry;
    if (entry.relevance !== "direct") continue;
    if (MATERIALITY_RANK[entry.materiality] < minRank) continue;
    if (!config.classifier.networkRelevantEventTypes.includes(c.verdict.event_type)) continue;
    const id = `${message.ticker}|${c.verdict.article_key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      ticker: message.ticker,
      article_key: c.verdict.article_key,
      event_type: c.verdict.event_type,
      event_label: c.verdict.event_label,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §3 request building: lead + addendum, ticker cap
// ---------------------------------------------------------------------------

export type BuildRequestsOptions = {
  config: BaseConfig;
  /** §2 metadata — symbol-only context when missing. */
  tickerContext: (ticker: string) => TickerContext;
  /** The cached verdict for an article (Classifier store), if any. */
  existingVerdict: (articleKey: string) => Verdict | null;
  now: string;
};

export type BuildRequestsResult = {
  requests: ClassificationRequest[];
  /** Classifier-bound articles already fully covered by a verdict. */
  covered: number;
  /** Lead requests whose ticker set exceeded the cap. */
  overflows: number;
  /** Classifier-bound messages with no derivable identity (never deduped, never requested). */
  unidentifiable: number;
};

type Group = { key: string; kind: "news" | "filing"; tickers: string[]; sample: BaseMessage };

/**
 * Turn a message stream into the Classifier requests Base would dispatch:
 * one lead per distinct article with the ticker set at dispatch (≤ cap,
 * overflow unassessed), and an addendum per article already verdicted whose
 * newly-arrived tickers are not covered. Deterministic over the input order
 * (the dedupe layer sorts by timestamp, id).
 */
export function buildClassificationRequests(
  messages: BaseMessage[],
  options: BuildRequestsOptions,
): BuildRequestsResult {
  const { config } = options;
  const groups = new Map<string, Group>();
  let unidentifiable = 0;

  // News: reuse B2's grouping so lead/follower and syndication match Base exactly.
  const news = messages.filter((m) => m.type === "news_item");
  const deduped = dedupeArticles(news, config);
  for (const g of deduped.groups) {
    const sample = news.find((m) => m.id === g.lead_message_id) ?? news[0];
    groups.set(g.key.key, { key: g.key.key, kind: "news", tickers: [...g.tickers], sample });
  }
  for (const m of news) {
    const d = deduped.decisions.get(m.id);
    if (!d || d.role === "none") unidentifiable += 1;
  }

  // Filings: unmapped 8-Ks, grouped by accession.
  for (const m of messages) {
    if (m.type !== "filing_item" || !isClassifierBound(m, config)) continue;
    const key = classificationKey(m, config);
    if (!key) {
      unidentifiable += 1;
      continue;
    }
    const g = groups.get(key) ?? { key, kind: "filing" as const, tickers: [], sample: m };
    if (!g.tickers.includes(m.ticker)) g.tickers.push(m.ticker);
    groups.set(key, g);
  }

  const requests: ClassificationRequest[] = [];
  let covered = 0;
  let overflows = 0;
  const cap = Math.max(1, config.classifier.tickerCap);

  for (const g of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const existing = options.existingVerdict(g.key);
    const coveredTickers = new Set(
      existing?.status === "ok" ? existing.tickers.map((t) => t.ticker.toUpperCase()) : [],
    );
    const wanted = g.tickers.map((t) => t.toUpperCase()).filter((t) => !coveredTickers.has(t));
    if (wanted.length === 0) {
      covered += 1;
      continue;
    }
    const mode: ClassificationRequest["mode"] = existing?.status === "ok" ? "addendum" : "lead";
    const assessed = wanted.slice(0, cap);
    const unassessed = wanted.slice(cap);
    if (unassessed.length > 0 && mode === "lead") overflows += 1;

    const base = {
      request_id: `${g.key}|${mode}|${assessed.join(",")}`,
      kind: g.kind,
      mode,
      tickers: assessed.map((t) => options.tickerContext(t)),
      unassessed_tickers: unassessed,
      syndication_scope: g.tickers.length,
      requested_at: options.now,
    };
    if (g.kind === "news") {
      const p = g.sample.payload as NewsItemPayload;
      requests.push({
        ...base,
        article: {
          article_key: g.key,
          headline: p.headline ?? "",
          summary: p.summary ?? "",
          source: p.source ?? "",
          published_at: p.published_at ?? g.sample.timestamp,
          article_id: p.article_id || null,
        },
        filing: null,
      });
    } else {
      const p = g.sample.payload as FilingItemPayload;
      requests.push({
        ...base,
        article: null,
        filing: {
          article_key: g.key,
          form_type: p.form_type,
          accession_number: p.accession_number,
          filed_at: p.filed_at,
          item_codes: [...p.item_codes],
          item_descriptions: p.item_codes.map(describeItemCode),
        },
      });
    }
  }

  return { requests, covered, overflows, unidentifiable };
}

// ---------------------------------------------------------------------------
// §9 daily budget (ET-midnight reset)
// ---------------------------------------------------------------------------

export type BudgetLedger = {
  /** ET calendar day "YYYY-MM-DD" the counter belongs to. */
  day: string;
  used: number;
  /**
   * S2: the slice of `used` spent on Screen-driven `structure_review`
   * requests, so the sub-cap can be enforced without a second ledger.
   */
  structure_used?: number;
};

const ET_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The ET calendar day for an instant. */
export function etDayOf(iso: string): string {
  return ET_DAY.format(new Date(iso));
}

export function budgetRemaining(ledger: BudgetLedger | null, now: string, config: BaseConfig): number {
  const day = etDayOf(now);
  const used = ledger && ledger.day === day ? ledger.used : 0;
  return Math.max(0, config.classifier.dailyBudget - used);
}

/**
 * Consume `n` from the budget, rolling the ledger over at ET midnight.
 * `structureN` (≤ n) is the part spent on Screen-driven structure reviews.
 */
export function consumeBudget(ledger: BudgetLedger | null, now: string, n: number, structureN = 0): BudgetLedger {
  const day = etDayOf(now);
  const same = ledger && ledger.day === day;
  const used = same ? ledger.used : 0;
  const structure = same ? (ledger.structure_used ?? 0) : 0;
  const next: BudgetLedger = { day, used: used + n };
  // Only the Analyst ledger ever carries the sub-counter; the Classifier's
  // stays byte-identical to what it wrote before the channel existed.
  if (structure + structureN > 0) next.structure_used = structure + structureN;
  return next;
}

/** Structure-review requests still available today under the §S2 sub-cap. */
export function structureBudgetRemaining(ledger: BudgetLedger | null, now: string, config: BaseConfig): number {
  const day = etDayOf(now);
  const used = ledger && ledger.day === day ? (ledger.structure_used ?? 0) : 0;
  return Math.max(0, config.analyst.tapeStructureDailySubCap - used);
}

/**
 * Priority-ordered budget queueing (§9): requests whose article sits in a
 * higher-priority incident go first; ties by request_id for determinism.
 * Returns the requests that fit, and the ones deferred.
 */
export function applyBudget(
  requests: ClassificationRequest[],
  priorityOf: (request: ClassificationRequest) => number,
  remaining: number,
): { dispatch: ClassificationRequest[]; deferred: ClassificationRequest[] } {
  const ordered = [...requests].sort(
    (a, b) => priorityOf(b) - priorityOf(a) || a.request_id.localeCompare(b.request_id),
  );
  return { dispatch: ordered.slice(0, Math.max(0, remaining)), deferred: ordered.slice(Math.max(0, remaining)) };
}
