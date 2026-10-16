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
  /**
   * The specific body behind a counterparty folded onto a broader node: the
   * US federal agency or branch on the single "U.S. government" node. Null
   * otherwise; absent on graphs built before the fold.
   */
  counterparty_detail?: string | null;
  category: string;
  subtype: string;
  confidence: number;
  strength?: number;
  strength_tier?: "critical" | "important" | "marginal";
  /** "unclassified": ranks as `strength_tier` but was never measured; never shown as a tier. Absent on older graphs. */
  strength_basis?: "disclosed" | "classified" | "unclassified";
  /**
   * The share the filing states for this relationship, in percent (revenue
   * share, purchase share, concentration); null when it states none; absent
   * on graphs built before it was carried. `strength` holds pct / 100 for a
   * disclosed share but a tier weight otherwise, so read the share from here.
   */
  disclosed_share_pct?: number | null;
  /** The filing quote that states `disclosed_share_pct`. */
  disclosed_share_quote?: string | null;
  evidence_quote: string;
  source_url: string;
  valid_from: string;
  /** Date the source filing was filed with the SEC (YYYY-MM-DD). */
  filing_date?: string;
  /** SEC accession number of the source filing, dashed form. */
  accession_number?: string | null;
  /** The source filing's form; absent on graphs built before it was carried. */
  form?: "10-K" | "20-F" | null;
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
