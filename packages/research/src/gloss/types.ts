/**
 * Gloss: what a selected word or passage means, in the sense a market reader
 * needs. The whole point of the module is that "loophole closure" or
 * "guidance" get their finance reading, not their dictionary reading.
 */

export type GlossKind = "term" | "passage";

export type GlossRequest = {
  /** Exactly what the reader highlighted. */
  selection: string;
  /** The sentence it was highlighted in — the model needs it to disambiguate. */
  context?: string;
  /** The ticker the sentence is about, when there is one. */
  ticker?: string;
};

export type GlossResult = {
  kind: GlossKind;
  /** The selection, normalised — the heading of the card. */
  term: string;
  /** For a term: its financial meaning. For a passage: what it is saying. */
  english: string;
  /**
   * What it means *here* — one line tying the term to this sentence. Empty
   * when the selection is a passage (the summary already is that).
   */
  in_context: string;
  /** True when the word also has a common non-financial sense worth flagging. */
  finance_specific: boolean;
};

export type GlossModelInput = {
  model: string;
  max_tokens: number;
  effort?: "low" | "medium" | "high";
  system: string;
  user: string;
  output_schema: Record<string, unknown>;
  timeout_ms: number;
  signal?: AbortSignal;
};

export type GlossModelOutput = {
  text: string;
  input_tokens: number;
  output_tokens: number;
};

/** The seam tests inject a fixture through. */
export type GlossModelCaller = (input: GlossModelInput) => Promise<GlossModelOutput>;

export type GlossTranslation = { turkish: string };

export type GlossConfig = {
  model: string;
  /** Omitted for models that reject it (Haiku). */
  effort?: "low" | "medium" | "high";
  maxTokens: number;
  timeoutMs: number;
  /** Longest selection accepted; anything more is refused, not truncated. */
  maxSelectionChars: number;
};

export const DEFAULT_GLOSS_CONFIG: GlossConfig = {
  // Latency is the product here — the card is waiting on a spinner. Measured
  // on this prompt: Opus 5 at low effort answers in ~6s and is markedly better
  // than the ~4s a smaller model gives, so the wait buys something. The word
  // limits in the prompt do the rest of the work. maxTokens has to cover the
  // model's reasoning as well as the JSON, so it sits well above the answer's
  // real size — the prompt, not this ceiling, is what keeps replies short.
  model: "claude-opus-5",
  effort: "low",
  maxTokens: 2000,
  timeoutMs: 20_000,
  maxSelectionChars: 400,
};
