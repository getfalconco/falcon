/**
 * Where a graph edge's strength tier came from (mirrors step1 `StrengthBasis`):
 * a share the filing states, the classifier's reading of the quote, or
 * neither. An "unclassified" edge carries the "important" tier so it ranks and
 * filters like one, but its tier was never measured: show it as unrated, never
 * as a tier label. Absent on graphs built before the basis was carried (read
 * as measured).
 */
export type StrengthBasis = "disclosed" | "classified" | "unclassified";

/** False only for an unclassified edge: rank by its tier, never show the tier. */
export function tierMeasured(e: { strength_basis?: string | null }): boolean {
  return e.strength_basis !== "unclassified";
}
