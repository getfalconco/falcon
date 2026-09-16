import {
  buildGlossUser,
  buildTranslateUser,
  glossKind,
  GLOSS_SCHEMA,
  GLOSS_SYSTEM,
  TRANSLATE_SCHEMA,
  TRANSLATE_SYSTEM,
} from "./prompt.js";
import {
  DEFAULT_GLOSS_CONFIG,
  type GlossConfig,
  type GlossModelCaller,
  type GlossRequest,
  type GlossResult,
  type GlossTranslation,
} from "./types.js";

/**
 * One model call per selection, shaped by a JSON schema so the card never has
 * to parse prose. Turkish is a second, separate call made only when the reader
 * asks for it — carrying both languages in the first answer doubled the output
 * tokens, and output tokens are the spinner.
 */

export class GlossError extends Error {}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseObject(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GlossError("model returned malformed JSON");
  }
  if (!raw || typeof raw !== "object") throw new GlossError("model returned a non-object");
  return raw as Record<string, unknown>;
}

/**
 * The text being explained comes from news headlines, so it can carry an
 * instruction. The prompt refuses those, and this refuses the shapes that
 * would matter if it ever didn't: a link to follow, or advice to act on. The
 * system prompt already forbids both, which makes the check cheap and
 * deterministic rather than a second judgement call.
 */
const FORBIDDEN = [
  /https?:\/\//i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i,
  // A bare domain is still somewhere to be sent.
  /\b[a-z0-9-]+\.(?:com|net|org|io|co|app|xyz|info|link)\b/i,
  /\b(?:price target|pt)\s*\$?\s*\d/i,
  /\bhedef fiyat\b/i,
  // Case-insensitive: a sentence-initial "Buy NVDA now" is the same advice as
  // a mid-sentence one, and the ticker branch has to match either casing.
  /\b(?:buy|sell|short|long)\s+(?:now|today|before|the\s+\w+|[a-z]{1,5}\b)/i,
  // The Turkish answer is screened by this same list, so it needs Turkish.
  /\b(?:al|sat|satın al|yatırım yap)\b[^.!?]{0,20}\b(?:şimdi|bugün|hemen)\b/i,
  /\b(?:hemen|şimdi|bugün)\b[^.!?]{0,20}\b(?:al|sat|satın al)\b/i,
];

export function looksLikeAdviceOrLink(text: string): boolean {
  return FORBIDDEN.some((pattern) => pattern.test(text));
}

/** The model returns valid JSON by construction; this guards the edges. */
export function parseGloss(text: string, fallbackTerm: string): GlossResult {
  const value = parseObject(text);
  const english = clean(value.english);
  if (!english) throw new GlossError("model returned no explanation");
  if (looksLikeAdviceOrLink(english)) {
    throw new GlossError("that selection can't be explained safely");
  }

  const inContext = clean(value.in_context);
  // The heading is the most authoritative line in the card, and it was the one
  // field reaching the reader unscreened. A poisoned one degrades to the
  // reader's own selection rather than killing an otherwise good answer.
  const term = clean(value.term);
  return {
    kind: value.kind === "passage" ? "passage" : "term",
    term: term && !looksLikeAdviceOrLink(term) ? term : fallbackTerm,
    english,
    in_context: looksLikeAdviceOrLink(inContext) ? "" : inContext,
    finance_specific: value.finance_specific === true,
  };
}

function assertSelection(selection: string, config: GlossConfig): string {
  const trimmed = selection.trim();
  if (trimmed.length < 2) throw new GlossError("selection is too short to explain");
  if (trimmed.length > config.maxSelectionChars) {
    // Refused rather than truncated: half a sentence explained confidently is
    // worse than saying no.
    throw new GlossError("selection is too long — highlight a sentence or less");
  }
  return trimmed;
}

export async function glossSelection(
  request: GlossRequest,
  caller: GlossModelCaller,
  config: GlossConfig = DEFAULT_GLOSS_CONFIG,
  signal?: AbortSignal,
): Promise<GlossResult> {
  const selection = assertSelection(request.selection, config);

  const output = await caller({
    model: config.model,
    max_tokens: config.maxTokens,
    effort: config.effort,
    system: GLOSS_SYSTEM,
    user: buildGlossUser({ ...request, selection }),
    output_schema: GLOSS_SCHEMA as unknown as Record<string, unknown>,
    timeout_ms: config.timeoutMs,
    signal,
  });

  const result = parseGloss(output.text, selection);
  // The caller's own read of term-vs-passage wins over the model's: it is
  // deterministic, and the card's layout depends on it. A passage's summary is
  // already the context line, so it never carries a second one.
  const kind = glossKind(selection);
  return { ...result, kind, in_context: kind === "passage" ? "" : result.in_context };
}

export async function translateGloss(
  term: string,
  english: string,
  caller: GlossModelCaller,
  config: GlossConfig = DEFAULT_GLOSS_CONFIG,
  signal?: AbortSignal,
): Promise<GlossTranslation> {
  const source = english.trim();
  if (!source) throw new GlossError("nothing to translate");

  const output = await caller({
    model: config.model,
    max_tokens: config.maxTokens,
    effort: config.effort,
    system: TRANSLATE_SYSTEM,
    user: buildTranslateUser(term.trim(), source),
    output_schema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
    timeout_ms: config.timeoutMs,
    signal,
  });

  const turkish = clean(parseObject(output.text).turkish);
  if (!turkish) throw new GlossError("model returned no translation");
  if (looksLikeAdviceOrLink(turkish)) {
    throw new GlossError("that selection can't be explained safely");
  }
  return { turkish };
}
