/**
 * §13 evaluation harness.
 *
 * Loads a labeled set (one record per article: the request plus the expected
 * per-ticker labels and event_type), scores verdicts against it and reports
 * each gate metric against the configured thresholds. Verdicts come either
 * from the verdict store (Phase A shadow log) or from a supplied classify
 * function — the harness itself never calls a model.
 */

import fs from "node:fs";
import type { ClassifierConfig, ClassifierEvalThresholds } from "./config.js";
import type {
  ClassificationRequest,
  Direction,
  EventType,
  Materiality,
  Relevance,
  Verdict,
} from "./types.js";

export type LabeledTicker = {
  ticker: string;
  relevance: Relevance;
  /** Required when relevance ≠ none. */
  materiality?: Materiality;
  direction?: Direction;
};

export type LabeledArticle = {
  request: ClassificationRequest;
  expected: {
    event_type: EventType;
    tickers: LabeledTicker[];
  };
  /** Who labeled it and whether it was spot-checked (§13 workflow). */
  labeled_by?: string;
  spot_checked?: boolean;
};

export type EvalMetric = {
  name: keyof ClassifierEvalThresholds;
  label: string;
  correct: number;
  total: number;
  accuracy: number | null;
  threshold: number;
  pass: boolean;
};

export type EvalReport = {
  labeled_articles: number;
  evaluated_articles: number;
  /** Articles with no usable (status ok) verdict. */
  missing_verdicts: number;
  metrics: EvalMetric[];
  /** Every gate metric passes AND the set is large enough. */
  pass: boolean;
  size_ok: boolean;
  /** Confusion over event_type: expected → predicted → count. */
  event_type_confusion: Record<string, Record<string, number>>;
  /** Per-article misses, for the prompt-iteration loop. */
  misses: Array<{
    article_key: string;
    ticker: string | null;
    field: "event_type" | "relevance" | "materiality" | "direction";
    expected: string;
    got: string;
  }>;
};

const MATERIALITY_RANK: Record<Materiality, number> = { low: 0, standard: 1, high: 2 };

export function loadLabeledSet(file: string): LabeledArticle[] {
  const text = fs.readFileSync(file, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Accept either a JSON array or JSONL.
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as LabeledArticle[];
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LabeledArticle);
}

export type VerdictResolver = (request: ClassificationRequest) => Verdict | null | Promise<Verdict | null>;

/** Score a labeled set against resolved verdicts (pure apart from the resolver). */
export async function evaluateClassifier(
  labeled: LabeledArticle[],
  resolve: VerdictResolver,
  config: Pick<ClassifierConfig, "eval">,
): Promise<EvalReport> {
  const t = config.eval;
  let relevanceCorrect = 0;
  let relevanceTotal = 0;
  let eventCorrect = 0;
  let eventTotal = 0;
  let matCorrect = 0;
  let matTotal = 0;
  let dirCorrect = 0;
  let dirTotal = 0;
  let evaluated = 0;
  let missing = 0;
  const confusion: EvalReport["event_type_confusion"] = {};
  const misses: EvalReport["misses"] = [];

  for (const item of labeled) {
    const verdict = await resolve(item.request);
    if (!verdict || verdict.status !== "ok") {
      missing += 1;
      continue;
    }
    evaluated += 1;
    const key = verdict.article_key;

    eventTotal += 1;
    confusion[item.expected.event_type] ??= {};
    confusion[item.expected.event_type][verdict.event_type] =
      (confusion[item.expected.event_type][verdict.event_type] ?? 0) + 1;
    if (verdict.event_type === item.expected.event_type) eventCorrect += 1;
    else {
      misses.push({
        article_key: key,
        ticker: null,
        field: "event_type",
        expected: item.expected.event_type,
        got: verdict.event_type,
      });
    }

    const byTicker = new Map(verdict.tickers.map((v) => [v.ticker.toUpperCase(), v]));
    for (const label of item.expected.tickers) {
      const got = byTicker.get(label.ticker.toUpperCase());
      if (!got) continue; // unassessed (overflow) — not scored
      relevanceTotal += 1;
      if (got.relevance === label.relevance) relevanceCorrect += 1;
      else {
        misses.push({ article_key: key, ticker: label.ticker, field: "relevance", expected: label.relevance, got: got.relevance });
      }

      // Materiality within one tier, scored where both sides have one.
      if (label.relevance !== "none" && label.materiality && got.relevance !== "none") {
        matTotal += 1;
        const delta = Math.abs(MATERIALITY_RANK[got.materiality] - MATERIALITY_RANK[label.materiality]);
        if (delta <= 1) matCorrect += 1;
        else {
          misses.push({ article_key: key, ticker: label.ticker, field: "materiality", expected: label.materiality, got: got.materiality });
        }
      }

      // Direction on the direct-relevance subset (by expected label).
      if (label.relevance === "direct" && label.direction) {
        dirTotal += 1;
        if (got.relevance !== "none" && got.direction === label.direction) dirCorrect += 1;
        else {
          misses.push({
            article_key: key,
            ticker: label.ticker,
            field: "direction",
            expected: label.direction,
            got: got.relevance === "none" ? "(none)" : got.direction,
          });
        }
      }
    }
  }

  const metric = (
    name: keyof ClassifierEvalThresholds,
    label: string,
    correct: number,
    total: number,
    threshold: number,
  ): EvalMetric => {
    const accuracy = total > 0 ? correct / total : null;
    return { name, label, correct, total, accuracy, threshold, pass: accuracy !== null && accuracy >= threshold };
  };

  const metrics: EvalMetric[] = [
    metric("relevanceAccuracy", "relevance accuracy", relevanceCorrect, relevanceTotal, t.relevanceAccuracy),
    metric("eventTypeAccuracy", "event_type top-1 accuracy", eventCorrect, eventTotal, t.eventTypeAccuracy),
    metric("materialityWithinOneTier", "materiality within one tier", matCorrect, matTotal, t.materialityWithinOneTier),
    metric("directionAccuracyDirect", "direction accuracy (direct subset)", dirCorrect, dirTotal, t.directionAccuracyDirect),
  ];
  const size_ok = labeled.length >= t.minLabeledArticles;
  return {
    labeled_articles: labeled.length,
    evaluated_articles: evaluated,
    missing_verdicts: missing,
    metrics,
    pass: size_ok && metrics.every((m) => m.pass),
    size_ok,
    event_type_confusion: confusion,
    misses,
  };
}

/** Plain-text rendering for the CLI / panel. */
export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    `Eval set: ${report.labeled_articles} labeled · ${report.evaluated_articles} evaluated · ${report.missing_verdicts} missing verdicts` +
      (report.size_ok ? "" : " · set below minimum size"),
  );
  for (const m of report.metrics) {
    const acc = m.accuracy === null ? "n/a" : `${(m.accuracy * 100).toFixed(1)}%`;
    lines.push(`  ${m.pass ? "PASS" : "FAIL"}  ${m.label}: ${acc} (${m.correct}/${m.total}) ≥ ${(m.threshold * 100).toFixed(0)}%`);
  }
  lines.push(`Gate: ${report.pass ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}
