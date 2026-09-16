import { createHash } from "node:crypto";
import { normalizeWhitespace } from "./normalize.js";
import type { ValidatedEdge } from "./types.js";

export function evidenceQuoteHash(quote: string): string {
  const normalized = normalizeWhitespace(quote).toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** Assign shared_evidence_group from normalized evidence quote hash (one row per edge). */
export function assignEvidenceGroups(edges: ValidatedEdge[]): ValidatedEdge[] {
  return edges.map((edge) => {
    const quote = edge.evidence[0]?.quote ?? "";
    const hash = evidenceQuoteHash(quote);
    return { ...edge, shared_evidence_group: `ev_${hash}` };
  });
}
