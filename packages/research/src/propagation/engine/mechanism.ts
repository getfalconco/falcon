/**
 * §7 stage-1 template mechanism — deterministic fallback the run ships with
 * when stage-2 is unavailable or vetoes nothing:
 *
 *   "{ROOT} {event_label}. {TARGET} is a {tier} {role} of {ROOT} ({subtype},
 *    per {ROOT} filing). {Transmits} {direction}."
 */

import type { Direction } from "../../classifier/types.js";
import type { PropagationRole, StrengthTier, Transmission } from "./types.js";

const ROLE_PHRASE: Record<PropagationRole, string> = {
  supplier: "supplier",
  customer: "customer",
  competitor: "competitor",
  partner: "partner",
  dependency: "dependency",
  depended_on_by: "dependent",
};

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function directionPhrase(direction: Direction): string {
  switch (direction) {
    case "positive":
      return "positive";
    case "negative":
      return "negative";
    case "mixed":
      return "mixed";
    default:
      return "with unclear sign";
  }
}

export function capText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function templateMechanism(
  input: {
    root: string;
    eventLabel: string;
    target: string;
    role: PropagationRole;
    tier: StrengthTier;
    subtype: string;
    evidence_via: "forward" | "reverse";
    transmission: Transmission;
  },
  cap = 200,
): string {
  const tier = input.tier;
  const role = ROLE_PHRASE[input.role];
  const filer = input.evidence_via === "reverse" ? input.target : input.root;
  const subtype = input.subtype ? input.subtype.replace(/_/g, " ") : "relationship";
  const transmits = input.transmission.transmits === "weak" ? "Transmits weakly" : "Transmits";
  // A name that holds two roles at once (§4a): say so, and say why no
  // direction is called when those roles point opposite ways.
  const also = input.transmission.also_roles ?? [];
  const alsoClause = also.length
    ? ` Also ${also.map((r) => ROLE_PHRASE[r]).join(" and ")}${
        input.transmission.role_conflict
          ? " — the two roles point opposite ways, so no direction is called"
          : ""
      }.`
    : "";
  const sentence =
    `${input.root} ${input.eventLabel.replace(/\.$/, "")}. ` +
    `${input.target} is ${article(tier)} ${tier} ${role} of ${input.root} (${subtype}, per ${filer} filing). ` +
    `${transmits} ${directionPhrase(input.transmission.direction)}.${alsoClause}`;
  return capText(sentence, cap);
}
