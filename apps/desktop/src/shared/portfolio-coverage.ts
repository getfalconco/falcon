/**
 * Portfolio coverage: every symbol the user holds must be (a) tracked by the
 * Tracker engine and (b) have a relationship graph (step1). This is the
 * per-symbol record of what has been done about that, persisted so a restart
 * neither repeats a costly step1 job nor forgets a failure.
 */

export type Step1CoverageStatus = "cached" | "started" | "done" | "error";

export type PortfolioCoverageEntry = {
  symbol: string;
  /** When the tracker backfill for this symbol was kicked off (null = not yet). */
  trackerAddedAt: string | null;
  step1: {
    status: Step1CoverageStatus;
    at: string;
    jobId: string | null;
    error: string | null;
  } | null;
  lastSeenAt: string;
};

export type PortfolioCoverageSnapshot = {
  entries: Record<string, PortfolioCoverageEntry>;
  lastSyncAt: string | null;
  /** Work still queued or running in the background. */
  inFlight: string[];
};

export type PortfolioSyncResult = {
  ok: true;
  /** Symbols that needed tracker and/or step1 work this sync. */
  queued: string[];
  /** Symbols already fully covered. */
  covered: string[];
};
