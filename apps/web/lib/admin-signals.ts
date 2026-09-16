import { getSupabaseAdmin } from "./supabase-admin";

/**
 * Server-only data layer for the admin "Signals" tab (second-order signals /
 * opportunities). Reads the shared `second_order_signals` table that the desktop
 * main process syncs after each propagation run. Degrades gracefully to an empty
 * state when the table is absent or Supabase is unreachable.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type SignalRow = {
  id: string;
  terminal_ticker: string | null;
  root_ticker: string | null;
  direction: string | null;
  mechanical_direction: string | null;
  judge_adjusted: boolean | null;
  magnitude: string | null;
  timeframe: string | null;
  path_confidence: number | null;
  priced_in_status: string | null;
  price_change_pct: number | null;
  expected_move_pct: number | null;
  expected_days: number | null;
  target_price: number | null;
  priced_in_pct: number | null;
  event_type: string | null;
  event_summary: string | null;
  reasoning: string | null;
  mechanism: string | null;
  path: unknown;
  generated_at: string | null;
};

export type OpportunityDirection = "positive" | "negative" | "unclear";

export type Opportunity = {
  id: string;
  terminalTicker: string;
  rootTicker: string;
  direction: OpportunityDirection;
  judgeAdjusted: boolean;
  magnitude: string;
  timeframe: string;
  pathConfidence: number;
  windowOpen: boolean;
  pricedInLabel: string;
  priceChangePct: number | null;
  expectedMovePct: number | null;
  expectedDays: number | null;
  targetPrice: number | null;
  pricedInPct: number | null;
  eventType: string;
  eventSummary: string;
  reasoning: string;
  mechanism: string;
  hops: number;
  generatedAt: string;
};

export type OpportunitiesData = {
  generatedAt: string;
  total: number;
  windowOpen: number;
  last24h: number;
  positive: number;
  negative: number;
  signals: Opportunity[];
  /** True when Supabase could not be reached. */
  degraded: boolean;
  /** True when the second_order_signals table does not exist yet. */
  missingTable: boolean;
};

function normalizeDirection(value: string | null): OpportunityDirection {
  if (value === "positive" || value === "negative") return value;
  return "unclear";
}

function hopCount(path: unknown): number {
  return Array.isArray(path) ? path.length : 0;
}

function toOpportunity(row: SignalRow): Opportunity {
  const windowOpen = row.priced_in_status !== "likely priced in";
  return {
    id: row.id,
    terminalTicker: (row.terminal_ticker ?? "").toUpperCase(),
    rootTicker: (row.root_ticker ?? "").toUpperCase(),
    direction: normalizeDirection(row.direction),
    judgeAdjusted: Boolean(row.judge_adjusted),
    magnitude: row.magnitude ?? "—",
    timeframe: row.timeframe ?? "—",
    pathConfidence: typeof row.path_confidence === "number" ? row.path_confidence : 0,
    windowOpen,
    pricedInLabel: windowOpen ? "window open" : "already moved",
    priceChangePct: row.price_change_pct,
    expectedMovePct: row.expected_move_pct,
    expectedDays: row.expected_days,
    targetPrice: row.target_price,
    pricedInPct: row.priced_in_pct,
    eventType: row.event_type ?? "—",
    eventSummary: row.event_summary ?? "",
    reasoning: row.reasoning ?? "",
    mechanism: row.mechanism ?? "",
    hops: hopCount(row.path),
    generatedAt: row.generated_at ?? new Date(0).toISOString(),
  };
}

function emptyData(opts: { degraded?: boolean; missingTable?: boolean }): OpportunitiesData {
  return {
    generatedAt: new Date().toISOString(),
    total: 0,
    windowOpen: 0,
    last24h: 0,
    positive: 0,
    negative: 0,
    signals: [],
    degraded: opts.degraded ?? false,
    missingTable: opts.missingTable ?? false,
  };
}

/** Postgres "relation does not exist" is surfaced by PostgREST as code 42P01. */
function isMissingTableError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /second_order_signals/.test(error.message ?? "") && /exist/i.test(error.message ?? "");
}

export async function getOpportunitiesData(options?: { days?: number }): Promise<OpportunitiesData> {
  const days = options?.days ?? 14;
  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();

  let rows: SignalRow[] = [];
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("second_order_signals")
      .select(
        "id, terminal_ticker, root_ticker, direction, mechanical_direction, judge_adjusted, magnitude, timeframe, path_confidence, priced_in_status, price_change_pct, expected_move_pct, expected_days, target_price, priced_in_pct, event_type, event_summary, reasoning, mechanism, path, generated_at",
      )
      .gte("generated_at", sinceIso)
      .order("generated_at", { ascending: false })
      .limit(300);

    if (error) {
      if (isMissingTableError(error)) {
        return emptyData({ missingTable: true });
      }
      console.error("[admin signals] fetch failed", error);
      return emptyData({ degraded: true });
    }
    rows = (data ?? []) as SignalRow[];
  } catch (error) {
    console.error("[admin signals] fetch threw", error);
    return emptyData({ degraded: true });
  }

  const signals = rows.map(toOpportunity);
  const now = Date.now();

  return {
    generatedAt: new Date().toISOString(),
    total: signals.length,
    windowOpen: signals.filter((s) => s.windowOpen).length,
    last24h: signals.filter((s) => now - Date.parse(s.generatedAt) <= DAY_MS).length,
    positive: signals.filter((s) => s.direction === "positive").length,
    negative: signals.filter((s) => s.direction === "negative").length,
    signals,
    degraded: false,
    missingTable: false,
  };
}
