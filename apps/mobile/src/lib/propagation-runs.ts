/**
 * Mobile mirror of the Propagation engine contracts and of the pure shaping
 * the second-order card does with them — the phone's copy of
 * `apps/desktop/src/shared/propagation-run-types.ts` and the calendar half of
 * `apps/desktop/src/renderer/lib/second-order-card.ts`.
 *
 * Everything here is a verbatim port. Which run the card speaks for, which
 * days are drawn and what colour they take are decisions about *what the user
 * is told*, so both clients have to answer them identically — see
 * docs/PLATFORM_PARITY.md §4. Only the types are trimmed, to the fields the
 * phone actually reads.
 */

export type PropagationDirection = "positive" | "negative" | "mixed" | "unclear";
export type PropagationMateriality = "high" | "standard" | "low";
export type PropagationStrengthTier = "critical" | "important" | "marginal";
export type PropagationRole =
  | "supplier"
  | "customer"
  | "competitor"
  | "partner"
  | "dependency"
  | "depended_on_by";
export type PricingStatus = "open" | "partial" | "priced" | "contradicted" | "stale" | "unknown";
export type PropagationRunStatus = "ok" | "stage1_only" | "failed";

export type PropagationRunSummary = {
  targets: number;
  open: number;
  partial: number;
  priced: number;
  /** Moved meaningfully against the transmitted direction — never folded into priced. */
  contradicted: number;
  stale: number;
  untracked: number;
  vetoed: number;
  no_edge: boolean;
};

/** Compact row for the run list — what `GET /runs` returns. */
export type PropagationRunListItem = {
  run_id: string;
  incident_id: string;
  root_ticker: string;
  event_label: string;
  event_type: string;
  event_direction: PropagationDirection;
  event_materiality: PropagationMateriality;
  produced_at: string;
  event_ts: string;
  status: PropagationRunStatus;
  summary: PropagationRunSummary;
  superseded: boolean;
  update: boolean;
  absorption?: number | null;
  /** Mean signed share of the called move travelled; null when unmeasurable. */
  priced_in?: number | null;
  synthetic: boolean;
};

export type PropagationTarget = {
  target: string;
  ticker: string | null;
  label: string;
  tracked: boolean;
  relationship: { role: PropagationRole; subtype: string; tier: PropagationStrengthTier };
  transmission: { direction: PropagationDirection };
  pricing: {
    status: PricingStatus;
    ratio: number | null;
    /** Magnitude of the called move; the direction sits beside it. */
    expected_pct: number | null;
    /** The price when the call was made — the base a live share measures from. */
    reference_close: number | null;
    realized_resid_pct: number | null;
    realized_raw_pct: number | null;
  };
  mechanism: string;
  stage2: { verdict: "confirmed" | "vetoed" | "adjusted"; direction: PropagationDirection | null } | null;
};

/** One run in full — what `GET /run?id=` returns. */
export type PropagationRun = {
  run_id: string;
  incident_id: string;
  root_ticker: string;
  event: {
    type: string;
    label: string;
    direction: PropagationDirection;
    materiality: PropagationMateriality;
    event_ts: string;
  };
  targets: PropagationTarget[];
  summary: PropagationRunSummary;
  status: PropagationRunStatus;
  produced_at: string;
  synthetic: boolean;
};

// ---------------------------------------------------------------------------
// Which runs the card may speak for
// ---------------------------------------------------------------------------

const MATERIALITY_RANK: Record<PropagationMateriality, number> = {
  high: 3,
  standard: 2,
  low: 1,
};

/**
 * A run is shown while it still has something to say — an open target, a
 * partially absorbed one, or one the tape moved AGAINST. Only the fully
 * resolved runs are hidden.
 */
export function isLiveRun(summary: PropagationRunSummary): boolean {
  return summary.open > 0 || summary.partial > 0 || (summary.contradicted ?? 0) > 0;
}

/** How much of this run is still unabsorbed. */
function edgeScore(summary: PropagationRunSummary): number {
  return summary.open * 10 + summary.partial;
}

/** How many local days a run stays in the list on freshness alone. */
const RECENT_DAYS = 3;

/** Everything that transmitted has been priced in. */
function isFullyPriced(summary: PropagationRunSummary): boolean {
  return (
    summary.open === 0 &&
    summary.partial === 0 &&
    (summary.contradicted ?? 0) === 0 &&
    summary.priced > 0
  );
}

/**
 * How many names this run could actually put on the card. A run with none of
 * them has no second order to show.
 */
function showableNames(summary: PropagationRunSummary): number {
  return Math.max(0, summary.targets - summary.untracked);
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

/** Local calendar day — never UTC, or a late-evening event lands tomorrow. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Happened in the last `RECENT_DAYS` local days. */
export function isRecentRun(r: PropagationRunListItem, now: Date): boolean {
  const at = new Date(r.event_ts || r.produced_at);
  if (!Number.isFinite(at.getTime())) return false;
  const first = addDays(now, -(RECENT_DAYS - 1));
  return at.getTime() >= new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
}

/**
 * Every run worth showing, best first — the card opens on the head of this
 * list and the arrow walks the rest of it. Materiality first, then how much is
 * still unabsorbed, then freshness; run id breaks ties so the order doesn't
 * flicker between renders.
 *
 * Superseded runs are dropped here, which is what the desktop's
 * `currentOnly: true` does before the list ever reaches this function.
 */
export function orderRuns(
  runs: PropagationRunListItem[],
  now: Date = new Date(),
): PropagationRunListItem[] {
  const usable = runs.filter(
    (r) =>
      r.status !== "failed" &&
      !r.superseded &&
      (isLiveRun(r.summary) ||
        (isRecentRun(r, now) && !isFullyPriced(r.summary) && showableNames(r.summary) > 0)),
  );
  return [...usable].sort((a, b) => {
    const mat = MATERIALITY_RANK[b.event_materiality] - MATERIALITY_RANK[a.event_materiality];
    if (mat !== 0) return mat;
    const edge = edgeScore(b.summary) - edgeScore(a.summary);
    if (edge !== 0) return edge;
    const at = new Date(b.produced_at).getTime() - new Date(a.produced_at).getTime();
    if (at !== 0) return at;
    return a.run_id.localeCompare(b.run_id);
  });
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

export type DayCell = {
  /** Local YYYY-MM-DD. */
  date: string;
  /** Targets the network has not absorbed yet (open + partial). */
  open: number;
  /** Targets the move is already in. */
  priced: number;
  runs: number;
  /**
   * How far the day's propagations have travelled toward the moves they
   * called, as a mean signed share: negative while the names go the other
   * way, 1 when the called move has landed in full. Null when nothing on the
   * day can be measured.
   */
  priced_in: number | null;
};

/** The run's signed priced-in share, when the projection carried one. */
function runPricedInOf(r: PropagationRunListItem): number | null {
  return r.priced_in != null && Number.isFinite(r.priced_in) ? r.priced_in : null;
}

function tally(runs: PropagationRunListItem[]) {
  const byDay = new Map<
    string,
    { open: number; priced: number; runs: number; pricedInSum: number; measured: number }
  >();
  for (const r of runs) {
    if (r.status === "failed" || r.superseded) continue;
    // The field and the list answer to one rule: a run whose every edge the
    // judge vetoed did not propagate, so its day carries no mark.
    if (showableNames(r.summary) === 0) continue;
    const at = new Date(r.event_ts || r.produced_at);
    if (!Number.isFinite(at.getTime())) continue;
    const key = localDay(at);
    const cell = byDay.get(key) ?? { open: 0, priced: 0, runs: 0, pricedInSum: 0, measured: 0 };
    const pricedIn = runPricedInOf(r);
    // Every run the day carried shapes the cell, absorbed or not: the field is
    // the network's record, not its open book.
    cell.open += r.summary.open + r.summary.partial;
    cell.priced += r.summary.priced;
    cell.runs += 1;
    if (pricedIn != null) {
      cell.pricedInSum += pricedIn;
      cell.measured += 1;
    }
    byDay.set(key, cell);
  }
  return byDay;
}

/**
 * Weeks of days, oldest column first, each column running Sunday → Saturday.
 * The last column is the week `today` falls in, so the newest day sits at the
 * right edge and the width never shrinks to the data.
 */
export function buildCalendar(
  runs: PropagationRunListItem[],
  today: Date,
  weeks: number,
): DayCell[][] {
  const byDay = tally(runs);

  const endOfWeek = addDays(today, 6 - today.getDay());
  const start = addDays(endOfWeek, -(weeks * 7 - 1));

  const columns: DayCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const key = localDay(date);
      const hit = byDay.get(key);
      column.push({
        date: key,
        open: hit?.open ?? 0,
        priced: hit?.priced ?? 0,
        runs: hit?.runs ?? 0,
        priced_in: hit && hit.measured > 0 ? hit.pricedInSum / hit.measured : null,
      });
    }
    columns.push(column);
  }
  return columns;
}

/** Going the other way, deepening as it goes. */
const AGAINST_RAMP = ["#F6DADA", "#E9AFAF", "#D97F7F", "#C64F4F", "#A81C1C"];
/** Going the way it was called, deepening as the move lands and overshoots. */
const WITH_RAMP = ["#D6E3F7", "#AAC6EE", "#7BA2DF", "#4B79C9", "#22509E"];
/** Nothing has happened to it yet — the blank middle of the scale. */
const OPEN_WHITE = "#FFFFFF";
/** Something ran, but there is nothing to measure it with. */
const BALANCED = "#A9AEA6";
/** Nothing ran at all. */
const EMPTY = "#D8DBD4";

const PRICED_IN_RAMP = [
  AGAINST_RAMP[4],
  AGAINST_RAMP[3],
  AGAINST_RAMP[2],
  AGAINST_RAMP[1],
  AGAINST_RAMP[0],
  OPEN_WHITE,
  WITH_RAMP[0],
  WITH_RAMP[1],
  WITH_RAMP[2],
  WITH_RAMP[3],
  WITH_RAMP[4],
];

/**
 * The one scale, read from the share of the called move that has been
 * travelled: red at −1 (the whole of it, the wrong way), white at 0 (nothing
 * yet), blue at +1. `null` is "nothing to measure this by", which is neutral
 * rather than any point on the scale.
 */
export function pricedInColor(pricedIn: number | null | undefined): string {
  if (pricedIn == null || !Number.isFinite(pricedIn)) return BALANCED;
  const v = Math.max(-1, Math.min(1, pricedIn));
  return PRICED_IN_RAMP[Math.round(((v + 1) / 2) * (PRICED_IN_RAMP.length - 1))]!;
}

/** Grey means nothing propagated that day, and nothing else. */
export function dayColor(cell: DayCell): string {
  if (cell.runs === 0) return EMPTY;
  return pricedInColor(cell.priced_in);
}

/** The legend, densest against → nothing yet → densest priced. */
export const LEGEND_COLORS = [
  AGAINST_RAMP[4],
  AGAINST_RAMP[2],
  AGAINST_RAMP[0],
  OPEN_WHITE,
  WITH_RAMP[0],
  WITH_RAMP[2],
  WITH_RAMP[4],
];

/**
 * Where each month starts, as a column index — the label row along the top.
 * A month is only labelled if it has room, so `Aug Sep` never collides.
 */
export function monthTicks(columns: DayCell[][]): Array<{ column: number; label: string }> {
  const ticks: Array<{ column: number; label: string }> = [];
  let lastMonth = -1;
  let lastColumn = -99;
  columns.forEach((column, i) => {
    const first = new Date(`${column[0]!.date}T12:00:00`);
    if (!Number.isFinite(first.getTime())) return;
    const month = first.getMonth();
    if (month === lastMonth) return;
    lastMonth = month;
    // The first column is usually a partial month — skip its label, as GitHub
    // does, and never crowd two labels together.
    if (i === 0 || i - lastColumn < 3) return;
    lastColumn = i;
    ticks.push({ column: i, label: first.toLocaleString("en-US", { month: "short" }) });
  });
  return ticks;
}

/** Rows GitHub labels: Mon, Wed, Fri, with Sunday on top. */
export const WEEKDAY_TICKS: Array<{ row: number; label: string }> = [
  { row: 1, label: "Mon" },
  { row: 3, label: "Wed" },
  { row: 5, label: "Fri" },
];

// ---------------------------------------------------------------------------
// The cast under the headline
// ---------------------------------------------------------------------------

/**
 * The share of the called move a name has travelled, as the engine last
 * measured it: 1 is the whole of it, past 1 an overshoot, negative the other
 * way, null a name there is nothing to measure with. Verbatim from
 * `targetPricedIn` (packages/research/src/propagation/engine/progress.ts).
 */
export function targetPricedIn(t: PropagationTarget): number | null {
  const expected = t.pricing.expected_pct;
  if (expected == null || !Number.isFinite(expected) || expected <= 0) return null;
  const realized = t.pricing.realized_resid_pct ?? t.pricing.realized_raw_pct;
  if (realized == null || !Number.isFinite(realized)) return null;
  const direction = t.stage2?.direction ?? t.transmission.direction;
  const sign = direction === "positive" ? 1 : direction === "negative" ? -1 : 0;
  // Mixed or unclear: the engine compares magnitudes only, so nothing can
  // contradict and the travel is always forward.
  const travelled = sign === 0 ? Math.abs(realized) : realized * sign;
  return travelled / expected;
}

/**
 * The same share, measured against the price on screen right now — the
 * reference close and the called move are both fixed for the life of the run,
 * so only the last price changes, and the card is already streaming that.
 *
 * This is the RAW move: the engine's own figure subtracts the market's
 * contribution (beta times the benchmark), which needs a benchmark quote and a
 * beta that are not on the target. On a strong tape it reads a little high;
 * between sweeps it is the honest answer to "where is it now".
 */
export function livePricedIn(
  t: PropagationTarget,
  livePrice: number | null | undefined,
): number | null {
  const expected = t.pricing.expected_pct;
  if (expected == null || !Number.isFinite(expected) || expected <= 0) return null;
  const base = t.pricing.reference_close;
  if (base == null || !Number.isFinite(base) || base <= 0) return null;
  if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) return null;
  // A closed window is a closed verdict — the tape moving on afterwards is not
  // the call being absorbed, so the stored figure stands.
  if (t.pricing.status === "stale") return null;

  const realized = livePrice / base - 1;
  const direction = t.stage2?.direction ?? t.transmission.direction;
  const sign = direction === "positive" ? 1 : direction === "negative" ? -1 : 0;
  const travelled = sign === 0 ? Math.abs(realized) : realized * sign;
  return travelled / expected;
}

/** `+271%`, `−54%`, `0%` — or an em dash when there is nothing to measure. */
export function formatPricedIn(pricedIn: number | null | undefined): string {
  if (pricedIn == null || !Number.isFinite(pricedIn)) return "—";
  const p = Math.round(pricedIn * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`;
}

const TIER_RANK: Record<PropagationStrengthTier, number> = {
  critical: 3,
  important: 2,
  marginal: 1,
};

/**
 * How far a target's move has been priced in, 0–1 — the engine's own
 * `targetProgress` (packages/research/src/propagation/engine/progress.ts).
 */
function targetProgress(t: PropagationTarget): number {
  switch (t.pricing.status) {
    case "open":
      return 0;
    case "partial": {
      const r = t.pricing.ratio;
      return r == null || !Number.isFinite(r) ? 0.5 : Math.max(0.15, Math.min(0.85, r));
    }
    case "priced":
    case "stale":
      return 1;
    default:
      return 0.5;
  }
}

/**
 * The run's related names worth a row: tracked, with a ticker, not vetoed —
 * strongest relationship first, and within a tier the still-open ones first.
 * One row per tradable name: a counterparty can hold two roles toward the root
 * at once, and showing both put a long and a short on the same ticker.
 */
export function cardTargets(run: PropagationRun, limit: number): PropagationTarget[] {
  const usable = run.targets.filter(
    (t) => t.tracked && t.ticker != null && t.stage2?.verdict !== "vetoed",
  );
  const ranked = [...usable].sort((a, b) => {
    const tier = TIER_RANK[b.relationship.tier] - TIER_RANK[a.relationship.tier];
    if (tier !== 0) return tier;
    const prog = targetProgress(a) - targetProgress(b);
    if (prog !== 0) return prog;
    return (a.ticker ?? "").localeCompare(b.ticker ?? "");
  });
  const seen = new Set<string>();
  const once: PropagationTarget[] = [];
  for (const target of ranked) {
    const key = (target.ticker ?? "").toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    once.push(target);
  }
  return once.slice(0, limit);
}
