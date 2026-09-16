/**
 * §4 verdict schema + §7 validation pipeline.
 *
 * parse → schema check → enum check → conditional-field check. Pure functions;
 * the service retries on failure and, on persistent failure, emits a
 * `status: "failed"` fallback verdict — it never fabricates labels.
 */

import {
  CLASSIFIER_SCHEMA_VERSION,
  DIRECTIONS,
  EVENT_TYPES,
  MATERIALITIES,
  RELEVANCES,
  type ClassificationRequest,
  type Direction,
  type Materiality,
  type ModelOutput,
  type TickerVerdict,
  type Verdict,
} from "./types.js";

export const EVENT_LABEL_MAX_LENGTH = 80;

/** C0 + DEL + C1 control characters, built without escape literals so the source stays ASCII-clean. */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  "g",
);

/**
 * §4: `event_label` ≤ 80 chars, control characters stripped, whitespace
 * collapsed. Display/context only — never parsed for logic.
 */
export function sanitizeEventLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const stripped = raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > EVENT_LABEL_MAX_LENGTH
    ? stripped.slice(0, EVENT_LABEL_MAX_LENGTH).trimEnd()
    : stripped;
}

/**
 * The JSON schema the model's output must satisfy — passed as the structured
 * output format on every call, and the same shape the validator enforces.
 * The conditional rule (relevance none → no materiality/direction) is
 * expressed as a oneOf so the model cannot emit the forbidden combination.
 */
export const MODEL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["event_type", "event_label", "tickers"],
  properties: {
    event_type: { type: "string", enum: [...EVENT_TYPES] },
    event_label: { type: "string" },
    tickers: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["ticker", "relevance"],
            properties: {
              ticker: { type: "string" },
              relevance: { type: "string", enum: ["none"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["ticker", "relevance", "materiality", "direction"],
            properties: {
              ticker: { type: "string" },
              relevance: { type: "string", enum: ["direct", "indirect"] },
              materiality: { type: "string", enum: [...MATERIALITIES] },
              direction: { type: "string", enum: [...DIRECTIONS] },
            },
          },
        ],
      },
    },
  },
};

export type ValidationResult =
  | { ok: true; output: ModelOutput }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Models occasionally wrap JSON in a code fence despite instructions; tolerate that. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1];
  // Fall back to the outermost object if there is leading/trailing prose.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start && (start > 0 || end < trimmed.length - 1)) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/**
 * Validate a raw model response against the request it answers. Every ticker
 * in the request must be assessed exactly once; tickers the model invents are
 * rejected (the model must not label what it was not asked about).
 */
export function validateModelOutput(
  rawText: string,
  request: Pick<ClassificationRequest, "tickers">,
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (err) {
    return { ok: false, errors: [`parse: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return validateParsedOutput(parsed, request);
}

export function validateParsedOutput(
  parsed: unknown,
  request: Pick<ClassificationRequest, "tickers">,
): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(parsed)) return { ok: false, errors: ["schema: top level must be an object"] };

  // --- schema: required keys, no extras -----------------------------------
  for (const key of ["event_type", "event_label", "tickers"]) {
    if (!(key in parsed)) errors.push(`schema: missing "${key}"`);
  }
  for (const key of Object.keys(parsed)) {
    if (!["event_type", "event_label", "tickers"].includes(key)) {
      errors.push(`schema: unexpected key "${key}"`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // --- enums ---------------------------------------------------------------
  const eventType = parsed.event_type;
  if (typeof eventType !== "string" || !(EVENT_TYPES as readonly string[]).includes(eventType)) {
    errors.push(`enum: event_type "${String(eventType)}" not in taxonomy`);
  }
  if (typeof parsed.event_label !== "string") {
    errors.push("schema: event_label must be a string");
  }
  if (!Array.isArray(parsed.tickers)) {
    errors.push("schema: tickers must be an array");
    return { ok: false, errors };
  }

  // --- per-ticker entries ----------------------------------------------------
  const expected = new Set(request.tickers.map((t) => t.ticker.toUpperCase()));
  const seen = new Set<string>();
  const entries: TickerVerdict[] = [];
  for (const [i, item] of parsed.tickers.entries()) {
    if (!isRecord(item)) {
      errors.push(`schema: tickers[${i}] must be an object`);
      continue;
    }
    const ticker = typeof item.ticker === "string" ? item.ticker.trim().toUpperCase() : "";
    if (!ticker) {
      errors.push(`schema: tickers[${i}].ticker missing`);
      continue;
    }
    if (!expected.has(ticker)) {
      errors.push(`schema: tickers[${i}] "${ticker}" was not in the request`);
      continue;
    }
    if (seen.has(ticker)) {
      errors.push(`schema: tickers[${i}] "${ticker}" assessed twice`);
      continue;
    }
    seen.add(ticker);

    const relevance = item.relevance;
    if (typeof relevance !== "string" || !(RELEVANCES as readonly string[]).includes(relevance)) {
      errors.push(`enum: tickers[${i}].relevance "${String(relevance)}" invalid`);
      continue;
    }
    const extra = Object.keys(item).filter(
      (k) => !["ticker", "relevance", "materiality", "direction"].includes(k),
    );
    if (extra.length) errors.push(`schema: tickers[${i}] unexpected keys ${extra.join(",")}`);

    if (relevance === "none") {
      // Conditional: relevance none → materiality and direction omitted.
      if ("materiality" in item || "direction" in item) {
        errors.push(
          `conditional: tickers[${i}] "${ticker}" relevance none must omit materiality/direction`,
        );
        continue;
      }
      entries.push({ ticker, relevance: "none" });
      continue;
    }

    const materiality = item.materiality;
    const direction = item.direction;
    if (
      typeof materiality !== "string" ||
      !(MATERIALITIES as readonly string[]).includes(materiality)
    ) {
      errors.push(`enum: tickers[${i}].materiality "${String(materiality)}" invalid`);
    }
    if (typeof direction !== "string" || !(DIRECTIONS as readonly string[]).includes(direction)) {
      errors.push(`enum: tickers[${i}].direction "${String(direction)}" invalid`);
    }
    if (errors.length) continue;
    entries.push({
      ticker,
      relevance: relevance as "direct" | "indirect",
      materiality: materiality as Materiality,
      direction: direction as Direction,
    });
  }
  for (const ticker of expected) {
    if (!seen.has(ticker)) errors.push(`schema: ticker "${ticker}" not assessed`);
  }
  if (errors.length) return { ok: false, errors };

  // Emit entries in request order so verdicts are byte-stable.
  const order = request.tickers.map((t) => t.ticker.toUpperCase());
  entries.sort((a, b) => order.indexOf(a.ticker) - order.indexOf(b.ticker));

  return {
    ok: true,
    output: {
      event_type: eventType as ModelOutput["event_type"],
      event_label: sanitizeEventLabel(parsed.event_label),
      tickers: entries,
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict assembly (pure)
// ---------------------------------------------------------------------------

export type VerdictEnvelope = {
  prompt_version: string;
  model: string;
  classified_at: string;
};

/** Assemble a full verdict from a validated model output and its request. */
export function assembleVerdict(
  request: ClassificationRequest,
  output: ModelOutput,
  envelope: VerdictEnvelope,
): Verdict {
  return {
    schema_version: CLASSIFIER_SCHEMA_VERSION,
    prompt_version: envelope.prompt_version,
    model: envelope.model,
    article_key: articleKeyOf(request),
    kind: request.kind,
    event_type: output.event_type,
    event_label: output.event_label,
    syndication_scope: request.syndication_scope,
    tickers: output.tickers,
    unassessed_tickers: [...request.unassessed_tickers],
    status: "ok",
    metadata_missing: request.tickers.some((t) => t.metadata_missing),
    classified_at: envelope.classified_at,
    failure_reason: null,
  };
}

/**
 * §9: the fallback verdict when validation or transport fails persistently.
 * Every requested ticker is reported unassessed so Base keeps the base
 * severity contribution for the message — no label is invented.
 */
export function failedVerdict(
  request: ClassificationRequest,
  reason: string,
  envelope: VerdictEnvelope,
): Verdict {
  return {
    schema_version: CLASSIFIER_SCHEMA_VERSION,
    prompt_version: envelope.prompt_version,
    model: envelope.model,
    article_key: articleKeyOf(request),
    kind: request.kind,
    event_type: "other",
    event_label: "",
    syndication_scope: request.syndication_scope,
    tickers: [],
    unassessed_tickers: [
      ...request.tickers.map((t) => t.ticker.toUpperCase()),
      ...request.unassessed_tickers,
    ],
    status: "failed",
    metadata_missing: request.tickers.some((t) => t.metadata_missing),
    classified_at: envelope.classified_at,
    failure_reason: reason,
  };
}

export function articleKeyOf(request: Pick<ClassificationRequest, "article" | "filing">): string {
  const key = request.article?.article_key ?? request.filing?.article_key;
  if (!key) throw new Error("classification request carries neither article nor filing");
  return key;
}

/**
 * Validate a persisted verdict on load — a corrupt store row must not reach
 * the scorer. Returns null when the row is not a usable verdict.
 */
export function coerceStoredVerdict(raw: unknown): Verdict | null {
  if (!isRecord(raw)) return null;
  if (raw.schema_version !== CLASSIFIER_SCHEMA_VERSION) return null;
  if (typeof raw.article_key !== "string" || typeof raw.prompt_version !== "string") return null;
  if (typeof raw.model !== "string" || typeof raw.classified_at !== "string") return null;
  if (raw.status !== "ok" && raw.status !== "failed") return null;
  if (!Array.isArray(raw.tickers) || !Array.isArray(raw.unassessed_tickers)) return null;
  if (typeof raw.event_type !== "string" || !(EVENT_TYPES as readonly string[]).includes(raw.event_type)) {
    return null;
  }
  const tickers: TickerVerdict[] = [];
  for (const item of raw.tickers) {
    if (!isRecord(item) || typeof item.ticker !== "string") return null;
    if (item.relevance === "none") {
      tickers.push({ ticker: item.ticker, relevance: "none" });
      continue;
    }
    if (
      (item.relevance !== "direct" && item.relevance !== "indirect") ||
      typeof item.materiality !== "string" ||
      !(MATERIALITIES as readonly string[]).includes(item.materiality) ||
      typeof item.direction !== "string" ||
      !(DIRECTIONS as readonly string[]).includes(item.direction)
    ) {
      return null;
    }
    tickers.push({
      ticker: item.ticker,
      relevance: item.relevance,
      materiality: item.materiality as Materiality,
      direction: item.direction as Direction,
    });
  }
  return {
    schema_version: CLASSIFIER_SCHEMA_VERSION,
    prompt_version: raw.prompt_version,
    model: raw.model,
    article_key: raw.article_key,
    kind: raw.kind === "filing" ? "filing" : "news",
    event_type: raw.event_type as Verdict["event_type"],
    event_label: sanitizeEventLabel(raw.event_label),
    syndication_scope: typeof raw.syndication_scope === "number" ? raw.syndication_scope : 1,
    tickers,
    unassessed_tickers: raw.unassessed_tickers.filter((t): t is string => typeof t === "string"),
    status: raw.status,
    metadata_missing: raw.metadata_missing === true,
    classified_at: raw.classified_at,
    failure_reason: typeof raw.failure_reason === "string" ? raw.failure_reason : null,
  };
}
