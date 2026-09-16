/**
 * §5 output schema, validators and assembly.
 *
 * Deterministic validation before acceptance: enum membership, length caps,
 * the conditional field rules, evidence grounding (every id must exist in the
 * incident), the generic-trigger rejection list and the edge-deviation
 * rationale rule. A grounding failure is reported separately so the service
 * can retry with the error appended and, when it persists, downgrade to
 * `cause: unidentified` with `grounding_failed` — never accept silently.
 */

import { extractJson } from "../classifier/schema.js";
import type { AnalystConfig } from "./config.js";
import {
  ANALYST_SCHEMA_VERSION,
  CAUSES,
  EDGE_STATUSES,
  type AnalystOutput,
  type AnalystRequest,
  type Cause,
  type EdgeStatus,
  type ModelOutput,
  type ReactionState,
} from "./types.js";

export const MODEL_OUTPUT_KEYS = [
  "cause",
  "cause_summary",
  "mechanism",
  "evidence",
  "edge_status",
  "edge_rationale",
  "watch_trigger",
] as const;

export const MODEL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [...MODEL_OUTPUT_KEYS],
  properties: {
    cause: { type: "string", enum: [...CAUSES] },
    cause_summary: { type: "string" },
    mechanism: { anyOf: [{ type: "string" }, { type: "null" }] },
    evidence: { type: "array", items: { type: "string" } },
    edge_status: { type: "string", enum: [...EDGE_STATUSES] },
    edge_rationale: { anyOf: [{ type: "string" }, { type: "null" }] },
    watch_trigger: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};

export type ValidationContext = {
  /** Short refs shown in the prompt → message ids. */
  refs: Record<string, string>;
  /** Every message id in the incident. */
  evidence_ids: string[];
  reaction_state: ReactionState;
  config: AnalystConfig;
};

export type ValidationResult =
  | { ok: true; output: ModelOutput; edge_deviation: boolean }
  | {
      ok: false;
      errors: string[];
      /** Every error is a grounding error — the rest of the output is valid. */
      grounding_only: boolean;
      /** §5 downgrade candidate when grounding_only: cause unidentified, unresolved evidence dropped. */
      downgraded: ModelOutput | null;
      edge_deviation: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop C0 control characters and DEL (anything below space, plus 127). */
function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out;
}

/** Strip control characters and collapse whitespace; null stays null. */
export function sanitizeText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const cleaned = stripControl(raw).replace(/\s+/g, " ").trim();
  return cleaned;
}

/** §4: a decisive edge_default that the output does not follow. */
export function isEdgeDeviation(edgeStatus: EdgeStatus, reaction: Pick<ReactionState, "edge_default">): boolean {
  if (reaction.edge_default === "undetermined") return false;
  return edgeStatus !== reaction.edge_default;
}

/** §5: generic, unfalsifiable trigger phrases (case-insensitive substring). */
export function isGenericTrigger(trigger: string, config: Pick<AnalystConfig, "genericTriggerPhrases">): string | null {
  const lower = trigger.toLowerCase();
  for (const phrase of config.genericTriggerPhrases) {
    if (phrase && lower.includes(phrase.toLowerCase())) return phrase;
  }
  return null;
}

/** Resolve one evidence entry: a prompt ref (`m3`) or a raw message id. */
export function resolveEvidence(entry: string, ctx: Pick<ValidationContext, "refs" | "evidence_ids">): string | null {
  const trimmed = entry.trim().replace(/^\[|\]$/g, "");
  if (ctx.refs[trimmed]) return ctx.refs[trimmed];
  const lower = trimmed.toLowerCase();
  if (ctx.refs[lower]) return ctx.refs[lower];
  if (ctx.evidence_ids.includes(trimmed)) return trimmed;
  return null;
}

export function validateModelOutput(rawText: string, ctx: ValidationContext): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (err) {
    return {
      ok: false,
      errors: [`parse: ${err instanceof Error ? err.message : String(err)}`],
      grounding_only: false,
      downgraded: null,
      edge_deviation: false,
    };
  }
  return validateParsedOutput(parsed, ctx);
}

export function validateParsedOutput(parsed: unknown, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const grounding: string[] = [];
  const caps = ctx.config.fieldCaps;
  const fail = (): ValidationResult => ({
    ok: false,
    errors: [...errors, ...grounding],
    grounding_only: false,
    downgraded: null,
    edge_deviation: false,
  });

  if (!isRecord(parsed)) {
    errors.push("schema: top level must be an object");
    return fail();
  }

  // --- schema: required keys, no extras -----------------------------------
  for (const key of MODEL_OUTPUT_KEYS) {
    if (!(key in parsed)) errors.push(`schema: missing "${key}"`);
  }
  for (const key of Object.keys(parsed)) {
    if (!(MODEL_OUTPUT_KEYS as readonly string[]).includes(key)) errors.push(`schema: unexpected key "${key}"`);
  }
  if (errors.length) return fail();

  // --- enums ---------------------------------------------------------------
  const cause = parsed.cause;
  if (typeof cause !== "string" || !(CAUSES as readonly string[]).includes(cause)) {
    errors.push(`enum: cause "${String(cause)}" invalid`);
  }
  const edgeStatus = parsed.edge_status;
  if (typeof edgeStatus !== "string" || !(EDGE_STATUSES as readonly string[]).includes(edgeStatus)) {
    errors.push(`enum: edge_status "${String(edgeStatus)}" invalid`);
  }
  if (errors.length) return fail();

  // --- text fields + caps ----------------------------------------------------
  const causeSummary = sanitizeText(parsed.cause_summary);
  if (causeSummary === null || causeSummary.length === 0) errors.push("schema: cause_summary must be a non-empty string");
  else if (causeSummary.length > caps.cause_summary) {
    errors.push(`length: cause_summary is ${causeSummary.length} chars, cap ${caps.cause_summary}`);
  }
  const textOrNull = (key: "mechanism" | "edge_rationale" | "watch_trigger"): string | null => {
    const v = parsed[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") {
      errors.push(`schema: ${key} must be a string or null`);
      return null;
    }
    const s = sanitizeText(v) ?? "";
    if (s.length === 0) return null;
    if (s.length > caps[key]) errors.push(`length: ${key} is ${s.length} chars, cap ${caps[key]}`);
    return s;
  };
  const mechanism = textOrNull("mechanism");
  const edgeRationale = textOrNull("edge_rationale");
  const watchTrigger = textOrNull("watch_trigger");

  // --- evidence: grounding ---------------------------------------------------
  const rawEvidence = parsed.evidence;
  const resolved: string[] = [];
  const unresolved: string[] = [];
  if (!Array.isArray(rawEvidence)) {
    errors.push("schema: evidence must be an array");
  } else {
    for (const [i, item] of rawEvidence.entries()) {
      if (typeof item !== "string") {
        errors.push(`schema: evidence[${i}] must be a string`);
        continue;
      }
      const id = resolveEvidence(item, ctx);
      if (id === null) unresolved.push(item);
      else if (!resolved.includes(id)) resolved.push(id);
    }
    if (rawEvidence.length > caps.evidence) errors.push(`length: evidence has ${rawEvidence.length} entries, cap ${caps.evidence}`);
  }
  if (unresolved.length) {
    grounding.push(`grounding: evidence refs not in the incident: ${unresolved.map((u) => `"${u}"`).join(", ")}`);
  }
  const causeTyped = cause as Cause;
  if ((causeTyped === "identified" || causeTyped === "partially_identified") && resolved.length === 0) {
    grounding.push(`grounding: cause "${causeTyped}" requires non-empty evidence that exists in the incident`);
  }

  // --- conditional field rules -------------------------------------------------
  if (causeTyped === "identified" && mechanism === null) {
    errors.push('conditional: mechanism is required when cause is "identified"');
  }
  const edgeTyped = edgeStatus as EdgeStatus;
  if (edgeTyped !== "no_edge" && watchTrigger === null) {
    errors.push(`conditional: watch_trigger is required when edge_status is "${edgeTyped}"`);
  }
  if (edgeTyped === "potential_edge" && edgeRationale === null) {
    errors.push('conditional: edge_rationale is required for edge_status "potential_edge"');
  }
  const deviation = isEdgeDeviation(edgeTyped, ctx.reaction_state);
  if (deviation && edgeRationale === null) {
    errors.push(
      `conditional: edge_rationale is required because edge_status "${edgeTyped}" deviates from edge_default "${ctx.reaction_state.edge_default}"`,
    );
  }
  if (watchTrigger !== null) {
    const generic = isGenericTrigger(watchTrigger, ctx.config);
    if (generic) errors.push(`trigger: watch_trigger "${watchTrigger}" is unfalsifiable (contains "${generic}"); name a date, filing or event and a horizon`);
  }

  if (errors.length) return fail();

  const output: ModelOutput = {
    cause: causeTyped,
    cause_summary: causeSummary ?? "",
    mechanism,
    evidence: resolved,
    edge_status: edgeTyped,
    edge_rationale: edgeRationale,
    watch_trigger: watchTrigger,
  };

  if (grounding.length) {
    return {
      ok: false,
      errors: grounding,
      grounding_only: true,
      downgraded: downgradeForGrounding(output),
      edge_deviation: deviation,
    };
  }
  return { ok: true, output, edge_deviation: deviation };
}

/** §5: the grounding downgrade — cause unidentified, only resolved evidence kept, mechanism dropped. */
export function downgradeForGrounding(output: ModelOutput): ModelOutput {
  return {
    ...output,
    cause: "unidentified",
    mechanism: null,
    evidence: [...output.evidence],
  };
}

// ---------------------------------------------------------------------------
// Output assembly (pure)
// ---------------------------------------------------------------------------

export type OutputEnvelope = {
  prompt_version: string;
  model: string;
  produced_at: string;
  attempts: number;
  latency_ms: number;
  retry_errors: string[];
};

export function assembleOutput(
  request: AnalystRequest,
  output: ModelOutput,
  reaction: ReactionState,
  envelope: OutputEnvelope,
  flags: { grounding_failed: boolean; edge_deviation: boolean },
): AnalystOutput {
  return {
    schema_version: ANALYST_SCHEMA_VERSION,
    prompt_version: envelope.prompt_version,
    model: envelope.model,
    incident_id: request.incident_id,
    request_id: request.request_id,
    kind: request.kind,
    ticker: request.incident.ticker,
    ...output,
    status: "ok",
    reaction_state: reaction,
    edge_deviation: flags.edge_deviation,
    grounding_failed: flags.grounding_failed,
    failure_reason: null,
    produced_at: envelope.produced_at,
    superseded_by: null,
    update: request.update,
    prior_request_id: request.prior_request_id,
    attempts: envelope.attempts,
    latency_ms: envelope.latency_ms,
    retry_errors: [...envelope.retry_errors],
  };
}

/** §8: the fallback when validation or transport fails persistently. Nothing is fabricated. */
export function failedOutput(
  request: AnalystRequest,
  reason: string,
  reaction: ReactionState,
  envelope: OutputEnvelope,
): AnalystOutput {
  return {
    schema_version: ANALYST_SCHEMA_VERSION,
    prompt_version: envelope.prompt_version,
    model: envelope.model,
    incident_id: request.incident_id,
    request_id: request.request_id,
    kind: request.kind,
    ticker: request.incident.ticker,
    cause: "unidentified",
    cause_summary: "",
    mechanism: null,
    evidence: [],
    edge_status: "watch",
    edge_rationale: null,
    watch_trigger: null,
    status: "failed",
    reaction_state: reaction,
    edge_deviation: false,
    grounding_failed: false,
    failure_reason: reason,
    produced_at: envelope.produced_at,
    superseded_by: null,
    update: request.update,
    prior_request_id: request.prior_request_id,
    attempts: envelope.attempts,
    latency_ms: envelope.latency_ms,
    retry_errors: [...envelope.retry_errors],
  };
}

/**
 * Validate a persisted output on load — a corrupt store row must not reach
 * the panel. Returns null when the row is not a usable output.
 */
export function coerceStoredOutput(raw: unknown): AnalystOutput | null {
  if (!isRecord(raw)) return null;
  if (raw.schema_version !== ANALYST_SCHEMA_VERSION) return null;
  for (const key of ["incident_id", "request_id", "prompt_version", "model", "produced_at", "ticker"]) {
    if (typeof raw[key] !== "string") return null;
  }
  if (raw.status !== "ok" && raw.status !== "failed") return null;
  if (typeof raw.cause !== "string" || !(CAUSES as readonly string[]).includes(raw.cause)) return null;
  if (typeof raw.edge_status !== "string" || !(EDGE_STATUSES as readonly string[]).includes(raw.edge_status)) return null;
  if (!isRecord(raw.reaction_state)) return null;
  const out = raw as unknown as AnalystOutput;
  if (!Array.isArray(out.retry_errors)) out.retry_errors = [];
  return out;
}
