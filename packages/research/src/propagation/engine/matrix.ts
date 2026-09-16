/**
 * §5 transmission matrix + §6 strength — deterministic, config-driven.
 *
 * `matrix[event_type][role]` decides whether and how an event transmits
 * across a role. `same` inherits the root event's direction, `inverse` flips
 * it, `unclear` ships as `unclear` — never a guessed sign. `transmits: no`
 * produces no target. Strength = strength_tier × event materiality →
 * propagation tier.
 */

import type { Direction, EventType, Materiality } from "../../classifier/types.js";
import type { PropagationConfig } from "./config.js";
import type {
  DirectionRule,
  MatrixCell,
  PropagationRole,
  PropagationTier,
  StrengthTier,
  Transmission,
} from "./types.js";

export function matrixCell(
  config: Pick<PropagationConfig, "matrix">,
  eventType: EventType,
  role: PropagationRole,
): MatrixCell {
  return config.matrix[eventType]?.[role] ?? { transmits: "no", direction: "unclear" };
}

/** Flip a direction; mixed and unclear have no sign to flip. */
export function invertDirection(direction: Direction): Direction {
  if (direction === "positive") return "negative";
  if (direction === "negative") return "positive";
  return direction;
}

/** The target's direction under a matrix rule. */
export function resolveDirection(eventDirection: Direction, rule: DirectionRule): Direction {
  if (rule === "unclear") return "unclear";
  if (rule === "inverse") return invertDirection(eventDirection);
  return eventDirection;
}

export function propagationTier(
  config: Pick<PropagationConfig, "strengthMap">,
  strengthTier: StrengthTier,
  materiality: Materiality,
): PropagationTier {
  return config.strengthMap[strengthTier]?.[materiality] ?? "weak";
}

/**
 * Apply the matrix + strength map to one (event, relationship). Returns null
 * when the cell does not transmit — the caller counts it, never silently.
 */
export function transmissionFor(
  config: Pick<PropagationConfig, "matrix" | "strengthMap">,
  event: { type: EventType; direction: Direction; materiality: Materiality },
  relationship: { role: PropagationRole; tier: StrengthTier },
): Transmission | null {
  const cell = matrixCell(config, event.type, relationship.role);
  if (cell.transmits === "no") return null;
  return {
    tier: propagationTier(config, relationship.tier, event.materiality),
    direction: resolveDirection(event.direction, cell.direction),
    matrix_cell: `${event.type}:${relationship.role}`,
    transmits: cell.transmits,
    rule: cell.direction,
  };
}
