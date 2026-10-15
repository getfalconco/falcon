/**
 * Settings → Engines contract: where this install's engines run and what they
 * talk to. Built in the main process from its environment; key values never
 * cross IPC — a provider is only ever "configured" or not.
 */

/** Where an endpoint's address came from. "off" = deliberately unset in .env. */
export type EndpointSource = "default" | "env" | "off";

export type EngineEndpoint = {
  /** Base URL without a trailing slash; null when there is none. */
  url: string | null;
  source: EndpointSource;
};

export type EngineProviderId =
  | "anthropic"
  | "openrouter"
  | "finnhub"
  | "edgar"
  | "yahoo"
  | "supabase";

export type EngineProviderStatus = {
  id: EngineProviderId;
  label: string;
  /** What in Falcon leans on it, in a few words (English; the renderer words it by `id`). */
  usedFor: string;
  /** OpenRouter only: the engines routed through it, for the renderer's own wording. */
  routedEngines?: string[];
  /** A key (or URL) is present where it is needed, or none is needed. */
  configured: boolean;
  /** True when the provider asks for no key at all. */
  keyless: boolean;
  /** Host the calls go to — never a key, never a path with a token in it. */
  host: string;
  /** "direct" calls the provider; "worker" goes through the research worker. */
  route: "direct" | "worker";
};

export type EngineModelInUse = {
  id: string;
  label: string;
  /** Model id, or null when the work runs elsewhere and the name isn't known here. */
  model: string | null;
  /** Where the call is made from. */
  where: "this app" | "research worker";
};

export type EnginesOverview = {
  packaged: boolean;
  /** The always-on chain (Tracker, Classifier, Base, Propagation). */
  engine: EngineEndpoint & {
    /** FALCON_LOCAL_CHAIN=1 with no engine URL: this process runs the chain. */
    localChain: boolean;
  };
  /** Research worker: step-1 jobs, brokerage, and the provider proxy. */
  worker: EngineEndpoint;
  /** "proxy" = Anthropic and Finnhub go through the worker with the reader's session. */
  providerMode: "direct" | "proxy";
  signedIn: boolean;
  providers: EngineProviderStatus[];
  /** Models the desktop process calls itself. The chain's come from its own status. */
  localModels: EngineModelInUse[];
};

export type EngineConnectionCheck = {
  status: "ok" | "fail" | "skipped";
  latencyMs?: number;
  version?: string;
  detail?: string;
};

export type EnginesCheckResult = {
  engine: EngineConnectionCheck;
  yahoo: EngineConnectionCheck;
};
