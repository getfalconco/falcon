/**
 * The real `ModelCaller`: one Anthropic Messages call with structured JSON
 * output, temperature 0, bounded max_tokens and a per-call timeout/abort.
 * Never imported by tests — they inject fixture callers.
 */

import Anthropic from "@anthropic-ai/sdk";
import { providerRouteFor } from "../providerRoute.js";
import { withProviderSlot } from "../providerGate.js";
import { jsonFromModelText, withJsonInstruction } from "../model-json.js";
import type { ModelCaller } from "./types.js";

let client: Anthropic | null = null;
let clientKey: string | null = null;
let clientBaseUrl: string | null = null;

/** Where calls go: a gateway/proxy when configured, else the Anthropic API. */

/**
 * A key that is not an `sk-ant-…` key only works against a gateway: the
 * research-worker proxy takes the user's Supabase JWT, and a third-party
 * gateway takes its own key. Sent to api.anthropic.com such a key is a
 * guaranteed 401, and the error it comes back with ("API key is invalid")
 * describes the key rather than the missing base URL — which is what makes
 * this misconfiguration expensive to diagnose. Refuse before calling.
 */
function assertKeyMatchesRoute(apiKey: string, baseUrl: string): void {
  if (baseUrl || apiKey.startsWith("sk-ant-")) return;
  throw new Error(
    "ANTHROPIC_API_KEY is not an Anthropic key (no sk-ant- prefix) and ANTHROPIC_BASE_URL is unset, " +
      "so the call would go to api.anthropic.com and be rejected. Set ANTHROPIC_BASE_URL to the gateway " +
      "this key belongs to, or supply an Anthropic key.",
  );
}

function getClient(): Anthropic {
  // Re-create when the key OR the route changes: a packaged desktop build
  // routes through the research-worker proxy with the user's rotating Supabase
  // JWT as the key, and provider-routing stamps ANTHROPIC_BASE_URL at startup —
  // possibly after this module has already built a client.
  const route = providerRouteFor("classifier");
  const currentKey = route.apiKey;
  const baseURL = route.baseUrl;
  if (client && clientKey === currentKey && clientBaseUrl === baseURL) return client;
  if (!currentKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  assertKeyMatchesRoute(currentKey, baseURL);
  // SDK retries are disabled here: the service owns retry/backoff/breaker so
  // the metrics see every attempt.
  client = new Anthropic({ apiKey: currentKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
  clientKey = currentKey;
  clientBaseUrl = baseURL;
  return client;
}


/**
 * How long to wait after a 429 before the caller retries.
 *
 * The gateway limits CONCURRENCY, not just rate, and the immediate retry the
 * service does on a transport failure walks straight back into the same wall:
 * 270 articles failed this way, each burning up to three paid attempts. When
 * the response carries `retry-after` we honour it; otherwise a second is long
 * enough for the in-flight batch to drain.
 */
export const RATE_LIMIT_BACKOFF_MS = 1_000;

export function retryDelayFor(err: unknown): number | null {
  const status = (err as { status?: number } | null)?.status;
  if (status !== 429) return null;
  const headers = (err as { headers?: Record<string, string> } | null)?.headers;
  const after = Number(headers?.["retry-after"]);
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 10_000);
  return RATE_LIMIT_BACKOFF_MS;
}

export const anthropicModelCaller: ModelCaller = async (input) =>
  createWithRateLimitRetry(input);

/** One retry on 429, spaced; anything else is the service's to handle. */
async function createWithRateLimitRetry(input: Parameters<ModelCaller>[0]) {
  try {
    return await rawCreate(input);
  } catch (err) {
    const delay = retryDelayFor(err);
    if (delay == null) throw err;
    await new Promise((r) => setTimeout(r, delay));
    return rawCreate(input);
  }
}

async function rawCreate(input: Parameters<ModelCaller>[0]) {
  const response = await withProviderSlot("classifier", () =>
    getClient().messages.create(
    {
      model: input.model,
      max_tokens: input.max_tokens,
      temperature: input.temperature,
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
      output_config: { format: { type: "json_schema", schema: input.output_schema } },
    },
    { timeout: input.timeout_ms, signal: input.signal },
    ),
  );
  if (response.stop_reason === "refusal") {
    throw new Error("model refused the request");
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
