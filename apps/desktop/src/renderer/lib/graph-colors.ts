import type { RelationshipCategory } from "../../shared/graph-types";
import type { MessageKey } from "./i18n";
import type { Translate } from "./panels-format";

export const CATEGORY_COLORS: Record<RelationshipCategory, string> = {
  // Apple system hues (the graph is drawn on a canvas, so literal hex):
  // systemBlue, systemGreen, systemBrown, systemRed, systemPurple.
  supplier: "#007aff",
  customer: "#34c759",
  partner: "#a2845e",
  competitor: "#ff3b30",
  dependency: "#af52de",
};

/** The legend, in order; each label is a message the view puts in the reader's language. */
export const CATEGORY_LABELS: { id: RelationshipCategory; labelKey: MessageKey }[] = [
  { id: "supplier", labelKey: "panels.graph.category.supplier" },
  { id: "customer", labelKey: "panels.graph.category.customer" },
  { id: "partner", labelKey: "panels.graph.category.partner" },
  { id: "competitor", labelKey: "panels.graph.category.competitor" },
  { id: "dependency", labelKey: "panels.graph.category.dependency" },
];

/** A category's name in the reader's language; one the legend does not know reads as stored. */
export function categoryLabel(category: string, t: Translate): string {
  const known = CATEGORY_LABELS.find((c) => c.id === category);
  return known ? t(known.labelKey) : category.replace(/_/g, " ");
}

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category as RelationshipCategory] ?? "#8e8e93";
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

export const SEEDED_NODE_COLOR = "#30b0c7";
export const COUNTERPARTY_NODE_COLOR = "#8e8e93";
