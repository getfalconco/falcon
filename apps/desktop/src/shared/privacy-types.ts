/**
 * Settings → Privacy and Usage, as the renderer and the main process agree on
 * them. Everything here is counted from what is really on disk (main/privacy);
 * nothing is estimated on the way to the page.
 */

/**
 * What a folder under the data root holds, for the reader: their own data,
 * a cache that can be rebuilt, or an engine's working state.
 */
export type LocalDataKind = "personal" | "cache" | "engine";

export type LocalDataCategory = {
  key: string;
  label: string;
  description: string;
  kind: LocalDataKind;
  files: number;
  bytes: number;
};

/** Where this install's outbound requests actually go, read from its own config. */
export type ProviderRoutes = {
  /** Host model requests are sent to (the Claude API, or Falcon's research worker relaying to it). */
  modelHost: string;
  /** Host news requests are sent to (Finnhub, or Falcon's worker). */
  newsHost: string;
  /** Falcon's engine service when this install answers engine panels from it, else null. */
  engineHost: string | null;
  /** True when model and news requests are relayed through Falcon's research worker. */
  viaWorker: boolean;
};

export type PrivacySummary = {
  /** The data folder on this machine. */
  root: string;
  categories: LocalDataCategory[];
  /** What "Clear local history" would remove on disk: this account's saved briefings. */
  clearable: { files: number; bytes: number };
  routes: ProviderRoutes;
};

export type PrivacySummaryResult = { ok: true; summary: PrivacySummary } | { ok: false; error: string };

/** One table the renderer read under RLS, or why it could not. */
export type CloudTableExport = { rows: unknown[]; note?: string } | { error: string };

/**
 * The half of an export only the renderer can gather: the account as the
 * session has it, the app's browser storage (sign-in tokens left out), and the
 * account's rows that Supabase lets the renderer read. The main process adds
 * the files on disk and writes the whole thing where the reader chooses.
 */
export type PrivacyExportRendererPart = {
  account: Record<string, unknown> | null;
  browserStorage: Record<string, string>;
  cloud: Record<string, CloudTableExport>;
};

export type PrivacyExportResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

export type ClearHistoryResult = { ok: true; removed: number; bytes: number } | { ok: false; error: string };

/** Filing extractions in the local SEC cache, from each one's own stats file. */
export type ExtractionUsage = {
  total: number;
  thisMonth: number;
  /** Extractions that shipped with the app rather than ran here; left out of the other figures. */
  bundled: number;
  /** How many of `total` carry a stats file — the token and cost sums cover only these. */
  withStats: number;
  inputTokens: number;
  outputTokens: number;
  /** The extractor's own cost estimate, summed as recorded. Not a bill. */
  estimatedCostUsd: number;
};

/** A background engine's lifetime counters, from its metrics file. */
export type EngineUsage = {
  key: "propagation" | "classifier" | "analyst";
  label: string;
  /** What one unit of `completed` is called ("runs", "verdicts", …). */
  unit: string;
  completed: number;
  inputTokens: number;
  outputTokens: number;
};

export type UsageSummary = {
  /** ISO date of the first day of the current month on this machine's clock. */
  monthStart: string;
  extractions: ExtractionUsage;
  /** This account's saved briefings on this machine (kept for 14 days). */
  briefings: { total: number; thisMonth: number };
  /** True when engines run on Falcon's service, so nothing local is counted for them. */
  enginesRemote: boolean;
  /** Only engines that have a metrics file on this machine. */
  engines: EngineUsage[];
};

export type UsageSummaryResult = { ok: true; usage: UsageSummary } | { ok: false; error: string };
