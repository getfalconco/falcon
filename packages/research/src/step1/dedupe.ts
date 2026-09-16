import { normalizeCompanyName, normalizeWhitespace } from "./normalize.js";
import type { CandidateEdge, MergedCandidate, RejectedCandidate } from "./types.js";

function quoteKey(quote: string): string {
  return normalizeWhitespace(quote).toLowerCase();
}

function withQuotes(edge: CandidateEdge): CandidateEdge {
  return {
    ...edge,
    evidence_quotes: edge.evidence_quotes?.length
      ? edge.evidence_quotes
      : [edge.evidence_quote],
  };
}

function appendEvidenceQuote(kept: CandidateEdge, quote: string): void {
  const quotes = kept.evidence_quotes ?? [kept.evidence_quote];
  const key = quoteKey(quote);
  if (quotes.some((q) => quoteKey(q) === key)) return;
  if (quotes.length >= 3) return;
  quotes.push(quote);
  kept.evidence_quotes = quotes;
}

function toMerged(c: CandidateEdge, keptName: string): MergedCandidate {
  return {
    counterparty_name: c.counterparty_name,
    category: c.category,
    subtype: c.subtype,
    evidence_quote: c.evidence_quote,
    confidence: c.confidence,
    merged_into: keptName,
  };
}

export function dedupeCandidates(candidates: CandidateEdge[]): {
  kept: CandidateEdge[];
  rejected: RejectedCandidate[];
  merged: MergedCandidate[];
} {
  const rejected: RejectedCandidate[] = [];
  const merged: MergedCandidate[] = [];
  const byKey = new Map<string, CandidateEdge>();

  for (const c of candidates) {
    if (c.confidence < 0.6) {
      rejected.push({
        counterparty_name: c.counterparty_name,
        category: c.category,
        subtype: c.subtype,
        evidence_quote: c.evidence_quote,
        confidence: c.confidence,
        reason: "confidence below 0.6",
        stage: "dedupe",
      });
      continue;
    }

    const key = `${normalizeCompanyName(c.counterparty_name)}|${c.category}`;
    const existing = byKey.get(key);
    if (!existing || c.confidence > existing.confidence) {
      const next = withQuotes(c);
      if (existing) {
        merged.push(toMerged(existing, next.counterparty_name));
        for (const q of existing.evidence_quotes ?? [existing.evidence_quote]) {
          appendEvidenceQuote(next, q);
        }
      }
      byKey.set(key, next);
    } else {
      merged.push(toMerged(c, existing.counterparty_name));
      appendEvidenceQuote(existing, c.evidence_quote);
    }
  }

  return { kept: [...byKey.values()], rejected, merged };
}
