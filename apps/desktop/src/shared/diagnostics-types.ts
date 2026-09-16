/**
 * Shift+H diagnostics panel contract. The whole point of the panel is to make
 * a packaged Falcon.exe prove it can reach every paid provider and that every
 * engine bootstrapped — dev builds read `.env` directly while packaged builds
 * route Anthropic/Finnhub through the research-worker with a Supabase JWT, so
 * "works on my machine" says nothing about the shipped exe.
 */

export type DiagnosticsKeyInfo = {
  /** Env var name, e.g. ANTHROPIC_API_KEY. Values never leave the main process. */
  name: string;
  present: boolean;
  /** Length of the value (0 when absent) — enough to spot a truncated paste. */
  length: number;
  note?: string;
};

export type DiagnosticsEnvInfo = {
  appVersion: string;
  electron: string;
  node: string;
  packaged: boolean;
  /** "proxy" = Anthropic+Finnhub routed through the research-worker with a JWT. */
  providerMode: "direct" | "proxy";
  workerUrl: string | null;
  anthropicBaseUrl: string;
  finnhubBaseUrl: string;
  dataRoot: string;
  session: { hasToken: boolean; hasSupabaseUrl: boolean; updatedAt: string | null };
  keys: DiagnosticsKeyInfo[];
};

export type ProviderCheckStatus = "ok" | "fail" | "missing-key" | "skipped";

export type ProviderCheckResult = {
  id: string;
  label: string;
  status: ProviderCheckStatus;
  httpStatus?: number;
  latencyMs?: number;
  /** Error text / body snippet on failure, or a short success note. */
  detail?: string;
};
