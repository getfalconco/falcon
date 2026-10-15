/**
 * Which provider each engine talks to.
 *
 * Every engine used to read `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`
 * directly, so the whole chain went wherever those two pointed. That was fine
 * while there was one destination. It stops being fine the moment the answer
 * differs by engine — the classifier and step1 can run on a free model because
 * their inputs are public filings and published news, while the propagation
 * judge and the Insight write-up are the product's reasoning and its only
 * user-facing prose, and those stay on Claude.
 *
 * So the route becomes a per-engine question with a global fallback. An engine
 * with no override behaves exactly as before, which is what keeps this from
 * being a migration.
 *
 * OpenRouter is reachable without a new client: `/api/v1/messages` answers in
 * Anthropic's wire format (its 401 carries Anthropic's own error envelope,
 * `request_id` and all), so pointing the existing SDK at it is enough.
 */

import { ANTHROPIC_API_BASE_URL } from "./anthropicModels.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Engines that resolve their own route. */
export type EngineName = "classifier" | "step1" | "analyst" | "propagation" | "insight";

export type ProviderRoute = {
  apiKey: string;
  /**
   * Always a full URL, never empty: `ANTHROPIC_BASE_URL` when one is set (a
   * gateway, or the research-worker proxy in a packaged build), else the
   * official Claude API. Explicit so every caller sends its traffic to the
   * same place whatever the SDK's own env fallback would pick.
   */
  baseUrl: string;
  /** Where this came from, for the diagnostics line on /health. */
  source: "engine-override" | "openrouter" | "global";
};

/** `FALCON_CLASSIFIER_API_KEY`, `FALCON_STEP1_BASE_URL`, and so on. */
function envFor(engine: EngineName, suffix: "API_KEY" | "BASE_URL"): string {
  return `FALCON_${engine.toUpperCase()}_${suffix}`;
}

function read(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `ANTHROPIC_BASE_URL` when set, else the official Claude API. */
export function anthropicBaseUrl(): string {
  return trimSlash(read("ANTHROPIC_BASE_URL")) || ANTHROPIC_API_BASE_URL;
}

/**
 * Engines routed to OpenRouter by name, as a comma-separated list.
 *
 * A list rather than a flag per engine: the decision is "which side of the line
 * is this on", and one variable keeps the answer readable in a deployment's
 * settings page instead of scattered across five booleans that can disagree.
 *
 *   FALCON_OPENROUTER_ENGINES=classifier,step1
 */
function openRouterEngines(): Set<string> {
  return new Set(
    read("FALCON_OPENROUTER_ENGINES")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The route for one engine.
 *
 * Precedence, most specific first: an explicit per-engine key, then the
 * OpenRouter list, then the global pair everything used before.
 */
export function providerRouteFor(engine: EngineName): ProviderRoute {
  const ownKey = read(envFor(engine, "API_KEY"));
  if (ownKey) {
    return {
      apiKey: ownKey,
      // No engine-specific URL: the global one, as the SDK would have picked.
      baseUrl: trimSlash(read(envFor(engine, "BASE_URL"))) || anthropicBaseUrl(),
      source: "engine-override",
    };
  }

  if (openRouterEngines().has(engine)) {
    const key = read("FALCON_OPENROUTER_KEY");
    if (key) {
      return {
        apiKey: key,
        baseUrl: trimSlash(read("FALCON_OPENROUTER_BASE_URL") || OPENROUTER_BASE_URL),
        source: "openrouter",
      };
    }
    // Named for OpenRouter but no key: fall through to the global route rather
    // than fail. A missing key should degrade to the old behaviour, not take
    // the engine down.
    console.warn(
      `[route] ${engine} is listed in FALCON_OPENROUTER_ENGINES but FALCON_OPENROUTER_KEY is unset — using the global route`,
    );
  }

  return {
    apiKey: read("ANTHROPIC_API_KEY"),
    baseUrl: anthropicBaseUrl(),
    source: "global",
  };
}

/** Host each engine resolves to, for the diagnostics line. Never includes keys. */
export function providerRouteSummary(): Record<string, { host: string; source: string }> {
  const engines: EngineName[] = ["classifier", "step1", "analyst", "propagation", "insight"];
  const out: Record<string, { host: string; source: string }> = {};
  for (const e of engines) {
    const r = providerRouteFor(e);
    out[e] = { host: hostOfUrl(r.baseUrl), source: r.source };
  }
  return out;
}

/** Host of a route's URL, for logs and health lines. Never a path or a key. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * True when a key cannot work on this route: a key without the `sk-ant-`
 * prefix sent to the official API is a certain 401 (a gateway key, or the
 * reader's session token without the worker's URL). Any other pairing may
 * work: official keys start with `sk-ant-`, and some gateways issue keys of
 * that shape too, so an `sk-ant-` key going elsewhere is not flagged.
 */
export function keyBrokenForRoute(apiKey: string, baseUrl: string): boolean {
  return Boolean(apiKey) && !apiKey.startsWith("sk-ant-") && hostOfUrl(baseUrl) === hostOfUrl(ANTHROPIC_API_BASE_URL);
}
