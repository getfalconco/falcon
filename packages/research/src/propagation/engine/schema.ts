/**
 * §7 stage-2 output schema + the subtract-only validator.
 *
 * The model may confirm, veto, adjust or annotate stage-1 targets. It may
 * never add one: every ref it returns must resolve to a candidate in the
 * stage-1 list, or the whole response is rejected structurally (retried with
 * the error appended, then the run ships stage-1-only). Fabricated
 * propagation is impossible by construction, not by prompt.
 */

import type { Direction } from "../../classifier/types.js";
import { DIRECTIONS } from "../../classifier/types.js";
import { extractJson } from "../../classifier/schema.js";
import type { PropagationConfig } from "./config.js";
import { STAGE2_VERDICTS, type PropagationTarget, type Stage2TargetResult, type Stage2Verdict } from "./types.js";

export const STAGE2_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["targets"],
  properties: {
    targets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "verdict", "direction", "mechanism", "rationale"],
        properties: {
          ref: { type: "string" },
          verdict: { type: "string", enum: [...STAGE2_VERDICTS] },
          direction: { anyOf: [{ type: "string", enum: ["positive", "negative", "unclear"] }, { type: "null" }] },
          mechanism: { anyOf: [{ type: "string" }, { type: "null" }] },
          rationale: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  },
};

/** One stage-1 target as shown to the model, keyed by a short ref. */
export type CandidateRef = {
  ref: string;
  target: string;
  /** Stage-1 direction; `unclear` is what stage-2 may resolve. */
  direction: Direction;
};

export type Stage2ValidationContext = {
  candidates: CandidateRef[];
  config: Pick<PropagationConfig, "fieldCaps">;
};

export type Stage2Item = {
  ref: string;
  target: string;
  verdict: Stage2Verdict;
  direction: Direction | null;
  mechanism: string | null;
  rationale: string | null;
};

export type Stage2ValidationResult =
  | { ok: true; items: Stage2Item[] }
  | { ok: false; errors: string[]; added_target: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out;
}

export function sanitizeText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  return stripControl(raw).replace(/\s+/g, " ").trim();
}

/** Resolve a ref (`c3`, `[c3]`, or the raw target id) against the candidate list. */
export function resolveRef(entry: string, ctx: Pick<Stage2ValidationContext, "candidates">): CandidateRef | null {
  const trimmed = entry.trim().replace(/^\[|\]$/g, "");
  const lower = trimmed.toLowerCase();
  for (const c of ctx.candidates) {
    if (c.ref === trimmed || c.ref === lower) return c;
  }
  for (const c of ctx.candidates) {
    if (c.target.toUpperCase() === trimmed.toUpperCase()) return c;
  }
  return null;
}

export function validateStage2Output(rawText: string, ctx: Stage2ValidationContext): Stage2ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (err) {
    return { ok: false, errors: [`parse: ${err instanceof Error ? err.message : String(err)}`], added_target: false };
  }
  return validateParsedStage2(parsed, ctx);
}

export function validateParsedStage2(parsed: unknown, ctx: Stage2ValidationContext): Stage2ValidationResult {
  const errors: string[] = [];
  let addedTarget = false;
  if (!isRecord(parsed) || !Array.isArray(parsed.targets)) {
    return { ok: false, errors: ["targets: must be an array"], added_target: false };
  }
  const caps = ctx.config.fieldCaps;
  const seen = new Set<string>();
  const items: Stage2Item[] = [];
  parsed.targets.forEach((raw, i) => {
    if (!isRecord(raw)) {
      errors.push(`targets[${i}]: must be an object`);
      return;
    }
    const refRaw = typeof raw.ref === "string" ? raw.ref : "";
    const candidate = refRaw ? resolveRef(refRaw, ctx) : null;
    if (!candidate) {
      // The subtract-only rule: a target not in the stage-1 list is rejected,
      // whatever the model called it.
      addedTarget = true;
      errors.push(`targets[${i}]: ref "${refRaw || "(missing)"}" is not a stage-1 candidate — targets cannot be added`);
      return;
    }
    if (seen.has(candidate.ref)) {
      errors.push(`targets[${i}]: ${candidate.ref} listed more than once`);
      return;
    }
    seen.add(candidate.ref);

    const verdict = raw.verdict;
    if (typeof verdict !== "string" || !(STAGE2_VERDICTS as readonly string[]).includes(verdict)) {
      errors.push(`${candidate.ref}: verdict must be one of ${STAGE2_VERDICTS.join("|")}`);
      return;
    }
    let direction: Direction | null = null;
    if (raw.direction !== null && raw.direction !== undefined) {
      if (typeof raw.direction !== "string" || !(DIRECTIONS as readonly string[]).includes(raw.direction) || raw.direction === "mixed") {
        errors.push(`${candidate.ref}: direction must be positive|negative|unclear or null`);
        return;
      }
      direction = raw.direction as Direction;
    }
    const mechanism = sanitizeText(raw.mechanism);
    if (mechanism !== null && mechanism.length > caps.mechanism) {
      errors.push(`${candidate.ref}: mechanism exceeds ${caps.mechanism} characters`);
      return;
    }
    const rationale = sanitizeText(raw.rationale);
    if (rationale !== null && rationale.length > caps.rationale) {
      errors.push(`${candidate.ref}: rationale exceeds ${caps.rationale} characters`);
      return;
    }
    if ((verdict === "vetoed" || verdict === "adjusted") && !rationale) {
      errors.push(`${candidate.ref}: rationale is required for ${verdict}`);
      return;
    }
    if (verdict === "adjusted" && direction === null) {
      errors.push(`${candidate.ref}: adjusted requires a direction`);
      return;
    }
    if (verdict === "confirmed" && direction !== null && candidate.direction !== "unclear" && direction !== candidate.direction) {
      errors.push(`${candidate.ref}: confirmed cannot change the direction — use adjusted with a rationale`);
      return;
    }
    items.push({
      ref: candidate.ref,
      target: candidate.target,
      verdict: verdict as Stage2Verdict,
      direction,
      mechanism: mechanism && mechanism.length > 0 ? mechanism : null,
      rationale: rationale && rationale.length > 0 ? rationale : null,
    });
  });
  if (errors.length) return { ok: false, errors, added_target: addedTarget };
  return { ok: true, items };
}

/**
 * Merge validated stage-2 items onto the stage-1 targets. Targets the model
 * did not mention stand as stage-1 produced them (`stage2: confirmed` with no
 * rationale is implied, recorded explicitly so the UI can tell). Pricing is
 * untouched — it is deterministic and was never shown to the model.
 */
export function mergeStage2(
  targets: PropagationTarget[],
  items: Stage2Item[],
  refs: CandidateRef[],
): { targets: PropagationTarget[]; unclear_resolved: number } {
  const byTarget = new Map(items.map((i) => [i.target, i]));
  const refByTarget = new Map(refs.map((r) => [r.target, r]));
  let unclearResolved = 0;
  const merged = targets.map((t) => {
    const key = `${t.target}|${t.relationship.role}`;
    const item = byTarget.get(key);
    if (!item) {
      const implied: Stage2TargetResult = { verdict: "confirmed", rationale: null, direction: null };
      return refByTarget.has(key) ? { ...t, stage2: implied } : t;
    }
    let direction = t.transmission.direction;
    if (item.direction && (item.verdict === "adjusted" || t.transmission.direction === "unclear")) {
      if (t.transmission.direction === "unclear" && item.direction !== "unclear") unclearResolved += 1;
      direction = item.direction;
    }
    return {
      ...t,
      transmission: { ...t.transmission, direction },
      mechanism: item.mechanism ?? t.mechanism,
      stage2: { verdict: item.verdict, rationale: item.rationale, direction: item.direction },
    };
  });
  return { targets: merged, unclear_resolved: unclearResolved };
}

/** Short refs for the stage-1 targets, in run order: c1, c2, … keyed by target|role. */
export function candidateRefs(targets: PropagationTarget[]): CandidateRef[] {
  return targets.map((t, i) => ({
    ref: `c${i + 1}`,
    target: `${t.target}|${t.relationship.role}`,
    direction: t.transmission.direction,
  }));
}
