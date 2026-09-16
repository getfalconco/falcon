export type GraphNodeKind = "ticker" | "name";

export type GraphNode = {
  id: string;
  label: string;
  kind: GraphNodeKind;
};

export type GraphEdge = {
  id: string;
  root_ticker: string;
  counterparty_id: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  category: string;
  subtype: string;
  confidence: number;
  strength?: number;
  strength_tier?: "critical" | "important" | "marginal";
  evidence_quote: string;
  source_url: string;
  valid_from: string;
  /** Date the source filing was filed with the SEC (YYYY-MM-DD). */
  filing_date?: string;
  /** SEC accession number of the source filing, dashed form. */
  accession_number?: string | null;
};

export type GraphFile = {
  generatedAt: string;
  pipelineVersion: number;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  reverseIndex: Record<string, GraphEdge[]>;
};

export type RelationshipCategory =
  | "supplier"
  | "customer"
  | "partner"
  | "competitor"
  | "dependency";
