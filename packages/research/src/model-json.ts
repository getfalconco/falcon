/**
 * Getting JSON out of a model that will not promise it.
 *
 * The engines ask for structured output with Anthropic's `output_config`
 * (`format: { type: "json_schema" }`), which makes the reply JSON by
 * construction. Behind a gateway that does not implement that field the request
 * still returns 200 — the field is simply ignored — and the model answers in
 * prose. Every caller then fails at `JSON.parse` with "malformed JSON", which
 * describes the symptom and hides the cause.
 *
 * These two helpers make the JSON path survive that:
 *
 *   `withJsonInstruction` states the contract in the prompt as well, so a model
 *   that never saw the schema still knows what to return. It is additive — with
 *   a working `output_config` the instruction is redundant, not harmful.
 *
 *   `jsonFromModelText` pulls the object back out of whatever came around it:
 *   a preamble, a markdown fence, or a leaked reasoning block.
 *
 * Neither invents data. If there is no JSON in the reply, the original text is
 * returned unchanged and the caller's parse fails as it did before — a broken
 * answer must stay broken rather than become a quiet default.
 */

/** Reasoning the real API returns as its own block type; a gateway may inline it. */
const THINKING = /<\/?antml[^>]*>|<\/?thinking>|<\/?antml:thinking>/gi;

/**
 * Everything from the first `{` or `[` whose brackets balance, ignoring braces
 * inside strings. A plain `indexOf`/`lastIndexOf` pair would swallow trailing
 * prose that happens to contain a brace, and stop early on nested objects.
 */
function balancedSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The JSON inside a model reply. Returns the input untouched when there is
 * none, so the caller's own error still fires.
 */
export function jsonFromModelText(text: string): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // Already clean — the overwhelmingly common case, and the one that must stay
  // free of any rewriting.
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    /* keep going */
  }

  let body = trimmed.replace(THINKING, " ");

  // ```json … ``` — take the fence's contents, not the fence.
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      body = inner;
    }
  }

  const span = balancedSpan(body);
  if (span) {
    try {
      JSON.parse(span);
      return span;
    } catch {
      /* not valid after all — fall through and hand back the original */
    }
  }
  return trimmed;
}

/**
 * Restates the required shape in the system prompt, for models that never
 * received the schema. Appended rather than prepended so the caller's own
 * instructions still lead.
 */
export function withJsonInstruction(system: string, schema: unknown): string {
  const shape = JSON.stringify(schema);
  return [
    system,
    "",
    "OUTPUT FORMAT: reply with a single JSON object and nothing else — no prose",
    "before or after it, no markdown fence, no explanation. It must validate",
    "against this JSON Schema:",
    shape,
  ].join("\n");
}
