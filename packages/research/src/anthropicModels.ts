/**
 * Which Claude model each kind of work runs on by default, and which request
 * parameters a model accepts.
 *
 * Two tiers, one id each, so a model move is a one-line change:
 *
 *   - Writing: the prose a reader sees (Insight write-ups and chat, the
 *     briefing narrative, agent drafts, updates and replies). Every caller of
 *     it sets `output_config.effort` explicitly, so the model's own default
 *     effort never decides the bill.
 *   - Fast: high-volume structured calls where latency and cost dominate (the
 *     Classifier, highlight to explain).
 *
 * Every default here is only a default: each engine keeps its own
 * `FALCON_*_MODEL` override.
 */

/** The official Claude API. Used whenever `ANTHROPIC_BASE_URL` is unset. */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/** Reader-facing prose: write-ups, chat, the briefing, agents. */
export const CLAUDE_WRITING_MODEL = "claude-opus-5-5";

/** High-volume structured calls: classification, highlight to explain. */
export const CLAUDE_FAST_MODEL = "claude-haiku-5-5";

type ClaudeVersion = { family: string; major: number; minor: number };

/**
 * `claude-haiku-4-5-20251001` → haiku 4.5, `claude-opus-5` → opus 5.0.
 * Null for anything that is not a current-style Claude id: a legacy
 * `claude-3-5-sonnet-…` id, or another provider's model on an OpenRouter route.
 */
function claudeVersion(model: string): ClaudeVersion | null {
  const id = model.trim().toLowerCase().replace(/^anthropic[/.]/, "").replace(/\./g, "-");
  const m = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (!m) return null;
  return { family: m[1]!, major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

function atLeast(v: ClaudeVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/**
 * False when the model rejects `temperature` / `top_p` / `top_k`. From
 * Opus 4.7 on (and on every Fable model) a non-default value is a 400, so the
 * field has to be left out rather than set to 0. Older Claude ids and other
 * providers' models still take it.
 */
export function acceptsSamplingParams(model: string): boolean {
  const v = claudeVersion(model);
  if (!v) return true;
  if (v.family === "fable" || v.family === "mythos") return false;
  return !atLeast(v, 4, 7);
}

/**
 * True when the model takes `output_config.effort`. Haiku 4.5, Sonnet 4.5 and
 * older reject it; Opus 4.5 and every 4.6+ model accept it. Unknown models
 * (another provider behind OpenRouter) are not sent it.
 */
export function acceptsEffort(model: string): boolean {
  const v = claudeVersion(model);
  if (!v) return false;
  if (v.family === "fable" || v.family === "mythos") return true;
  if (atLeast(v, 4, 6)) return true;
  return v.family === "opus" && v.major === 4 && v.minor === 5;
}
