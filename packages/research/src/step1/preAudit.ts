import { isGenericCounterparty } from "./genericGroup.js";
import { isNonNarrativeEvidence } from "./narrativeEvidence.js";
import { counterpartyNameInQuote, normalizeWhitespace } from "./normalize.js";
import type { CandidateEdge, RejectedCandidate } from "./types.js";

function quoteFoundInChunk(quote: string, chunk: string): boolean {
  const q = normalizeWhitespace(quote).toLowerCase();
  const c = normalizeWhitespace(chunk).toLowerCase();
  return q.length > 0 && c.includes(q);
}

/** Cheap programmatic checks — run on every candidate before dedupe. */
export function preAuditCandidates(
  candidates: CandidateEdge[],
  chunks: string[],
): { survivors: CandidateEdge[]; rejected: RejectedCandidate[] } {
  const survivors: CandidateEdge[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const edge of candidates) {
    const chunk = chunks[edge.chunk_index] ?? "";
    const quotes = edge.evidence_quotes?.length
      ? edge.evidence_quotes
      : [edge.evidence_quote];

    let quoteFailed = false;
    for (const quote of quotes) {
      if (!quoteFoundInChunk(quote, chunk)) {
        rejected.push({
          counterparty_name: edge.counterparty_name,
          category: edge.category,
          subtype: edge.subtype,
          evidence_quote: edge.evidence_quote,
          confidence: edge.confidence,
          reason: "quote not found in source (hallucinated evidence)",
          stage: "quote_check",
        });
        quoteFailed = true;
        break;
      }
    }
    if (quoteFailed) continue;

    if (!counterpartyNameInQuote(edge.counterparty_name, edge.evidence_quote)) {
      rejected.push({
        counterparty_name: edge.counterparty_name,
        category: edge.category,
        subtype: edge.subtype,
        evidence_quote: edge.evidence_quote,
        confidence: edge.confidence,
        reason: "counterparty name not in quote",
        stage: "quote_check",
      });
      continue;
    }

    if (isGenericCounterparty(edge.counterparty_name)) {
      rejected.push({
        counterparty_name: edge.counterparty_name,
        category: edge.category,
        subtype: edge.subtype,
        evidence_quote: edge.evidence_quote,
        confidence: edge.confidence,
        reason: "generic group, not a named entity",
        stage: "quote_check",
      });
      continue;
    }

    if (quotes.some((quote) => isNonNarrativeEvidence(quote))) {
      rejected.push({
        counterparty_name: edge.counterparty_name,
        category: edge.category,
        subtype: edge.subtype,
        evidence_quote: edge.evidence_quote,
        confidence: edge.confidence,
        reason: "non-narrative evidence (identifier/tag/fragment)",
        stage: "quote_check",
      });
      continue;
    }

    survivors.push(edge);
  }

  return { survivors, rejected };
}
