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

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Engines that resolve their own route. */
export type EngineName = "classifier" | "step1" | "analyst" | "propagation" | "insight";

export type ProviderRoute = {
  apiKey: string;
  /** Empty means api.anthropic.com — the SDK's own default. */
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
      baseUrl: read(envFor(engine, "BASE_URL")).replace(/\/+$/, ""),
      source: "engine-override",
    };
  }

  if (openRouterEngines().has(engine)) {
    const key = read("FALCON_OPENROUTER_KEY");
    if (key) {
      return {
        apiKey: key,
        baseUrl: (read("FALCON_OPENROUTER_BASE_URL") || OPENROUTER_BASE_URL).replace(/\/+$/, ""),
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
    baseUrl: read("ANTHROPIC_BASE_URL").replace(/\/+$/, ""),
    source: "global",
  };
}

/** Host each engine resolves to, for the diagnostics line. Never includes keys. */
export function providerRouteSummary(): Record<string, { host: string; source: string }> {
  const engines: EngineName[] = ["classifier", "step1", "analyst", "propagation", "insight"];
  const out: Record<string, { host: string; source: string }> = {};
  for (const e of engines) {
    const r = providerRouteFor(e);
    let host = "api.anthropic.com";
    if (r.baseUrl) {
      try {
        host = new URL(r.baseUrl).host;
      } catch {
        host = r.baseUrl;
      }
    }
    out[e] = { host, source: r.source };
  }
  return out;
}
