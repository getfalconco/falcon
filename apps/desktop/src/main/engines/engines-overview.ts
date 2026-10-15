import type {
  EndpointSource,
  EngineModelInUse,
  EngineProviderStatus,
  EnginesOverview,
} from "../../shared/engines-settings";

/**
 * Settings → Engines, worked out from the main process's environment.
 *
 * Kept free of electron and of module state so it can be read in a test: the
 * caller hands in the env and the few facts only the running app knows. The
 * rules mirror the code that actually routes the calls — engine-client.ts for
 * FALCON_ENGINE_URL, provider-routing.ts for the worker and the proxy,
 * finnhub.ts and providerRoute.ts in the research package for the hosts — so
 * what the pane says is what the engines do.
 *
 * Only presence is reported for a key. Its value, its length and its prefix
 * all stay here.
 */

export type OverviewEnv = Record<string, string | undefined>;

export type OverviewContext = {
  packaged: boolean;
  providerProxy: boolean;
  signedIn: boolean;
  /** Supabase URL the renderer pushed through the session bridge, if any. */
  sessionSupabaseUrl: string | null;
  defaults: { engineUrl: string; workerUrl: string; openRouterBaseUrl: string; finnhubBaseUrl: string };
  /** Each one already resolved from its FALCON_*_MODEL override, except the briefing's. */
  models: { gloss: string; insight: string; briefing: string; agents: string; step1: string[] };
};

function read(env: OverviewEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The host of a URL, or the text itself when it is not one. Never a path or query. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * FALCON_ENGINE_URL, read the way engine-client.ts reads it: unset means the
 * service at its default address, explicitly empty means no service.
 */
export function engineEndpoint(env: OverviewEnv, defaultUrl: string): { url: string | null; source: EndpointSource } {
  const raw = env.FALCON_ENGINE_URL;
  if (raw === undefined) return { url: defaultUrl, source: "default" };
  const value = raw.trim();
  if (!value) return { url: null, source: "off" };
  const url = stripSlash(value);
  return { url, source: url === stripSlash(defaultUrl) ? "default" : "env" };
}

/**
 * RESEARCH_WORKER_URL after provider-routing.ts has resolved it at startup:
 * the packaged default lands in the same variable, so the default address is
 * reported as the default whoever wrote it.
 */
export function workerEndpoint(env: OverviewEnv, defaultUrl: string): { url: string | null; source: EndpointSource } {
  const value = stripSlash(read(env, "RESEARCH_WORKER_URL"));
  if (!value) return { url: null, source: "off" };
  return { url: value, source: value === stripSlash(defaultUrl) ? "default" : "env" };
}

function providers(env: OverviewEnv, ctx: OverviewContext): EngineProviderStatus[] {
  const route = ctx.providerProxy ? ("worker" as const) : ("direct" as const);
  const list: EngineProviderStatus[] = [
    {
      id: "anthropic",
      label: "Anthropic",
      usedFor: "Explanations, the briefing, step-1 graphs run here",
      configured: Boolean(read(env, "ANTHROPIC_API_KEY")),
      keyless: false,
      host: hostOf(read(env, "ANTHROPIC_BASE_URL") || "https://api.anthropic.com"),
      route,
    },
  ];

  const openRouterEngines = read(env, "FALCON_OPENROUTER_ENGINES")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (openRouterEngines.length > 0) {
    list.push({
      id: "openrouter",
      label: "OpenRouter",
      usedFor: `Routed engines: ${openRouterEngines.join(", ")}`,
      routedEngines: openRouterEngines,
      configured: Boolean(read(env, "FALCON_OPENROUTER_KEY")),
      keyless: false,
      host: hostOf(read(env, "FALCON_OPENROUTER_BASE_URL") || ctx.defaults.openRouterBaseUrl),
      route: "direct",
    });
  }

  list.push(
    {
      id: "finnhub",
      label: "Finnhub",
      usedFor: "Earnings calendar and company news",
      configured: Boolean(read(env, "FINNHUB_API_KEY")),
      keyless: false,
      host: hostOf(read(env, "FINNHUB_BASE_URL") || ctx.defaults.finnhubBaseUrl),
      route,
    },
    {
      id: "edgar",
      label: "SEC EDGAR",
      usedFor: "Filings for step-1 graphs run here",
      configured: true,
      keyless: true,
      host: "www.sec.gov",
      route: "direct",
    },
    {
      id: "yahoo",
      label: "Yahoo Finance",
      usedFor: "Charts, quotes and key stats",
      configured: true,
      keyless: true,
      host: "query1.finance.yahoo.com",
      route: "direct",
    },
  );

  const supabaseUrl = ctx.sessionSupabaseUrl || read(env, "SUPABASE_URL") || read(env, "VITE_SUPABASE_URL");
  list.push({
    id: "supabase",
    label: "Supabase",
    usedFor: "Sign-in and the shared cache",
    configured: Boolean(supabaseUrl),
    keyless: false,
    host: supabaseUrl ? hostOf(supabaseUrl) : "not set",
    route: "direct",
  });
  return list;
}

function localModels(env: OverviewEnv, ctx: OverviewContext, workerUrl: string | null): EngineModelInUse[] {
  const step1: EngineModelInUse = workerUrl
    ? { id: "step1", label: "Step-1 relationship graphs", model: null, where: "research worker" }
    : {
        id: "step1",
        label: "Step-1 relationship graphs",
        model: [...new Set(ctx.models.step1)].join(" · "),
        where: "this app",
      };
  return [
    { id: "insight", label: "Event explanations and chat", model: ctx.models.insight, where: "this app" },
    { id: "gloss", label: "Highlight to explain", model: ctx.models.gloss, where: "this app" },
    {
      id: "briefing",
      label: "Handover briefing",
      model: read(env, "FALCON_BRIEFING_MODEL") || ctx.models.briefing,
      where: "this app",
    },
    { id: "agents", label: "Agents", model: ctx.models.agents, where: "this app" },
    step1,
  ];
}

export function buildEnginesOverview(env: OverviewEnv, ctx: OverviewContext): EnginesOverview {
  const engine = engineEndpoint(env, ctx.defaults.engineUrl);
  const worker = workerEndpoint(env, ctx.defaults.workerUrl);
  return {
    packaged: ctx.packaged,
    engine: { ...engine, localChain: engine.url === null && read(env, "FALCON_LOCAL_CHAIN") === "1" },
    worker,
    providerMode: ctx.providerProxy ? "proxy" : "direct",
    signedIn: ctx.signedIn,
    providers: providers(env, ctx),
    localModels: localModels(env, ctx, worker.url),
  };
}
