export const RELATIONSHIP_TYPES = [
  "manufacturing",
  "supplier",
  "customer",
  "competitor",
  "regulation",
  "technology",
  "second_order",
  "risk",
  "macro",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export type GraphNode = {
  id: string;
  name: string;
  role?: string;
  relationshipType?: RelationshipType;
  importanceScore?: number;
  confidenceScore?: number;
  sourceUrls?: string[];
  description?: string;
};

export type RelationshipGraphCategory = {
  category: string;
  color?: string;
  nodes: GraphNode[];
};

export type SecondOrderChain = {
  id: string;
  trigger: string;
  mechanism: string;
  affectedEntities: string[];
  severity?: "low" | "medium" | "high";
  confidenceScore?: number;
  sourceUrls?: string[];
};

export type GraphCrossLink = {
  from: string;
  to: string;
  relationship?: string;
  strength?: number;
};
