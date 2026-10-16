import { canonicalCounterparty, disclosedShareOfEdge, type Step1Result } from "@meridian/research/step1";
import type { GraphEdgeLike } from "@meridian/research/propagation";

/** Map a finished Step-1 result onto the graph_edges row shape. Pipeline untouched. */
export function edgesFromStep1Result(result: Step1Result): GraphEdgeLike[] {
  return result.validated.map((edge, index) => {
    // Same identity rules as buildGraphFromResearchDir (canonical name key, implausible tickers cleared).
    const { id: counterpartyId, ticker: counterpartyTicker, detail } = canonicalCounterparty(edge);
    const share = disclosedShareOfEdge(edge);
    return {
      id: `${edge.root_ticker}:${counterpartyId}:${edge.category}:${edge.subtype}:${index}`,
      root_ticker: edge.root_ticker,
      counterparty_id: counterpartyId,
      counterparty_name: edge.counterparty_name,
      counterparty_ticker: counterpartyTicker,
      counterparty_detail: detail,
      category: edge.category,
      subtype: edge.subtype,
      confidence: edge.confidence,
      strength: edge.strength,
      strength_tier: edge.strength_tier,
      strength_basis: edge.strength_basis,
      disclosed_share_pct: share.disclosed_share_pct,
      disclosed_share_quote: share.disclosed_share_quote,
      evidence_quote: edge.evidence[0]?.quote ?? "",
      source_url: edge.evidence[0]?.source_url ?? "",
      valid_from: edge.valid_from,
    };
  });
}
