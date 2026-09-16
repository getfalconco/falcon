import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import { providerRouteFor } from "../providerRoute.js";
import type { TokenUsage } from "./tokenUsage.js";

export function createAnthropicClient(): Anthropic {
  const route = providerRouteFor("step1");
  if (!route.apiKey) {
    throw new Error("No API key for step1 — set FALCON_OPENROUTER_KEY or ANTHROPIC_API_KEY");
  }
  // Honour ANTHROPIC_BASE_URL so the whole engine can be pointed at a gateway
  // instead of api.anthropic.com. Without this the SDK silently ignored the
  // configured base URL and sent gateway keys straight to Anthropic, which
  // rejects them as invalid (401).
  return new Anthropic({
    apiKey: route.apiKey,
    ...(route.baseUrl ? { baseURL: route.baseUrl } : {}),
  });
}

export function formatAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API ${err.status}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Tiny pre-flight call — fails fast before EDGAR fetch if auth/billing/network is broken. */
export async function pingAnthropicApi(): Promise<void> {
  const client = createAnthropicClient();
  const config = getConfig();
  await client.messages.create({
    model: config.falconModel,
    max_tokens: 5,
    messages: [{ role: "user", content: "ping" }],
  });
}

/**
 * The smallest prefix Anthropic will actually cache. Below this a
 * `cache_control` breakpoint is accepted and then silently ignored — no write,
 * no read, no error. Both step1 system prompts are under it (790 and 500
 * tokens), which is why nothing here caches a system block: it would look like
 * caching and do nothing. Only a filing chunk (~6k tokens) clears the bar.
 */
export const MIN_CACHEABLE_TOKENS = 1024;

/** Rough token estimate — only used to decide whether a breakpoint is worth setting. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * One block of the user message.
 *
 * `cache: true` is a claim that THIS block will be sent again, byte-identical,
 * behind the same prefix, within the cache TTL. It is not a hint — a write
 * costs 1.25x and a block that is never read back is pure loss, which is
 * exactly how a cache bill snowballs. Callers set it only when they know a
 * second call is coming (see `auditCandidates`, which sets it only when a chunk
 * needs more than one batch).
 */
export type UserBlock = { text: string; cache?: boolean };

function toContent(
  user: string | UserBlock[],
): string | Anthropic.TextBlockParam[] {
  if (typeof user === "string") return user;
  return user.map((block) => ({
    type: "text" as const,
    text: block.text,
    // Guard the breakpoint: under the minimum it is a no-op, so don't pretend.
    ...(block.cache && approxTokens(block.text) >= MIN_CACHEABLE_TOKENS
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }));
}

export async function callClaudeJson(options: {
  system: string;
  /**
   * A plain string, or ordered blocks when part of the message is cacheable.
   * Caching is a PREFIX match, so anything that varies per call must come
   * after the block it would otherwise invalidate.
   */
  user: string | UserBlock[];
  maxTokens: number;
  usage?: TokenUsage;
  /** Override the configured FALCON_MODEL for this call (e.g. Haiku for backtest replays). */
  model?: string;
}): Promise<string> {
  const client = createAnthropicClient();
  const config = getConfig();
  const response = await client.messages.create({
    model: options.model ?? config.falconModel,
    max_tokens: options.maxTokens,
    system: options.system,
    messages: [{ role: "user", content: toContent(options.user) }],
  });

  if (options.usage && response.usage) {
    options.usage.inputTokens += response.usage.input_tokens;
    options.usage.outputTokens += response.usage.output_tokens;
    options.usage.cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
    options.usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
  }

  const textBlocks = response.content.filter((block) => block.type === "text");
  return textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
}
