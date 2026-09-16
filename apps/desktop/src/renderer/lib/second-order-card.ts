import type { PairHistoryEvent } from "../../shared/propagation-pair";
import type {
  PropagationDirection,
  PropagationMateriality,
  PropagationRole,
  PropagationRun,
  PropagationRunListItem,
  PropagationTarget,
} from "../../shared/propagation-run-types";

/**
 * Selection and calendar shaping for the second-order card. Pure functions,
 * no React and no fetching — which run the card speaks for, and how the
 * network's days read as a field of dots, both have to be decidable on their
 * own.
 */

const MATERIALITY_RANK: Record<PropagationMateriality, number> = {
  high: 3,
  standard: 2,
  low: 1,
};

/**
 * The one visibility rule for propagations, shared by the ripple list and the
 * dashboard card: a run is shown while it still has something to say —
 * an open target, a partially absorbed one, or one the tape moved AGAINST
 * (`contradicted`, P3). Only the fully resolved runs are hidden: everything
 * priced, or nothing that transmitted at all.
 *
 * `no_edge` is deliberately not the test. The engine computes it as
 * `open === 0 && partial === 0`, which is true for a contradicted-only run —
 * a refuted thesis is not an absorbed one, and hiding it would bury the
 * calibration signal it exists to raise.
 */
export function isLiveRun(summary: PropagationRunListItem["summary"]): boolean {
  return summary.open > 0 || summary.partial > 0 || (summary.contradicted ?? 0) > 0;
}

export type RunBadge = {
  /** Rail label, e.g. "2 CONTRADICTED". */
  word: string;
  tone: "open" | "against" | "partial" | "priced" | "none";
};

/**
 * A run's own badge, by the priority of what its targets are doing:
 * open > contradicted > partial > priced > no edge. One rule, so the rail,
 * the card and any future surface never disagree about what a run is.
 */
export function runBadge(summary: PropagationRunListItem["summary"]): RunBadge {
  if (summary.open > 0) return { word: `${summary.open} OPEN`, tone: "open" };
  const contradicted = summary.contradicted ?? 0;
  if (contradicted > 0) return { word: `${contradicted} CONTRADICTED`, tone: "against" };
  if (summary.partial > 0) return { word: `${summary.partial} PARTIAL`, tone: "partial" };
  if (summary.priced > 0) return { word: `${summary.priced} PRICED`, tone: "priced" };
  return { word: "NO EDGE", tone: "none" };
}

/** How much of this run is still unabsorbed — the engine's `no_edge` test. */
function edgeScore(summary: PropagationRunListItem["summary"]): number {
  return summary.open * 10 + summary.partial;
}

/** How many local days a run stays in the list on freshness alone: today and
 *  the two before it. */
const RECENT_DAYS = 3;

/**
 * Everything that transmitted has been priced in. This is the only reading of
 * "fully priced" — a run with nothing measurable on it (no reference close,
 * no basis) is emphatically not this one, however quiet it looks.
 */
function isFullyPriced(summary: PropagationRunListItem["summary"]): boolean {
  return (
    summary.open === 0 &&
    summary.partial === 0 &&
    (summary.contradicted ?? 0) === 0 &&
    summary.priced > 0
  );
}

/**
 * How many names this run could actually put on the card. The summary counts
 * the targets stage 2 did not veto, and `untracked` those among them the
 * pricing layer has no series for; what is left is what `cardTargets` finds.
 *
 * A run with none of them has no second order to show — the graph reached
 * companies and the judge kept none of them, or none can be priced. It is not
 * an unfinished event, it is an event that goes nowhere.
 */
function showableNames(summary: PropagationRunListItem["summary"]): number {
  return Math.max(0, summary.targets - summary.untracked);
}

/**
 * Happened in the last `RECENT_DAYS` local days. Local, and by whole days, so
 * this rolls over at midnight together with the field of dots below the card
 * rather than at UTC or on a sliding 72 hours.
 */
export function isRecentRun(r: PropagationRunListItem, now: Date): boolean {
  const at = new Date(r.event_ts || r.produced_at);
  if (!Number.isFinite(at.getTime())) return false;
  const first = addDays(now, -(RECENT_DAYS - 1));
  return at.getTime() >= new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
}

/**
 * Every run worth showing, best first — the card opens on the head of this
 * list and the arrow walks the rest of it. Materiality first (the engine's own
 * read of how much the event matters), then how much is still unabsorbed, then
 * freshness. Run id breaks ties so the order doesn't flicker between renders.
 *
 * Membership is `isLiveRun` plus a freshness clause: an event of the last few
 * days that has not been fully priced in belongs on the card even when the
 * engine has nothing to measure it by yet. Those runs are the ones the pricing
 * layer has not had a session to answer — dropping them meant the newest
 * events were the ones you could not read (Kuzey, 2026-08-25).
 *
 * The clause still asks for a name to show. A fresh run whose targets were all
 * vetoed reads as an unpriced event but is the opposite of one: the judge said
 * it carries nothing, and headlining it put an event on the card with an empty
 * cast underneath (Kuzey, 2026-08-25).
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
    const mat =
      MATERIALITY_RANK[b.event_materiality] - MATERIALITY_RANK[a.event_materiality];
    if (mat !== 0) return mat;
    const edge = edgeScore(b.summary) - edgeScore(a.summary);
    if (edge !== 0) return edge;
    const at = new Date(b.produced_at).getTime() - new Date(a.produced_at).getTime();
    if (at !== 0) return at;
    return a.run_id.localeCompare(b.run_id);
  });
}

export function pickRun(runs: PropagationRunListItem[]): PropagationRunListItem | null {
  return orderRuns(runs)[0] ?? null;
}

/** `Aug 22, 11:08 PM` */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.toLocaleString("en-US", { month: "short", day: "numeric" })}, ${d.toLocaleString(
    "en-US",
    { hour: "2-digit", minute: "2-digit", hour12: true },
  )}`;
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

/** Steps on each side of the ramp. */
const LEVELS = 5;

/** Never draw a grid narrower than this, however young the store is. */

export type DayTone = "open" | "priced" | "balanced" | "empty";

/** One propagation on a day, for the hover list: dark green while more of it
 *  is still unpriced (open + partial) than priced, dark pink once the move is
 *  in, and neutral while there is nothing to measure it against — the same
 *  three readings the cells themselves use. */
export type DayRunItem = {
  run_id: string;
  root_ticker: string;
  event_label: string;
  open: number;
  priced: number;
  /** Signed share of the called move travelled; null when unmeasurable. */
  priced_in: number | null;
};

export type DayCell = {
  /** Local YYYY-MM-DD. */
  date: string;
  /** Targets the network has not absorbed yet (open + partial). */
  open: number;
  /** Targets the move is already in. */
  priced: number;
  runs: number;
  tone: DayTone;
  /** 0 for empty, 1–LEVELS for how far the day leans. */
  level: number;
  /**
   * How far the day's propagations have travelled toward the moves they
   * called, as a mean signed share: 0 when nothing has happened, negative
   * while the names are going the other way, 1 when the called move has
   * landed in full. Drives the colour — red, green, blue. Null when nothing
   * on the day can be measured.
   */
  priced_in: number | null;
  /** The day's visible propagations, newest first. */
  items: DayRunItem[];
};

/** Local calendar day — never UTC, or a late-evening event lands tomorrow. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

/**
 * A day's balance. `partial` sits on the open side deliberately: the engine's
 * own no-edge test is `open === 0 && partial === 0`, so a partially absorbed
 * move is still an unabsorbed one.
 */

/** The run's signed priced-in share, when the projection carried one. */
function runPricedInOf(r: PropagationRunListItem): number | null {
  return r.priced_in != null && Number.isFinite(r.priced_in) ? r.priced_in : null;
}

function tally(
  runs: PropagationRunListItem[],
): Map<
  string,
  {
    open: number;
    partial: number;
    priced: number;
    runs: number;
    pricedInSum: number;
    measured: number;
    items: DayRunItem[];
  }
> {
  const byDay = new Map<
    string,
    {
      open: number;
      partial: number;
      priced: number;
      runs: number;
      pricedInSum: number;
      measured: number;
      items: DayRunItem[];
    }
  >();
  for (const r of runs) {
    if (r.status === "failed" || r.superseded) continue;
    // The field and the list answer to one rule. A run whose every edge the
    // judge vetoed did not propagate — drawing its day put a mark on the
    // field that nothing in the card could ever take you to (Kuzey,
    // 2026-08-25).
    if (showableNames(r.summary) === 0) continue;
    const at = new Date(r.event_ts || r.produced_at);
    if (!Number.isFinite(at.getTime())) continue;
    const key = localDay(at);
    const cell =
      byDay.get(key) ??
      { open: 0, partial: 0, priced: 0, runs: 0, pricedInSum: 0, measured: 0, items: [] };
    const pricedIn = runPricedInOf(r);
    // Every run the day carried shapes the cell, absorbed or not: the field
    // is the network's record, not its open book, so a fully priced-in run
    // still colours its day — pink, which is what the ramp is for. The
    // ripple list's live rule still decides which run the headline speaks
    // for; see `orderRuns`.
    cell.open += r.summary.open + r.summary.partial;
    cell.partial += r.summary.partial;
    cell.priced += r.summary.priced;
    cell.runs += 1;
    if (pricedIn != null) {
      cell.pricedInSum += pricedIn;
      cell.measured += 1;
    }
    cell.items.push({
      run_id: r.run_id,
      root_ticker: r.root_ticker,
      event_label: r.event_label,
      open: r.summary.open + r.summary.partial,
      priced: r.summary.priced,
      // Same number, same scale, same colour as the cell it sits under.
      priced_in: pricedIn,
    });
    cell.items.sort((a, b) => b.run_id.localeCompare(a.run_id));
    byDay.set(key, cell);
  }
  return byDay;
}

/**
 * Weeks of days, oldest column first, each column running Sunday → Saturday —
 * the shape GitHub taught everyone to read. The last column is the week
 * `today` falls in, so the newest day sits at the right edge.
 *
 * Every run with a name to show counts, however far it has travelled: the
 * field is the whole record, not just the open book, and it holds to the same
 * membership as the list the arrow walks — so no day is drawn that the card
 * cannot take you to.
 */
export function buildCalendar(
  runs: PropagationRunListItem[],
  today: Date,
  weeks: number,
): DayCell[][] {
  const byDay = tally(runs);

  // The strongest single day sets the scale, with a floor so one lone event
  // doesn't render at full strength and imply a busy day.
  let peak = 0;
  for (const v of byDay.values()) peak = Math.max(peak, v.open, v.priced);
  const denom = Math.max(4, peak);

  // A fixed window: the last column is the week today falls in (newest day at
  // the right edge), the first is `weeks` back — the width never shrinks to
  // the data, so the frame reads the same every day.
  const endOfWeek = addDays(today, 6 - today.getDay());
  const span = weeks;
  const start = addDays(endOfWeek, -(span * 7 - 1));

  const columns: DayCell[][] = [];
  for (let w = 0; w < span; w++) {
    const column: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const key = localDay(date);
      const hit = byDay.get(key);
      const open = hit?.open ?? 0;
      const priced = hit?.priced ?? 0;
      const runCount = hit?.runs ?? 0;

      // The day's runs, averaged: each run's ratio-based absorption (the
      // same number the card's target list shows per name), so a day with
      // one open run is the darkest green and climbs to pink as its targets
      // reach their prices.
      const pricedIn = hit && hit.measured > 0 ? hit.pricedInSum / hit.measured : null;

      let tone: DayTone;
      let level = 0;
      if (runCount === 0) {
        tone = "empty";
      } else if (open === priced) {
        // Something happened; the day just doesn't lean either way.
        tone = "balanced";
        level = 1;
      } else {
        tone = open > priced ? "open" : "priced";
        const count = Math.max(open, priced);
        level = Math.min(LEVELS, Math.max(1, Math.ceil((LEVELS * count) / denom)));
      }
      column.push({
        date: key,
        open,
        priced,
        runs: runCount,
        tone,
        level,
        priced_in: pricedIn,
        items: hit?.items ?? [],
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
/** Nothing has happened to it yet — the blank middle of the scale, and the
 *  one cell that is lighter than the empty grey around it. */
const OPEN_WHITE = "#FFFFFF";
/** Something ran, but there is nothing to measure it with. */
const BALANCED = "#A9AEA6";
/** Nothing ran at all. */
const EMPTY = "#D8DBD4";

/**
 * The one scale, read from the share of the called move that has been
 * travelled: red at −1 (the whole of it, the wrong way), white at 0 (nothing
 * yet), blue at +1 (the whole of it, the right way). A short called at 5%
 * starts white, reddens as the stock rises, comes back through white as it
 * falls, and turns blue as the fall approaches — and then passes — that 5%.
 *
 * The colour saturates at ±1; the number beside it carries any overshoot.
 */
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
 * Ramp colour for a signed priced-in share. `null` is "nothing to measure
 * this by", which is neutral rather than any point on the scale.
 */
export function pricedInColor(pricedIn: number | null | undefined): string {
  if (pricedIn == null || !Number.isFinite(pricedIn)) return BALANCED;
  const v = Math.max(-1, Math.min(1, pricedIn));
  return PRICED_IN_RAMP[Math.round(((v + 1) / 2) * (PRICED_IN_RAMP.length - 1))];
}

/** `+271%`, `−54%`, `0%` — never rounded into a bound the reader can't see past. */
/**
 * The share-of-the-called-move figure, spelled out.
 *
 * The row shows a ratio and nothing else, so there is no way to see what the
 * called move actually was, how far the name has come, or — the one that
 * caused real confusion — WHEN it was last measured. A ratio computed days
 * ago sits next to a quote from a second ago and looks equally live. Naming
 * the as-of date makes a frozen number say so.
 */
export function pricedInDetail(target: PropagationTarget): string {
  const p = target.pricing;
  const pct = (x: number | null | undefined) =>
    x == null || !Number.isFinite(x) ? null : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;

  const realized = pct(p.realized_resid_pct ?? p.realized_raw_pct);
  const expected = pct(p.expected_pct);
  if (!realized || !expected) return "nothing to measure this by yet";

  const lines = [`moved ${realized} of the ${expected} called move`];
  if (p.basis === "residual") {
    lines.push("measured after the market's own move is removed");
  } else if (p.basis === "raw") {
    lines.push("raw move — no market adjustment available");
  }
  if (p.reference_close != null) {
    const from = p.reference_close_ts ? ` on ${p.reference_close_ts.slice(0, 10)}` : "";
    lines.push(`from ${p.reference_close.toFixed(2)}${from}`);
  }
  if (p.last_price != null) {
    const at = p.last_price_ts ? ` (as of ${p.last_price_ts.slice(0, 10)})` : "";
    lines.push(`to ${p.last_price.toFixed(2)}${at}`);
  }
  if (p.status === "stale") lines.push("window closed — this is final");
  return lines.join(" · ");
}

export function formatPricedIn(pricedIn: number | null | undefined): string {
  if (pricedIn == null || !Number.isFinite(pricedIn)) return "—";
  const p = Math.round(pricedIn * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`;
}

/**
 * Grey means nothing propagated that day, and nothing else.
 *
 * A day whose runs carry no countable exposure — no reference close, no
 * basis, or the whole run gone stale — still shows, but neutral. It is not an
 * open day: the engine cannot say the move is outstanding, only that it
 * cannot measure it. Painting those green claimed an open window the card's
 * own headline would then deny (Kuzey, 2026-08-25).
 */
export function dayColor(cell: DayCell): string {
  if (cell.runs === 0) return EMPTY;
  return pricedInColor(cell.priced_in);
}

/** The legend, densest priced → balanced → densest open. */
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
    const first = new Date(`${column[0].date}T12:00:00`);
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

/** `Aug 21 · 4 open · 1 priced in` */
export function dayLabel(cell: DayCell): string {
  const d = new Date(`${cell.date}T12:00:00`);
  const when = Number.isFinite(d.getTime())
    ? d.toLocaleString("en-US", { month: "short", day: "numeric" })
    : cell.date;
  if (cell.items.length === 0) return `${when} · nothing propagated`;
  const share =
    cell.priced_in == null
      ? "nothing to measure it by yet"
      : `${formatPricedIn(cell.priced_in)} of the called move`;
  // Nothing countable on either side yet — say how many ran rather than
  // claiming zero of each.
  if (cell.open === 0 && cell.priced === 0) {
    return `${when} · ${cell.runs} propagation${cell.runs === 1 ? "" : "s"} · ${share}`;
  }
  return `${when} · ${cell.open} open · ${cell.priced} priced in · ${share}`;
}

// ---------------------------------------------------------------------------
// One pair's history, as the same field of days
// ---------------------------------------------------------------------------

/**
 * The calendar again, but for a single pair: one cell per day, coloured by how
 * far that day's calls on this name travelled to their targets. Unlike the
 * card's field this keeps resolved days — the whole point here is the record,
 * so a long-absorbed call still has to show.
 */
export function buildPairCalendar(
  events: PairHistoryEvent[],
  today: Date,
  weeks: number,
  root = "",
): DayCell[][] {
  const byDay = new Map<
    string,
    { open: number; priced: number; pricedInSum: number; measured: number; items: DayRunItem[] }
  >();
  for (const e of events) {
    const at = new Date(e.event_ts);
    if (!Number.isFinite(at.getTime())) continue;
    const key = localDay(at);
    const cell = byDay.get(key) ?? { open: 0, priced: 0, pricedInSum: 0, measured: 0, items: [] };
    // "Open" is the engine's own word for a call the market hasn't answered
    // yet; everything else — right, wrong or expired — is a closed day.
    if (e.outcome === "open") cell.open += 1;
    else cell.priced += 1;
    if (e.priced_in != null && Number.isFinite(e.priced_in)) {
      cell.pricedInSum += e.priced_in;
      cell.measured += 1;
    }
    cell.items.push({
      run_id: e.run_id,
      root_ticker: root,
      event_label: e.event_label,
      open: e.outcome === "open" ? 1 : 0,
      priced: e.outcome === "open" ? 0 : 1,
      priced_in: e.priced_in,
    });
    byDay.set(key, cell);
  }

  const endOfWeek = addDays(today, 6 - today.getDay());
  const start = addDays(endOfWeek, -(weeks * 7 - 1));

  const columns: DayCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const key = localDay(date);
      const hit = byDay.get(key);
      const runs = hit ? hit.items.length : 0;
      const open = hit?.open ?? 0;
      const priced = hit?.priced ?? 0;
      const pricedIn =
        hit && hit.measured > 0 ? hit.pricedInSum / hit.measured : null;
      const tone: DayTone =
        runs === 0 ? "empty" : open === priced ? "balanced" : open > priced ? "open" : "priced";
      column.push({
        date: key,
        open,
        priced,
        runs,
        tone,
        level: runs === 0 ? 0 : Math.min(LEVELS, Math.max(1, runs)),
        priced_in: pricedIn,
        items: hit?.items ?? [],
      });
    }
    columns.push(column);
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

/**
 * A full field of dots for presentations (Ctrl+P): most days carry
 * propagations, weekdays busier than weekends, and the called move has
 * travelled further the older the day — the left edge of the grid is deep
 * blue (long since priced in), the right edge blank (nothing yet), with a
 * noisy ramp between them and the odd red day that went the other way.
 * `rand` is the demo seed's generator, so the field is stable while demo is on.
 */
const DEMO_EVENT_LABELS = [
  "guides above consensus",
  "supply agreement",
  "outlook cut",
  "buyback",
  "export restrictions",
  "earnings beat",
];

export function buildDemoCalendar(
  rand: () => number,
  today: Date,
  weeks: number,
  tickers: string[] = ["NVDA", "AAPL", "MSFT", "TSM", "AVGO"],
): DayCell[][] {
  const endOfWeek = addDays(today, 6 - today.getDay());
  const start = addDays(endOfWeek, -(weeks * 7 - 1));
  const total = weeks * 7;
  const todayKey = localDay(today);

  const columns: DayCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const index = w * 7 + d;
      const date = addDays(start, index);
      const key = localDay(date);
      const weekend = d === 0 || d === 6;
      const future = key > todayKey;

      // Weekdays almost always see something; weekends less often.
      const active = !future && rand() < (weekend ? 0.45 : 0.88);
      if (!active) {
        column.push({ date: key, open: 0, priced: 0, runs: 0, tone: "empty", level: 0, priced_in: null, items: [] });
        continue;
      }

      // Age 1 at the left edge → 0 today. Progress follows it with a little
      // noise, so the pink deepens steadily toward the left.
      const age = 1 - index / (total - 1);
      const progress = Math.max(0, Math.min(1, Math.pow(age, 0.8) + (rand() - 0.5) * 0.22));
      const runs = 1 + Math.floor(rand() * (weekend ? 2 : 4));
      const exposure = runs * (2 + Math.floor(rand() * 5));
      const priced = Math.round(exposure * progress);
      const open = exposure - priced;
      // Mostly travelling the right way, with the occasional day that went
      // against the call — the scale has to show both.
      const pricedIn = rand() < 0.12 ? -progress : progress;

      // One square per propagation in the hover grid, split so the day's
      // priced/open balance is what the squares show.
      const items: DayRunItem[] = [];
      for (let i = 0; i < runs; i++) {
        const share = exposure / runs;
        const itemPriced = Math.round(share * Math.max(0, Math.min(1, progress + (rand() - 0.5) * 0.4)));
        const itemOpen = Math.max(0, Math.round(share) - itemPriced);
        items.push({
          run_id: `demo-${key}-${i}`,
          root_ticker: tickers[Math.floor(rand() * tickers.length)] ?? "NVDA",
          event_label: DEMO_EVENT_LABELS[Math.floor(rand() * DEMO_EVENT_LABELS.length)],
          open: itemOpen,
          priced: itemPriced,
          priced_in: pricedIn + (rand() - 0.5) * 0.3,
        });
      }

      let tone: DayTone;
      if (open === priced) tone = "balanced";
      else tone = open > priced ? "open" : "priced";
      const level = Math.min(LEVELS, Math.max(1, Math.ceil((LEVELS * Math.max(open, priced)) / 12)));

      column.push({ date: key, open, priced, runs, tone, level, priced_in: pricedIn, items });
    }
    columns.push(column);
  }
  return columns;
}

// ---------------------------------------------------------------------------
// The related names under the calendar
// ---------------------------------------------------------------------------

const TIER_RANK: Record<PropagationTarget["relationship"]["tier"], number> = {
  critical: 3,
  important: 2,
  marginal: 1,
};

/** Short, human role for a row — "supplier", "customer"… */
export function roleLabel(role: PropagationTarget["relationship"]["role"]): string {
  switch (role) {
    case "depended_on_by":
      return "depends on it";
    case "dependency":
      return "dependency";
    default:
      return role;
  }
}

/**
 * How far a target's move has been priced in, 0–1: open 0, partial by the
 * engine's realised/expected ratio (held inside the bar so it never reads as
 * fully open or fully priced), priced and stale 1 — stale is no longer open.
 */
import { targetProgress } from "../../shared/propagation-progress";
export { targetProgress };

/**
 * The run's related names worth a row: tracked, with a ticker, not vetoed —
 * strongest relationship first, and within a tier the still-open ones first.
 */
export function cardTargets(run: PropagationRun, limit: number): PropagationTarget[] {
  const usable = run.targets.filter(
    (t) => t.tracked && t.ticker != null && t.stage2?.verdict !== "vetoed",
  );
  const ranked = [...usable]
    .sort((a, b) => {
      const tier = TIER_RANK[b.relationship.tier] - TIER_RANK[a.relationship.tier];
      if (tier !== 0) return tier;
      const prog = targetProgress(a) - targetProgress(b);
      if (prog !== 0) return prog;
      return (a.ticker ?? "").localeCompare(b.ticker ?? "");
    });
  // One row per tradable name. A counterparty can hold two roles toward the
  // root at once — partner and competitor — and the matrix reads those two
  // cells in opposite directions, which put a long and a short on the same
  // ticker next to each other on the card. The engine now collapses them at
  // the source (collapseEntities); this keeps runs produced before that fix
  // honest too, by showing the strongest relationship — the head of the sort.
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

// ---------------------------------------------------------------------------
// Why a name is here, in plain words
// ---------------------------------------------------------------------------

/** How the link reads as a sentence — the engine's role, said out loud. */
function linkSentence(ticker: string, root: string, role: PropagationRole): string {
  switch (role) {
    case "supplier":
      return `${ticker} supplies ${root}`;
    case "customer":
      return `${ticker} buys from ${root}`;
    case "competitor":
      return `${ticker} competes with ${root}`;
    case "partner":
      return `${ticker} partners with ${root}`;
    case "dependency":
      return `${root} depends on ${ticker}`;
    case "depended_on_by":
      return `${ticker} depends on ${root}`;
  }
}

/** "a critical link", but "an important link". */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** `-1.14%` / `+2.40%` — a signed move, or null when there is none to show. */
function signedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  // The same minus glyph pricedInDetail uses, so the panel's sentence and its
  // footnote do not print the same number two different ways.
  return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(2)}%`;
}

function sizePct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${(Math.abs(value) * 100).toFixed(1)}%`;
}

/**
 * The engine writes a mechanism as "<the event>. <the relationship>. Transmits
 * <tier> <direction>." On this card the first of those is already the
 * headline and the last is already the expected line, so printed whole it
 * says both of them twice. Keep the middle — the part that says how the event
 * actually reaches this name — and leave anything that doesn't fit the shape
 * alone.
 */
function trimMechanism(mechanism: string, root: string, eventLabel: string): string {
  let text = mechanism.trim();
  for (const prefix of [`${root} ${eventLabel}`, eventLabel]) {
    const head = prefix.trim();
    if (head && text.toLowerCase().startsWith(head.toLowerCase())) {
      text = text.slice(head.length).replace(/^[.;:,\s]+/, "");
      break;
    }
  }
  // "Transmits weakly negative." — the expected line says this in words.
  text = text.replace(/\s*Transmits\b[^.]*\.?\s*$/i, "").trim();
  return text;
}

export type TargetExplanation = {
  /**
   * Why the event reaches this name: the engine's own mechanism, trimmed of
   * what the card already says elsewhere — or a plain sentence built from the
   * relationship when the run carries no mechanism.
   */
  why: string;
  /** "Expected to move lower, about 2.4%." */
  expected: string;
  /** Which way that expectation points, for colour. */
  direction: PropagationDirection;
  /** Where the tape stands against it. */
  tape: string;
};

/**
 * The hover explanation for one related name: why the event reaches it, what
 * the engine expects of it, and how much of that the tape has already done.
 * Every sentence is derived from the run — nothing here is invented, and a
 * missing number is said to be missing rather than filled in. `pricedIn` is
 * the same signed share the row's chip shows, passed in so the two can never
 * disagree.
 */
export function targetExplain(
  t: PropagationTarget,
  run: { root_ticker: string; event: { label: string } },
  pricedIn: number | null,
): TargetExplanation {
  const ticker = (t.ticker ?? t.label).toUpperCase();
  const rootTicker = run.root_ticker.toUpperCase();
  const tier = t.relationship.tier;
  const link = `${linkSentence(ticker, rootTicker, t.relationship.role)} — ${article(tier)} ${tier} link.`;
  // The engine's own words where it has them; the plain sentence otherwise.
  const trimmed = trimMechanism(t.mechanism ?? "", rootTicker, run.event.label);
  const why = trimmed || link;

  // Stage 2 is the judge's resolved call and outranks the matrix's reading.
  const direction = t.stage2?.direction ?? t.transmission.direction;
  const size = sizePct(t.pricing.expected_pct);
  let expected: string;
  if (direction === "positive" || direction === "negative") {
    const way = direction === "positive" ? "higher" : "lower";
    expected = size ? `Expected to move ${way}, about ${size}.` : `Expected to move ${way}.`;
  } else if (direction === "mixed") {
    expected = size
      ? `Could move either way — about ${size} of movement is what the link implies.`
      : "Could move either way — only the size of the move is judged.";
  } else {
    expected = size
      ? `Direction unclear — the link implies about ${size} of movement, either way.`
      : "Direction unclear — only the size of the move is judged.";
  }
  if (t.transmission.transmits === "weak") {
    expected += " The link transmits weakly, so expect a muted move.";
  }

  // The tape sentence reads off the very number the row shows, so the card
  // can never say "85% of the called move" beside a "-225%" chip. Signed:
  // negative is a move against the call, past 100% is an overshoot.
  const moved = signedPct(t.pricing.realized_resid_pct ?? t.pricing.realized_raw_pct);
  const sessions = t.pricing.sessions_elapsed;
  const sessionTail =
    sessions != null && sessions > 0 ? ` ${sessions} session${sessions === 1 ? "" : "s"} in.` : "";
  const share = pricedIn == null || !Number.isFinite(pricedIn) ? null : Math.round(pricedIn * 100);
  let tape: string;
  if (t.pricing.status === "stale") {
    tape = "The window has closed — treat it as priced.";
  } else if (share == null) {
    tape =
      t.pricing.status === "open"
        ? `The market has not priced this in yet.${sessionTail}`
        : "No usable price for this name yet.";
  } else if (share < 0) {
    tape = moved
      ? `Moved ${moved} — the wrong way, ${Math.abs(share)}% of the called move against the call.`
      : `Moving against the call — ${Math.abs(share)}% of it, the wrong way.`;
  } else if (share <= 2) {
    tape = `The market has not priced this in yet.${sessionTail}`;
  } else if (share < 85) {
    tape = moved
      ? `Moved ${moved} so far — about ${share}% of the called move.${sessionTail}`
      : `About ${share}% of the called move has arrived.${sessionTail}`;
  } else if (share <= 115) {
    tape = moved ? `Moved ${moved} — the called move has arrived.` : "The called move has arrived.";
  } else {
    tape = moved
      ? `Moved ${moved} — ${share}% of the called move, more than was called for.`
      : `${share}% of the called move — more than was called for.`;
  }

  return { why, expected, direction, tape };
}
