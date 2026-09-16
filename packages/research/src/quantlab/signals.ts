/**
 * Signal generation (§6) — where a rule meets history.
 *
 * For each candidate (ticker, session) the trigger is evaluated AS OF that
 * session, the filters are applied, and a surviving candidate becomes a signal
 * with its entry price and forward returns.
 *
 * Two things here carry most of the honesty:
 *
 * 1. Entry-timing enforcement. A release accepted after the close is not
 *    information you had at that close, so a `signal_close` strategy cannot
 *    trade it. Those candidates are DROPPED and counted, never silently shifted
 *    to the next open — shifting them would quietly convert an impossible trade
 *    into a possible one, which is the exact failure this engine exists to
 *    prevent.
 *
 * 2. Every window is `≤ session`. The series, the graph and the earnings
 *    calendar are each cut at the signal session by their own module, so no
 *    single place has to remember to do it.
 */

import type { GraphIndex } from "../propagation/engine/graph.js";
import type { ScreenConfig } from "../screen/config.js";
import type { GaugeConfig } from "../gauge/config.js";
import type { ScreenPattern } from "../screen/types.js";
import type { TradingCalendar } from "./calendar.js";
import { earningsWithin, type FilingEvent } from "./filings.js";
import { setupAsOf } from "./gauge-asof.js";
import { neighboursOf } from "./graph-asof.js";
import { computeHorizonReturn, resolveWindow, sectorMedianReturn, type ReturnContext } from "./returns.js";
import { consecutiveSessions, evaluatePatternAsOf } from "./screen-asof.js";
import { snapshotAt } from "./series.js";
import { median } from "./stats.js";
import type { Exclusion, QuantSeries, QuantSnapshot, Signal, Strategy, StrategyFilter } from "./types.js";

export type SignalGenDeps = {
  strategy: Strategy;
  ctx: ReturnContext;
  calendar: TradingCalendar;
  screenConfig: ScreenConfig;
  gaugeConfig: GaugeConfig;
  r2Floor: number;
  graph: GraphIndex;
  /** All 8-K events per ticker, oldest first. */
  filingsByTicker: Map<string, FilingEvent[]>;
  /** Item-2.02 events per ticker, oldest first. */
  earningsByTicker: Map<string, FilingEvent[]>;
  earningsKnowledgeHorizonSessions: number;
  universe: string[];
  from: string;
  to: string;
};

export type SignalGenResult = {
  signals: Signal[];
  excluded: Exclusion[];
  /** Candidates dropped because the event was not public at the entry instant. */
  entry_timing_rejected: number;
  /** Candidates dropped by each filter — shows which clause is doing the work. */
  filter_rejections: Record<string, number>;
  /**
   * Signals whose direction the trigger actually supplied, versus those that
   * fell back to long. An all-fallback count means a "directional" strategy is
   * really a long-only one wearing a different name.
   */
  direction_from_trigger: number;
  direction_fallback_long: number;
};

type Candidate = {
  ticker: string;
  session: string;
  reason: string;
  /** Direction the rule expects, before `direction.kind` resolves it. */
  direction: 1 | -1 | null;
  /** True when the triggering event only became public after the session close. */
  after_close: boolean;
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Median dollar volume over the `window` sessions ending at (and including) `at`. */
export function dollarVolume(series: QuantSeries, at: number, window: number): number | null {
  if (at + 1 < window) return null;
  const values: number[] = [];
  for (let i = at + 1 - window; i <= at; i++) {
    const snap = series.snapshots[i];
    if (!(snap.close > 0) || !(snap.volume > 0)) return null;
    values.push(snap.close * snap.volume);
  }
  return median(values);
}

/**
 * How far the session moved relative to its own daily volatility, measured
 * against the sector so a whole-sector move does not read as a stock-specific
 * one. Falls back to the raw move when the sector is too thin to be a
 * benchmark.
 */
function movedRatio(deps: SignalGenDeps, ticker: string, session: string, snap: QuantSnapshot): number | null {
  if (snap.ret == null || snap.daily_vol == null || !(snap.daily_vol > 0)) return null;
  const peers = sectorMedianReturn(deps.ctx, ticker, sessionWindow(deps.calendar, session));
  const own = peers.value != null ? snap.ret - peers.value : snap.ret;
  return Math.abs(own) / snap.daily_vol;
}

/** Prior close → this close: the window whose return IS this session's move. */
function sessionWindow(calendar: TradingCalendar, session: string) {
  return {
    signal: session,
    entry: calendar.shift(session, -1) ?? session,
    exit: session,
    when: "signal_close" as const,
  };
}

function passesFilter(
  filter: StrategyFilter,
  deps: SignalGenDeps,
  ticker: string,
  session: string,
  series: QuantSeries,
  index: number,
  snap: QuantSnapshot,
): boolean {
  switch (filter.kind) {
    case "r2_floor":
      return snap.r2 != null && snap.r2 >= filter.min;
    case "vol_regime":
      return snap.vol_regime != null && snap.vol_regime <= filter.max;
    case "liquidity": {
      const dv = dollarVolume(series, index, 20);
      return dv != null && dv >= filter.min_dollar_volume_20d;
    }
    case "no_earnings_within": {
      const earnings = deps.earningsByTicker.get(ticker) ?? [];
      return !earningsWithin(
        session,
        filter.sessions,
        earnings,
        deps.calendar,
        deps.earningsKnowledgeHorizonSessions,
      );
    }
    case "unpriced": {
      const ratio = movedRatio(deps, ticker, session, snap);
      return ratio != null && ratio < filter.max_ratio;
    }
  }
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** `8k_item_2.02` and a bare `2.02` both name the same item code. */
function itemCodesOf(types: string[]): string[] {
  return types.map((t) => (t.startsWith("8k_item_") ? t.slice("8k_item_".length) : t));
}

function matchingItems(event: FilingEvent, types: string[]): string[] {
  const wanted = new Set(itemCodesOf(types));
  return event.items.filter((i) => wanted.has(i));
}

/** Sign of a ticker's sector-relative move on a session — the market's read of the news. */
function eventSign(deps: SignalGenDeps, ticker: string, session: string): 1 | -1 | null {
  const series = deps.ctx.seriesByTicker.get(ticker);
  if (!series) return null;
  const snap = snapshotAt(series, session);
  if (!snap || snap.ret == null) return null;
  const peers = sectorMedianReturn(deps.ctx, ticker, sessionWindow(deps.calendar, session));
  const move = peers.value != null ? snap.ret - peers.value : snap.ret;
  if (move === 0) return null;
  return move > 0 ? 1 : -1;
}

function patternDirection(value: unknown): 1 | -1 | null {
  if (value === "up" || value === "buy") return 1;
  if (value === "down" || value === "sell") return -1;
  return null;
}

function eventCandidates(deps: SignalGenDeps): Candidate[] {
  const trigger = deps.strategy.trigger.event;
  const graph = deps.strategy.trigger.graph;
  if (!trigger) return [];
  const out: Candidate[] = [];

  for (const eventTicker of deps.universe) {
    for (const event of deps.filingsByTicker.get(eventTicker) ?? []) {
      if (event.session < deps.from || event.session > deps.to) continue;
      const items = matchingItems(event, trigger.types);
      if (items.length === 0) continue;
      const label = `8-K ${items.join("/")} on ${eventTicker}`;
      const sign = eventSign(deps, eventTicker, event.session);

      if (trigger.on === "root") {
        out.push({
          ticker: eventTicker,
          session: event.session,
          reason: label,
          direction: sign,
          after_close: event.after_close,
        });
        continue;
      }
      const neighbours = neighboursOf(deps.graph, eventTicker, graph?.min_tier ?? "marginal", event.session);
      for (const neighbour of neighbours) {
        if (!deps.ctx.seriesByTicker.has(neighbour.ticker)) continue;
        out.push({
          ticker: neighbour.ticker,
          session: event.session,
          reason: `${label} → ${neighbour.tier} ${neighbour.category ?? "link"} ${neighbour.ticker}`,
          direction: sign,
          after_close: event.after_close,
        });
      }
    }
  }
  return out;
}

function patternCandidates(deps: SignalGenDeps): Candidate[] {
  const trigger = deps.strategy.trigger.pattern;
  if (!trigger) return [];
  const out: Candidate[] = [];
  for (const ticker of deps.universe) {
    const series = deps.ctx.seriesByTicker.get(ticker);
    if (!series) continue;
    for (const snap of series.snapshots) {
      if (snap.d < deps.from || snap.d > deps.to) continue;
      for (const name of trigger.names) {
        const evaluation = evaluatePatternAsOf(
          name as ScreenPattern,
          series,
          snap.d,
          deps.screenConfig,
          deps.r2Floor,
        );
        if (evaluation?.status !== "present") continue;
        if (trigger.state === "new") {
          const held = consecutiveSessions(name as ScreenPattern, series, snap.d, deps.screenConfig, deps.r2Floor, 40);
          if (held !== 1) continue;
        }
        out.push({
          ticker,
          session: snap.d,
          reason: `screen ${name}${trigger.state === "new" ? " (first session)" : ""}`,
          direction: patternDirection(evaluation.values?.direction),
          after_close: false,
        });
      }
    }
  }
  return out;
}

function setupCandidates(deps: SignalGenDeps): Candidate[] {
  const trigger = deps.strategy.trigger.setup;
  if (!trigger) return [];
  const wanted = new Set(trigger.names.map((n) => n.toLowerCase()));
  const out: Candidate[] = [];
  for (const ticker of deps.universe) {
    const series = deps.ctx.seriesByTicker.get(ticker);
    if (!series) continue;
    const earnings = deps.earningsByTicker.get(ticker) ?? [];
    for (const snap of series.snapshots) {
      if (snap.d < deps.from || snap.d > deps.to) continue;
      const result = setupAsOf({
        series,
        session: snap.d,
        calendar: deps.calendar,
        gaugeConfig: deps.gaugeConfig,
        screenConfig: deps.screenConfig,
        r2Floor: deps.r2Floor,
        earnings,
        earningsKnowledgeHorizonSessions: deps.earningsKnowledgeHorizonSessions,
      });
      if (!result) continue;
      if (!wanted.has(result.setup.key.toLowerCase())) continue;
      if (trigger.state && result.state !== trigger.state) continue;
      out.push({
        ticker,
        session: snap.d,
        reason: `gauge ${result.setup.key} / ${result.state}`,
        direction: result.setup.direction === "up" ? 1 : result.setup.direction === "down" ? -1 : null,
        after_close: false,
      });
    }
  }
  return out;
}

/**
 * Candidates for a composite rule: every sub-trigger must hold on the same
 * (ticker, session). Intersection, never a score — §2.
 */
function compositeCandidates(deps: SignalGenDeps): Candidate[] {
  const parts: Candidate[][] = [];
  if (deps.strategy.trigger.event) parts.push(eventCandidates(deps));
  if (deps.strategy.trigger.pattern) parts.push(patternCandidates(deps));
  if (deps.strategy.trigger.setup) parts.push(setupCandidates(deps));
  if (parts.length === 0) return [];

  const key = (c: Candidate) => `${c.ticker}|${c.session}`;
  let survivors = parts[0];
  for (const part of parts.slice(1)) {
    const keys = new Set(part.map(key));
    survivors = survivors.filter((c) => keys.has(key(c)));
  }
  // Merge the reasons of every part that agreed, so the audit trail names all
  // the clauses rather than just the first.
  const byKey = new Map<string, string[]>();
  for (const part of parts) {
    for (const c of part) {
      const list = byKey.get(key(c)) ?? [];
      list.push(c.reason);
      byKey.set(key(c), list);
    }
  }
  return survivors.map((c) => ({ ...c, reason: (byKey.get(key(c)) ?? [c.reason]).join(" + ") }));
}

function candidatesFor(deps: SignalGenDeps): Candidate[] {
  switch (deps.strategy.trigger.kind) {
    case "event":
      return eventCandidates(deps);
    case "pattern":
      return patternCandidates(deps);
    case "setup":
      return setupCandidates(deps);
    case "composite_and":
      return compositeCandidates(deps);
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Tickers dropped before any evaluation, with the reason (§4). */
export function screenUniverse(deps: SignalGenDeps): { universe: string[]; excluded: Exclusion[] } {
  const excluded: Exclusion[] = [];
  const universe: string[] = [];
  const required = deps.strategy.universe.min_history_sessions;
  for (const ticker of deps.universe) {
    const series = deps.ctx.seriesByTicker.get(ticker);
    if (!series || series.snapshots.length === 0) {
      excluded.push({ ticker, reason: "no_series", detail: "no backfilled series on disk" });
      continue;
    }
    if (series.snapshots.length < required) {
      excluded.push({
        ticker,
        reason: "short_history",
        detail: `${series.snapshots.length} sessions, ${required} required`,
      });
      continue;
    }
    universe.push(ticker);
  }
  return { universe, excluded };
}

export function generateSignals(deps: SignalGenDeps): SignalGenResult {
  const { universe, excluded } = screenUniverse(deps);
  const scoped: SignalGenDeps = { ...deps, universe };

  const candidates = candidatesFor(scoped);
  const filterRejections: Record<string, number> = {};
  let entryTimingRejected = 0;
  let directionFromTrigger = 0;
  let directionFallback = 0;
  const signals: Signal[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = `${candidate.ticker}|${candidate.session}`;
    if (seen.has(key)) continue;

    const series = scoped.ctx.seriesByTicker.get(candidate.ticker);
    if (!series) continue;
    const index = series.snapshots.findIndex((s) => s.d === candidate.session);
    if (index < 0) continue;
    const snap = series.snapshots[index];

    // §6: an after-close event cannot be entered at that session's close.
    if (candidate.after_close && scoped.strategy.entry.when === "signal_close") {
      entryTimingRejected++;
      continue;
    }

    let rejected = false;
    for (const filter of scoped.strategy.filters) {
      if (passesFilter(filter, scoped, candidate.ticker, candidate.session, series, index, snap)) continue;
      filterRejections[filter.kind] = (filterRejections[filter.kind] ?? 0) + 1;
      rejected = true;
      break;
    }
    if (rejected) continue;

    const sign = resolveSign(scoped.strategy, candidate);
    if (scoped.strategy.direction.kind !== "long_only") {
      if (candidate.direction == null) directionFallback++;
      else directionFromTrigger++;
    }
    const entryWindow = resolveWindow(scoped.calendar, candidate.session, scoped.strategy.entry.when, 1);
    if (!entryWindow) continue;
    const entrySnap = snapshotAt(series, entryWindow.entry);
    if (!entrySnap) continue;
    const entryPrice = scoped.strategy.entry.when === "signal_close" ? entrySnap.close : entrySnap.open;
    if (!(entryPrice > 0)) continue;

    const returns = scoped.strategy.hold.sessions.map((hold) => {
      const window = resolveWindow(scoped.calendar, candidate.session, scoped.strategy.entry.when, hold);
      if (!window) {
        return {
          sessions: hold,
          exit_session: null,
          exit_price: null,
          raw: null,
          market_adjusted: null,
          sector_relative: null,
          degraded: ["window_incomplete"],
        };
      }
      return computeHorizonReturn(scoped.ctx, {
        ticker: candidate.ticker,
        window,
        holdSessions: hold,
        sign,
        beta: snap.beta,
      });
    });

    seen.add(key);
    signals.push({
      ticker: candidate.ticker,
      session: candidate.session,
      entry_session: entryWindow.entry,
      entry_price: entryPrice,
      entry_when: scoped.strategy.entry.when,
      sign,
      sector: scoped.ctx.sectorOf.get(candidate.ticker) ?? null,
      reason: candidate.reason,
      returns,
    });
  }

  signals.sort((a, b) => a.session.localeCompare(b.session) || a.ticker.localeCompare(b.ticker));
  return {
    signals,
    excluded,
    entry_timing_rejected: entryTimingRejected,
    filter_rejections: filterRejections,
    direction_from_trigger: directionFromTrigger,
    direction_fallback_long: directionFallback,
  };
}

/**
 * Resolves the expected direction. An unresolved direction falls back to long
 * rather than dropping the signal — the fallback is visible in the strategy's
 * validation warnings, and silently discarding half a sample would distort the
 * count more than a stated assumption does.
 */
export function resolveSign(strategy: Strategy, candidate: Candidate): 1 | -1 {
  switch (strategy.direction.kind) {
    case "long_only":
      return 1;
    case "event_direction":
    case "pattern_direction":
      return candidate.direction ?? 1;
  }
}
