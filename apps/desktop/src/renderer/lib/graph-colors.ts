import type { RelationshipCategory } from "../../shared/graph-types";

export const CATEGORY_COLORS: Record<RelationshipCategory, string> = {
  supplier: "#5b8fbf",
  customer: "#5a9e78",
  partner: "#a68b5b",
  competitor: "#b86b6b",
  dependency: "#8b7bb8",
};

export const CATEGORY_LABELS: { id: RelationshipCategory; label: string }[] = [
  { id: "supplier", label: "Supplier" },
  { id: "customer", label: "Customer" },
  { id: "partner", label: "Partner" },
  { id: "competitor", label: "Competitor" },
  { id: "dependency", label: "Dependency" },
];

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category as RelationshipCategory] ?? "#6b7280";
}

export function linkOpacity(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  // Floor lifted for the light shell: 0.2 alpha vanished on a pale ground.
  return 0.45 + clamped * 0.45;
}

export function withAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const SEEDED_NODE_COLOR = "#2f7fa6";
export const COUNTERPARTY_NODE_COLOR = "#5b616b";
