/**
 * The house copy rules as a prompt block, for research-side prompts whose
 * output a reader sees.
 *
 * The rules themselves live in the desktop app
 * (apps/desktop/src/shared/copy-rules.ts) and research cannot import from an
 * app, so the block is built here from the word lists news/headline-rules.ts
 * already mirrors. A desktop test holds the two blocks equal
 * (apps/desktop/src/main/news/news-headline-rules-parity.test.ts), so a word
 * added on one side and not the other fails the build.
 *
 * A prompt only asks; the model can still forget. Every path that shows what
 * a model wrote also runs `plainDashes` on it, so the dash rule holds either
 * way.
 */

import { ADVICE_WORDS, RISK_SENTENCE_WORDS, plainDashes } from "./news/headline-rules.js";

export { ADVICE_WORDS, RISK_SENTENCE_WORDS, plainDashes };

/** Mirrors copy-rules.ts BRAND_WORDS. */
export const BRAND_WORDS: readonly string[] = ["edge", "AI"];

/** Words that make a line read as machine-written. Prompt-only: no source check runs on them. */
export const PROMPT_STYLE_WORDS: readonly string[] = ["insight", "smart", "seamless", "leverage", "robust", "unlock", "delve"];

/** Mirrors copy-rules.ts `buildPromptCopyRule` line for line. */
export function buildPromptCopyRule(
  advice: readonly string[],
  forward: readonly string[],
  brand: readonly string[],
  style: readonly string[],
): string {
  const plainBanned = [...brand.filter((w) => w !== "AI"), ...style];
  return [
    "WRITING RULES (they hold for every word the reader sees):",
    "- Describe what happened and what the record shows. Never say what a price will do next, never give a price level or a forecast, and never tell the reader what to do.",
    `- Never use these words, in any sense or form: ${advice.join(", ")}.`,
    `- Never use these forward-looking words, in any sense or form: ${forward.join(", ")}.`,
    `- Never use these words: ${plainBanned.join(", ")}. Write "AI" only where it names a line of business a company reports, such as AI chips or AI revenue.`,
    "- Never mention AI models, assistants or yourself. Never open with \"Here's\" or \"Let me\".",
    "- No em dash and no en dash: use commas, colons, or \"to\" for ranges. No exclamation marks. No emoji.",
  ].join("\n");
}

/** Append to the system prompt of any call whose output a reader sees. */
export const PROMPT_COPY_RULE = buildPromptCopyRule(ADVICE_WORDS, RISK_SENTENCE_WORDS, BRAND_WORDS, PROMPT_STYLE_WORDS);
