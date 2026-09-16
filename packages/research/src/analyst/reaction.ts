/**
 * §4 reaction_state — the deterministic priced-in pre-computation (v1.1).
 *
 * The model is never asked "is it priced in?" as an open question. This pure
 * function computes the market's realized reaction before the call and the
 * model interprets it. A pure function of (incident, verdicts, config): the
 * same inputs always produce the same state, so goldens hold.
 *
 * v1.1 (first rubric batch, CAH): a best_cause whose direction contradicts
 * the realized move cannot "explain" it — comparison is n_a and the default
 * undetermined; and a low-materiality best_cause never defaults to no_edge.
 */

import type { MessageClassification } from "../base/classification.js";
import type { BaseMessage, Incident } from "../base/types.js";
import type { Materiality } from "../classifier/types.js";
import type { TapeStructurePayload } from "../screen/types.js";
import type { NewsItemPayload, QuantContext, UnexplainedMovePayload } from "../tracker/types.js";
import type { AnalystConfig } from "./config.js";
import type { AnalystRequestKind, BestCause, Comparison, EdgeDefault, ReactionBasis, ReactionState } from "./types.js";

const MATERIALITY_RANK: Record<Materiality, number> = { low: 0, standard: 1, high: 2 };

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Which basis the incident's own measurements trust. An unexplained_move
 * message carries the Tracker's decision verbatim (`measure_used`); failing
 * that, the R² of the latest context against the configured fallback.
 */
export function chooseBasis(incident: Pick<Incident, "messages" | "quant_context">, config: AnalystConfig): Exclude<ReactionBasis, "incomputable"> {
  for (const m of incident.messages) {
    if (m.type !== "unexplained_move") continue;
    const used = (m.payload as UnexplainedMovePayload).measure_used;
    if (used === "residual_zscore") return "residual";
    if (used === "move_zscore") return "move";
  }
  const contexts: Array<QuantContext | null> = [incident.quant_context, ...incident.messages.map((m) => m.quant_context)];
  let r2: number | null = null;
  for (const q of contexts) {
    if (q && finite(q.r_squared)) {
      r2 = q.r_squared;
      break;
    }
  }
  if (r2 === null) return "move";
  return r2 >= config.edgeDefault.lowR2Fallback ? "residual" : "move";
}

/**
 * The realized reaction is the peak |z| the ticker showed anywhere in the
 * incident window on the chosen basis — the latest context is often already
 * post-reaction (WMT's latest z read −0.04 while the 8-K/volume messages
 * carried −7). Returns null z when nothing is computable.
 */
export function peakReaction(
  incident: Pick<Incident, "messages" | "quant_context">,
  basis: Exclude<ReactionBasis, "incomputable">,
): { realized_z: number | null; realized_pct: number | null } {
  const zKey = basis === "residual" ? "residual_zscore" : "move_zscore";
  const pctKey = basis === "residual" ? "residual_move" : "move_today";
  let best: { z: number; pct: number | null } | null = null;
  const consider = (q: QuantContext | null) => {
    if (!q) return;
    const z = q[zKey];
    if (!finite(z)) return;
    if (!finite(q.daily_vol_30d)) return; // §4: null vol → not computable
    if (!best || Math.abs(z) > Math.abs(best.z)) {
      best = { z, pct: finite(q[pctKey]) ? q[pctKey] : null };
    }
  };
  for (const m of incident.messages) consider(m.quant_context);
  consider(incident.quant_context);
  const b = best as { z: number; pct: number | null } | null;
  return b ? { realized_z: b.z, realized_pct: b.pct } : { realized_z: null, realized_pct: null };
}

/** Highest-materiality direct verdict for the primary ticker; ties → earliest message, then id. */
export function bestCauseOf(
  incident: Pick<Incident, "messages" | "ticker">,
  verdicts: Record<string, MessageClassification>,
): BestCause | null {
  const ordered = [...incident.messages].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  );
  let best: { rank: number; cause: BestCause } | null = null;
  for (const m of ordered) {
    const c = verdicts[m.id];
    if (!c || c.state !== "classified") continue;
    if (c.entry.relevance !== "direct") continue;
    const rank = MATERIALITY_RANK[c.entry.materiality];
    if (best && rank <= best.rank) continue;
    best = {
      rank,
      cause: {
        message_id: m.id,
        article_key: c.verdict.article_key,
        event_type: c.verdict.event_type,
        materiality: c.entry.materiality,
        direction: c.entry.direction,
        headline: headlineOf(m) ?? c.verdict.event_label,
      },
    };
  }
  return best?.cause ?? null;
}

function headlineOf(m: BaseMessage): string | null {
  if (m.type === "news_item") return (m.payload as NewsItemPayload).headline ?? null;
  return null;
}

/**
 * v1.1: a positive cause cannot explain a negative move (and vice versa).
 * mixed / unclear are exempt; a zero or null reaction is not a conflict.
 */
export function directionConflicts(cause: Pick<BestCause, "direction"> | null, realizedZ: number | null): boolean {
  if (!cause || realizedZ === null || realizedZ === 0) return false;
  if (cause.direction === "positive") return realizedZ < 0;
  if (cause.direction === "negative") return realizedZ > 0;
  return false;
}

export function compareToTier(absZ: number, tier: number, band: number): Comparison {
  if (absZ > tier + band) return "exceeded";
  if (absZ < tier - band) return "short_of";
  return "consistent";
}

/**
 * §4 edge_default — pure rules over (cause, comparison, |z|), v1.1:
 * - incomputable → watch
 * - cause whose direction conflicts with the move → undetermined
 * - cause below the no_edge materiality floor → undetermined
 * - cause and exceeded/consistent → no_edge; cause and short_of → undetermined
 * - no cause and |z| ≥ watchMinAbsZ → watch; else undetermined
 */
export function edgeDefaultOf(
  basis: ReactionBasis,
  cause: Pick<BestCause, "materiality" | "direction"> | null,
  comparison: Comparison,
  absZ: number | null,
  realizedZ: number | null,
  config: AnalystConfig,
): EdgeDefault {
  if (basis === "incomputable") return "watch";
  if (cause) {
    if (directionConflicts(cause, realizedZ)) return "undetermined";
    if (MATERIALITY_RANK[cause.materiality] < MATERIALITY_RANK[config.edgeDefault.noEdgeMinMateriality]) return "undetermined";
    if (comparison === "exceeded" || comparison === "consistent") return "no_edge";
    return "undetermined";
  }
  if (absZ !== null && absZ >= config.edgeDefault.watchMinAbsZ) return "watch";
  return "undetermined";
}

/**
 * S3: the newest `tape_structure` message in the incident — the structure a
 * `structure_review` reasons about.
 */
export function structureMessage(incident: Pick<Incident, "messages">): TapeStructurePayload | null {
  let best: { ts: string; payload: TapeStructurePayload } | null = null;
  for (const m of incident.messages) {
    if (m.type !== "tape_structure") continue;
    const payload = m.payload as TapeStructurePayload;
    if (!best || m.timestamp > best.ts) best = { ts: m.timestamp, payload };
  }
  return best?.payload ?? null;
}

/**
 * S3: a structure has no single event to price, so the reference point is the
 * pattern's first session rather than the peak session. The realized move is
 * the compounded move since then, and the z is Screen's multi-session
 * residual sum — null when the structure's residuals were not computable, in
 * which case the basis is `incomputable` and the default falls to `watch`.
 */
export function structureReaction(payload: TapeStructurePayload): { basis: ReactionBasis; realized_z: number | null; realized_pct: number | null } {
  const since = payload.since_first;
  const z = typeof since.residual_z_cum === "number" && Number.isFinite(since.residual_z_cum) ? since.residual_z_cum : null;
  const pct = typeof since.ret === "number" && Number.isFinite(since.ret) ? since.ret : null;
  return { basis: z === null ? "incomputable" : "residual", realized_z: z, realized_pct: pct };
}

export function computeReactionState(
  incident: Pick<Incident, "messages" | "quant_context" | "ticker">,
  verdicts: Record<string, MessageClassification>,
  config: AnalystConfig,
  kind: AnalystRequestKind = "anomaly_review",
): ReactionState {
  const structure = kind === "structure_review" ? structureMessage(incident) : null;
  const chosen = chooseBasis(incident, config);
  const measured = structure ? structureReaction(structure) : null;
  const peak = measured ? { realized_z: measured.realized_z, realized_pct: measured.realized_pct } : peakReaction(incident, chosen);
  const basis: ReactionBasis = measured ? measured.basis : peak.realized_z === null ? "incomputable" : chosen;
  const best_cause = bestCauseOf(incident, verdicts);
  const tier_expectation_z = best_cause ? config.tierExpectationZ[best_cause.materiality] : null;
  const absZ = peak.realized_z === null ? null : Math.abs(peak.realized_z);
  // v1.1: a cause that points the other way does not get compared at all.
  const conflict = directionConflicts(best_cause, peak.realized_z);
  const comparison: Comparison =
    best_cause && tier_expectation_z !== null && absZ !== null && !conflict
      ? compareToTier(absZ, tier_expectation_z, config.edgeDefault.consistentBandZ)
      : "n_a";
  return {
    basis,
    realized_pct: peak.realized_pct,
    realized_z: peak.realized_z,
    best_cause,
    tier_expectation_z,
    comparison,
    edge_default: edgeDefaultOf(basis, best_cause, comparison, absZ, peak.realized_z, config),
  };
}
