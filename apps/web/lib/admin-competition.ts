import { getSupabaseAdmin } from "./supabase-admin";

/** Keep in lockstep with packages/research/src/competition/policy.ts — web must not import the research package. */
const RUN_ID = "falcon-live-paper-60d";

const PAPER_COMPETITION_POLICY = {
  version: "paper-60d-v1",
  startingCashUsd: 10_000,
  durationDays: 60,
  minConfidence: 0.55,
  windowOpenOnly: true,
  excludeLowMagnitude: true,
  longOnly: false,
  holdWeekdays: 5,
  positionFraction: 0.1,
  maxConcurrentPositions: 10,
  maxSignalAgeHours: 24,
  fill: "last_extended_or_regular_quote",
  benchmark: "SPY",
} as const;

const SKIP_REASON_LABEL: Record<string, string> = {
  run_inactive: "Run is not active",
  generated_before_lookback: "Signal predates the 24h lookback around run start",
  stale_for_ui_window: "Older than 24h — would not show as an open window to users",
  below_min_confidence: "path_confidence below 0.55",
  window_closed: "Already priced in (window closed)",
  low_magnitude: "Magnitude is low — hidden from open-signal cards",
  unclear_direction: "Direction unclear — no side to take",
  long_only_skip_short: "Policy is long-only",
  duplicate_ticker: "Already holding this ticker",
  max_positions: "Max concurrent positions reached",
  insufficient_cash: "Not enough cash for a 10% sleeve (no leverage)",
  missing_price: "No live quote at decision time",
};

export type CompetitionRun = {
  id: string;
  title: string;
  status: string;
  startedAt: string;
  endsAt: string;
  initialCash: number;
  cash: number;
  spyStart: number | null;
  peakNav: number;
  lastTickAt: string | null;
  lastTickSummary: string | null;
  notes: string | null;
  policy: Record<string, unknown>;
};

export type CompetitionDecision = {
  id: string;
  signalId: string;
  ticker: string;
  direction: string;
  generatedAt: string | null;
  verdict: string;
  skipReason: string | null;
  skipLabel: string | null;
  pathConfidence: number;
  magnitude: string;
  pricedInStatus: string;
  headline: string;
  eventSummary: string;
  reasoning: string;
  mechanism: string;
  expectedMovePct: number | null;
  expectedDays: number | null;
  createdAt: string;
};

export type CompetitionPosition = {
  id: string;
  signalId: string;
  ticker: string;
  direction: string;
  shares: number;
  weight: number;
  notionalUsd: number;
  entryPrice: number;
  entryAt: string;
  entrySource: string | null;
  plannedExitAt: string;
  exitPrice: number | null;
  exitAt: string | null;
  exitReason: string | null;
  pnlUsd: number | null;
  returnPct: number | null;
  status: string;
  headline: string;
  pathConfidence: number;
  eventSummary: string;
  reasoning: string;
  mechanism: string;
};

export type CompetitionEvent = {
  id: number;
  ts: string;
  stage: string;
  message: string;
  signalId: string | null;
  ticker: string | null;
  payload: Record<string, unknown>;
};

export type CompetitionSnapshot = {
  ts: string;
  cash: number;
  positionsValue: number;
  nav: number;
  spyPrice: number | null;
  spyNav: number | null;
  openCount: number;
  peakNav: number;
  drawdownPct: number;
};

export type CompetitionDashboard = {
  generatedAt: string;
  missingTable: boolean;
  degraded: boolean;
  run: CompetitionRun | null;
  latest: CompetitionSnapshot | null;
  spyReturnPct: number | null;
  falconReturnPct: number | null;
  vsSpyPct: number | null;
  daysElapsed: number;
  daysLeft: number;
  durationDays: number;
  closedCount: number;
  openCount: number;
  winCount: number;
  lossCount: number;
  filledCount: number;
  skippedCount: number;
  fillFailedCount: number;
  skipBreakdown: Array<{ reason: string; label: string; count: number }>;
  snapshots: CompetitionSnapshot[];
  openPositions: CompetitionPosition[];
  closedPositions: CompetitionPosition[];
  decisions: CompetitionDecision[];
  events: CompetitionEvent[];
  policy: typeof PAPER_COMPETITION_POLICY;
};

function n(v: unknown, fallback = 0): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /paper_competition/i.test(error.message ?? "") && /exist/i.test(error.message ?? "");
}

function empty(opts: { degraded?: boolean; missingTable?: boolean }): CompetitionDashboard {
  return {
    generatedAt: new Date().toISOString(),
    missingTable: opts.missingTable ?? false,
    degraded: opts.degraded ?? false,
    run: null,
    latest: null,
    spyReturnPct: null,
    falconReturnPct: null,
    vsSpyPct: null,
    daysElapsed: 0,
    daysLeft: PAPER_COMPETITION_POLICY.durationDays,
    durationDays: PAPER_COMPETITION_POLICY.durationDays,
    closedCount: 0,
    openCount: 0,
    winCount: 0,
    lossCount: 0,
    filledCount: 0,
    skippedCount: 0,
    fillFailedCount: 0,
    skipBreakdown: [],
    snapshots: [],
    openPositions: [],
    closedPositions: [],
    decisions: [],
    events: [],
    policy: PAPER_COMPETITION_POLICY,
  };
}

function mapPosition(row: Record<string, unknown>): CompetitionPosition {
  return {
    id: String(row.id),
    signalId: String(row.signal_id),
    ticker: String(row.ticker ?? ""),
    direction: String(row.direction ?? ""),
    shares: n(row.shares),
    weight: n(row.weight),
    notionalUsd: n(row.notional_usd),
    entryPrice: n(row.entry_price),
    entryAt: String(row.entry_at ?? ""),
    entrySource: row.entry_source == null ? null : String(row.entry_source),
    plannedExitAt: String(row.planned_exit_at ?? ""),
    exitPrice: row.exit_price == null ? null : n(row.exit_price),
    exitAt: row.exit_at == null ? null : String(row.exit_at),
    exitReason: row.exit_reason == null ? null : String(row.exit_reason),
    pnlUsd: row.pnl_usd == null ? null : n(row.pnl_usd),
    returnPct: row.return_pct == null ? null : n(row.return_pct),
    status: String(row.status ?? ""),
    headline: String(row.headline ?? ""),
    pathConfidence: n(row.path_confidence),
    eventSummary: String(row.event_summary ?? ""),
    reasoning: String(row.reasoning ?? ""),
    mechanism: String(row.mechanism ?? ""),
  };
}

function mapDecision(row: Record<string, unknown>): CompetitionDecision {
  const reason = row.skip_reason == null ? null : String(row.skip_reason);
  return {
    id: String(row.id),
    signalId: String(row.signal_id),
    ticker: String(row.ticker ?? ""),
    direction: String(row.direction ?? ""),
    generatedAt: row.generated_at == null ? null : String(row.generated_at),
    verdict: String(row.verdict ?? ""),
    skipReason: reason,
    skipLabel: reason ? (SKIP_REASON_LABEL[reason] ?? reason) : null,
    pathConfidence: n(row.path_confidence),
    magnitude: String(row.magnitude ?? ""),
    pricedInStatus: String(row.priced_in_status ?? ""),
    headline: String(row.headline ?? ""),
    eventSummary: String(row.event_summary ?? ""),
    reasoning: String(row.reasoning ?? ""),
    mechanism: String(row.mechanism ?? ""),
    expectedMovePct: row.expected_move_pct == null ? null : n(row.expected_move_pct),
    expectedDays: row.expected_days == null ? null : n(row.expected_days),
    createdAt: String(row.created_at ?? ""),
  };
}

function mapSnap(row: Record<string, unknown>): CompetitionSnapshot {
  return {
    ts: String(row.ts ?? ""),
    cash: n(row.cash),
    positionsValue: n(row.positions_value),
    nav: n(row.nav),
    spyPrice: row.spy_price == null ? null : n(row.spy_price),
    spyNav: row.spy_nav == null ? null : n(row.spy_nav),
    openCount: n(row.open_count),
    peakNav: n(row.peak_nav),
    drawdownPct: n(row.drawdown_pct),
  };
}

export async function getCompetitionDashboard(): Promise<CompetitionDashboard> {
  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return empty({ degraded: true });
  }

  const runRes = await admin
    .from("paper_competition_runs")
    .select("*")
    .eq("id", RUN_ID)
    .maybeSingle();

  if (runRes.error) {
    if (missingTable(runRes.error)) return empty({ missingTable: true });
    console.error("[admin competition] run fetch failed", runRes.error);
    return empty({ degraded: true });
  }
  if (!runRes.data) return empty({});

  const row = runRes.data as Record<string, unknown>;
  const run: CompetitionRun = {
    id: String(row.id),
    title: String(row.title ?? ""),
    status: String(row.status ?? ""),
    startedAt: String(row.started_at ?? ""),
    endsAt: String(row.ends_at ?? ""),
    initialCash: n(row.initial_cash, 10_000),
    cash: n(row.cash),
    spyStart: row.spy_start == null ? null : n(row.spy_start),
    peakNav: n(row.peak_nav, 10_000),
    lastTickAt: row.last_tick_at == null ? null : String(row.last_tick_at),
    lastTickSummary: row.last_tick_summary == null ? null : String(row.last_tick_summary),
    notes: row.notes == null ? null : String(row.notes),
    policy: (row.policy as Record<string, unknown>) ?? {},
  };

  const [posRes, decRes, evRes, snapRes] = await Promise.all([
    admin
      .from("paper_competition_positions")
      .select("*")
      .eq("run_id", RUN_ID)
      .order("entry_at", { ascending: false }),
    admin
      .from("paper_competition_decisions")
      .select("*")
      .eq("run_id", RUN_ID)
      .order("created_at", { ascending: false })
      .limit(400),
    admin
      .from("paper_competition_events")
      .select("*")
      .eq("run_id", RUN_ID)
      .order("ts", { ascending: false })
      .limit(400),
    admin
      .from("paper_competition_snapshots")
      .select("*")
      .eq("run_id", RUN_ID)
      .order("ts", { ascending: true })
      .limit(2000),
  ]);

  if (posRes.error || decRes.error || evRes.error || snapRes.error) {
    console.error("[admin competition] ledger fetch failed", {
      pos: posRes.error,
      dec: decRes.error,
      ev: evRes.error,
      snap: snapRes.error,
    });
    return empty({ degraded: true });
  }

  const positions = (posRes.data ?? []).map((r) => mapPosition(r as Record<string, unknown>));
  const decisions = (decRes.data ?? []).map((r) => mapDecision(r as Record<string, unknown>));
  const events = (evRes.data ?? []).map((r) => {
    const e = r as Record<string, unknown>;
    return {
      id: n(e.id),
      ts: String(e.ts ?? ""),
      stage: String(e.stage ?? ""),
      message: String(e.message ?? ""),
      signalId: e.signal_id == null ? null : String(e.signal_id),
      ticker: e.ticker == null ? null : String(e.ticker),
      payload: (e.payload as Record<string, unknown>) ?? {},
    };
  });
  const snapshots = (snapRes.data ?? []).map((r) => mapSnap(r as Record<string, unknown>));

  const openPositions = positions.filter((p) => p.status === "open");
  const closedPositions = positions.filter((p) => p.status === "closed");
  const latest = snapshots[snapshots.length - 1] ?? null;
  const nav = latest?.nav ?? run.cash;
  const falconReturnPct = ((nav - run.initialCash) / run.initialCash) * 100;
  const spyNav = latest?.spyNav ?? null;
  const spyReturnPct =
    spyNav != null ? ((spyNav - run.initialCash) / run.initialCash) * 100 : null;
  const vsSpyPct = spyReturnPct != null ? falconReturnPct - spyReturnPct : null;

  const started = Date.parse(run.startedAt);
  const ends = Date.parse(run.endsAt);
  const now = Date.now();
  const daysElapsed = Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 86_400_000))
    : 0;
  const daysLeft = Number.isFinite(ends)
    ? Math.max(0, Math.ceil((ends - now) / 86_400_000))
    : 0;

  const skipCounts = new Map<string, number>();
  for (const d of decisions) {
    if (d.verdict === "skipped" && d.skipReason) {
      skipCounts.set(d.skipReason, (skipCounts.get(d.skipReason) ?? 0) + 1);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    missingTable: false,
    degraded: false,
    run,
    latest,
    spyReturnPct,
    falconReturnPct,
    vsSpyPct,
    daysElapsed,
    daysLeft,
    durationDays: PAPER_COMPETITION_POLICY.durationDays,
    closedCount: closedPositions.length,
    openCount: openPositions.length,
    winCount: closedPositions.filter((p) => (p.pnlUsd ?? 0) > 0).length,
    lossCount: closedPositions.filter((p) => (p.pnlUsd ?? 0) < 0).length,
    filledCount: decisions.filter((d) => d.verdict === "filled").length,
    skippedCount: decisions.filter((d) => d.verdict === "skipped").length,
    fillFailedCount: decisions.filter((d) => d.verdict === "fill_failed").length,
    skipBreakdown: Array.from(skipCounts.entries())
      .map(([reason, count]) => ({
        reason,
        label: SKIP_REASON_LABEL[reason] ?? reason,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    snapshots,
    openPositions,
    closedPositions,
    decisions,
    events,
    policy: PAPER_COMPETITION_POLICY,
  };
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function toneForPnl(n: number | null | undefined): string {
  if (n == null || n === 0) return "text-white/70";
  return n > 0 ? "text-emerald-400" : "text-red-400";
}
