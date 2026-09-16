/**
 * The real `ModelCaller`: one Anthropic Messages call with structured JSON
 * output, bounded max_tokens and a per-call timeout/abort. Never imported by
 * tests — they inject fixture callers.
 *
 * Differs from a plain call only where Fable 5's API differs: sampling
 * parameters are rejected (no `temperature`), thinking is always on (no
 * `thinking` param; depth via `output_config.effort`), and a safety refusal
 * (`stop_reason: "refusal"`) is surfaced as a non-retryable error so the
 * request fails honestly rather than burning retries.
 *
 * Proxy-aware, like every other engine's caller: a packaged desktop build
 * reaches Anthropic through the research-worker with the user's rotating
 * Supabase JWT standing in for the key, so the client is re-created whenever
 * that key changes and the schema is restated in the prompt for gateways that
 * do not implement `output_config`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { providerRouteFor } from "../providerRoute.js";
import { withProviderSlot } from "../providerGate.js";
import { jsonFromModelText, withJsonInstruction } from "../model-json.js";
import type { ModelCaller } from "./types.js";

let client: Anthropic | null = null;
let clientKey: string | null = null;

function getClient(): Anthropic {
  // Re-create when the key changes: a packaged desktop build routes through the
  // research-worker proxy with the user's rotating Supabase JWT as the key.
  const route = providerRouteFor("analyst");
  const currentKey = route.apiKey;
  if (client && clientKey === currentKey) return client;
  const apiKey = route.apiKey;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  // SDK retries are disabled here: the service owns retry/backoff/breaker so
  // the metrics see every attempt.
  client = new Anthropic({ apiKey, maxRetries: 0 });
  clientKey = apiKey;
  return client;
}

export const anthropicModelCaller: ModelCaller = async (input) => {
  const response = await withProviderSlot("analyst", () =>
    getClient().messages.create(
    {
      model: input.model,
      max_tokens: input.max_tokens,
      // The schema is sent twice on purpose: `output_config` is the real
      // guarantee, but a gateway that does not implement it returns 200 and
      // silently ignores it, and the reply arrives as prose. Restating the
      // shape in the prompt is what keeps that case working.
      // No cache_control, deliberately.
      //
      // Measured on the gateway: one classifier cycle made ~76 calls seconds
      // apart behind an identical system block, wrote 135,995 tokens of cache
      // and read back 3,465 — 2.6% of what a working cache would have served.
      // Requests that close together sit well inside even the 5-minute default,
      // so this is not a TTL problem: the gateway does not serve cache reads.
      //
      // A write costs 1.25x (2x at 1h) and only pays for itself when something
      // reads it, so caching here is a pure surcharge on every call. Not
      // caching is the cheapest correct option until the gateway serves reads
      // — worth re-testing if we move off it, or if it gains support.
      system: withJsonInstruction(input.system, input.output_schema),
      messages: [{ role: "user", content: input.user }],
      output_config: {
        format: { type: "json_schema", schema: input.output_schema },
        effort: input.effort as "low" | "medium" | "high" | "xhigh" | "max",
      },
    },
    { timeout: input.timeout_ms, signal: input.signal },
    ),
  );
  if (response.stop_reason === "refusal") {
    const err = new Error(
      `model refused the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`,
    );
    // Non-retryable: the same prompt will be declined again.
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (response.stop_reason === "max_tokens") {
    throw new Error(`response truncated at max_tokens=${input.max_tokens}`);
  }
  return {
    // Clean JSON passes through untouched; a preamble, a fence or a
    // leaked reasoning block is peeled off. Prose with no JSON in it stays
    // prose, so the caller's own parse error still fires.
    text: jsonFromModelText(text),
    input_tokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    output_tokens: response.usage.output_tokens,
    // Reported separately as well as in the total: this is the pair that says
    // whether the cache is earning its 1.25x write premium or just paying it.
    cache_creation_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
  };
};

/** True when a live call is possible in this process. */
export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
