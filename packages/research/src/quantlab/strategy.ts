/**
 * Strategy schema, validation and versioning (§5).
 *
 * A strategy is a set of conditions that must ALL hold. There is no weighted
 * score anywhere in this file, deliberately (§2): weights are unfalsifiable
 * knobs that a backtest will happily overfit, and when a scored rule fails you
 * cannot say which part failed. A rule either triggers or it does not.
 *
 * Nothing is edited in place. Every change mints a new version carrying
 * `parent_version`, because the version chain IS the record of how much
 * searching happened — and that count is what the variant warning reads. A
 * store that let you edit v3 would erase the evidence that v1 and v2 existed.
 */

import type {
  EntryWhen,
  FilterKind,
  Strategy,
  StrategyFilter,
  StrategyTrigger,
  TriggerKind,
} from "./types.js";
import { SCREEN_PATTERN_NAMES, TRIGGER_KINDS } from "./types.js";

export type ValidationIssue = { field: string; message: string };

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  /** Non-blocking notes shown in the builder (e.g. permissive entry timing). */
  warnings: ValidationIssue[];
};

const FILTER_KINDS: FilterKind[] = ["r2_floor", "no_earnings_within", "unpriced", "liquidity", "vol_regime"];
const ENTRY_WHEN: EntryWhen[] = ["signal_close", "next_open"];
const TIERS = ["critical", "important", "marginal"];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateTrigger(trigger: StrategyTrigger | undefined, errors: ValidationIssue[]): void {
  if (!trigger || typeof trigger !== "object") {
    errors.push({ field: "trigger", message: "a strategy must have a trigger" });
    return;
  }
  if (!TRIGGER_KINDS.includes(trigger.kind as TriggerKind)) {
    errors.push({ field: "trigger.kind", message: `kind must be one of ${TRIGGER_KINDS.join(", ")}` });
  }

  const needsEvent = trigger.kind === "event" || trigger.kind === "composite_and";
  if (needsEvent && trigger.event) {
    if (!Array.isArray(trigger.event.types) || trigger.event.types.length === 0) {
      errors.push({ field: "trigger.event.types", message: "at least one event type is required" });
    }
    if (trigger.event.on !== "root" && trigger.event.on !== "graph_neighbour") {
      errors.push({ field: "trigger.event.on", message: "on must be root or graph_neighbour" });
    }
    if (trigger.event.on === "graph_neighbour" && !trigger.graph?.edge_from_event_ticker) {
      errors.push({
        field: "trigger.graph",
        message: "a graph_neighbour event needs trigger.graph.edge_from_event_ticker",
      });
    }
  } else if (trigger.kind === "event" && !trigger.event) {
    errors.push({ field: "trigger.event", message: "an event trigger needs an event block" });
  }

  if (trigger.kind === "pattern" && !trigger.pattern) {
    errors.push({ field: "trigger.pattern", message: "a pattern trigger needs a pattern block" });
  }
  if (trigger.pattern) {
    const unknown = (trigger.pattern.names ?? []).filter((n) => !SCREEN_PATTERN_NAMES.includes(n));
    if (unknown.length > 0) {
      errors.push({ field: "trigger.pattern.names", message: `unknown pattern(s): ${unknown.join(", ")}` });
    }
    if ((trigger.pattern.names ?? []).length === 0) {
      errors.push({ field: "trigger.pattern.names", message: "at least one pattern is required" });
    }
  }

  if (trigger.kind === "setup" && !trigger.setup) {
    errors.push({ field: "trigger.setup", message: "a setup trigger needs a setup block" });
  }
  if (trigger.setup && (trigger.setup.names ?? []).length === 0) {
    errors.push({ field: "trigger.setup.names", message: "at least one setup is required" });
  }

  if (trigger.graph) {
    if (!TIERS.includes(trigger.graph.min_tier)) {
      errors.push({ field: "trigger.graph.min_tier", message: `min_tier must be one of ${TIERS.join(", ")}` });
    }
    if (!isFiniteNumber(trigger.graph.max_hops) || trigger.graph.max_hops < 1) {
      errors.push({ field: "trigger.graph.max_hops", message: "max_hops must be at least 1" });
    }
    if (trigger.graph.max_hops > 1) {
      errors.push({
        field: "trigger.graph.max_hops",
        message: "multi-hop is v2 — the transmission matrix has to be validated before hop 2 means anything",
      });
    }
  }
}

function validateFilters(filters: StrategyFilter[] | undefined, errors: ValidationIssue[]): void {
  if (!Array.isArray(filters)) {
    errors.push({ field: "filters", message: "filters must be an array (empty is fine)" });
    return;
  }
  const seen = new Set<string>();
  for (const [i, filter] of filters.entries()) {
    if (!filter || !FILTER_KINDS.includes(filter.kind)) {
      errors.push({ field: `filters[${i}]`, message: `kind must be one of ${FILTER_KINDS.join(", ")}` });
      continue;
    }
    if (seen.has(filter.kind)) {
      errors.push({ field: `filters[${i}]`, message: `duplicate ${filter.kind} filter` });
    }
    seen.add(filter.kind);

    const bad = (field: string, message: string) => errors.push({ field: `filters[${i}].${field}`, message });
    switch (filter.kind) {
      case "r2_floor":
        if (!isFiniteNumber(filter.min) || filter.min < 0 || filter.min > 1) bad("min", "must be between 0 and 1");
        break;
      case "no_earnings_within":
        if (!isFiniteNumber(filter.sessions) || filter.sessions < 0) bad("sessions", "must be 0 or more");
        break;
      case "unpriced":
        if (!isFiniteNumber(filter.max_ratio) || filter.max_ratio <= 0) bad("max_ratio", "must be positive");
        break;
      case "liquidity":
        if (!isFiniteNumber(filter.min_dollar_volume_20d) || filter.min_dollar_volume_20d < 0) {
          bad("min_dollar_volume_20d", "must be 0 or more");
        }
        break;
      case "vol_regime":
        if (!isFiniteNumber(filter.max) || filter.max <= 0) bad("max", "must be positive");
        break;
    }
  }
}

/**
 * Validates a strategy. Errors block a save; warnings are shown and allowed.
 *
 * The entry-timing rule (§6) is a warning rather than an error because it can
 * only be decided per signal: a release accepted before the open IS computable
 * at that session's close, one accepted after it is not. The engine drops the
 * individual signals it cannot honour and reports the count, which is more
 * informative than refusing the whole strategy up front.
 */
export function validateStrategy(strategy: Partial<Strategy>): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!strategy.name || strategy.name.trim().length === 0) {
    errors.push({ field: "name", message: "a strategy needs a name" });
  }
  if (!strategy.strategy_id) {
    errors.push({ field: "strategy_id", message: "missing strategy_id" });
  }
  if (!isFiniteNumber(strategy.version) || strategy.version! < 1) {
    errors.push({ field: "version", message: "version must be 1 or more" });
  }

  const universe = strategy.universe;
  if (!universe) {
    errors.push({ field: "universe", message: "a strategy needs a universe" });
  } else {
    if (universe.tickers !== "tracked" && (!Array.isArray(universe.tickers) || universe.tickers.length === 0)) {
      errors.push({ field: "universe.tickers", message: `must be "tracked" or a non-empty list` });
    }
    if (!isFiniteNumber(universe.min_history_sessions) || universe.min_history_sessions < 1) {
      errors.push({ field: "universe.min_history_sessions", message: "must be at least 1" });
    }
  }

  validateTrigger(strategy.trigger, errors);
  validateFilters(strategy.filters, errors);

  if (!strategy.entry || !ENTRY_WHEN.includes(strategy.entry.when)) {
    errors.push({ field: "entry.when", message: `must be one of ${ENTRY_WHEN.join(", ")}` });
  }
  if (strategy.trigger?.kind === "event" && strategy.entry?.when === "signal_close") {
    warnings.push({
      field: "entry.when",
      message:
        "event trigger with signal_close entry: releases accepted after the close are not tradable at that close, and those signals will be dropped",
    });
  }

  const hold = strategy.hold?.sessions;
  if (!Array.isArray(hold) || hold.length === 0) {
    errors.push({ field: "hold.sessions", message: "at least one hold horizon is required" });
  } else if (hold.some((h) => !isFiniteNumber(h) || h < 1)) {
    errors.push({ field: "hold.sessions", message: "every horizon must be at least 1 session" });
  }

  if (strategy.exit && strategy.exit.kind !== "time_only") {
    errors.push({
      field: "exit.kind",
      message: "exit is time-only in v1 — stops and targets are extra knobs and the classic overfitting surface",
    });
  }

  const direction = strategy.direction?.kind;
  if (direction !== "event_direction" && direction !== "pattern_direction" && direction !== "long_only") {
    errors.push({ field: "direction.kind", message: "must be event_direction, pattern_direction or long_only" });
  }
  if (direction === "event_direction" && strategy.trigger && strategy.trigger.kind === "pattern") {
    warnings.push({
      field: "direction.kind",
      message: "event_direction on a pattern trigger has no event to take a sign from; signals will fall back to long",
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export type NewVersionOptions = {
  /** Whether an OOS result for this family had already been viewed (§7). */
  createdAfterOosView: boolean;
  now: string;
};

/**
 * Derives the next version of a strategy from its parent.
 *
 * `live_enabled` deliberately does NOT carry over: a new rule has not been
 * tested out-of-sample yet, so inheriting the parent's live toggle would let an
 * untested edit start recording live signals under the old version's evidence.
 */
export function nextVersion(parent: Strategy, edits: Partial<Strategy>, options: NewVersionOptions): Strategy {
  return {
    ...parent,
    ...edits,
    strategy_id: parent.strategy_id,
    version: parent.version + 1,
    parent_version: parent.version,
    created_at: options.now,
    created_after_oos_view: options.createdAfterOosView,
    live_enabled: false,
  };
}

/** A version-1 strategy with the schema's defaults filled in. */
export function newStrategy(
  input: Omit<Strategy, "version" | "parent_version" | "created_after_oos_view" | "live_enabled">,
): Strategy {
  return {
    ...input,
    version: 1,
    parent_version: null,
    created_after_oos_view: false,
    live_enabled: false,
  };
}

/**
 * Which of a strategy's components cannot be evaluated point-in-time, with the
 * reason the builder shows (§3). Returns an empty list for a fully testable
 * strategy.
 */
export function unavailableComponents(
  strategy: Strategy,
  unavailableHistorically: Record<string, string>,
): Array<{ component: string; reason: string }> {
  const out: Array<{ component: string; reason: string }> = [];
  const add = (component: string) => {
    const reason = unavailableHistorically[component];
    if (reason && !out.some((o) => o.component === component)) out.push({ component, reason });
  };

  for (const name of strategy.trigger.pattern?.names ?? []) {
    if (name === "insider_divergence") add("insider_cluster");
    if (name === "quiet_accumulation") add("news_burst");
  }
  for (const name of strategy.trigger.setup?.names ?? []) {
    if (name === "divergence") add("insider_cluster");
    if (name === "move_spent" || name === "quiet_drift") add("news_burst");
  }
  return out;
}

/** True when nothing the strategy depends on is missing from history. */
export function isBacktestable(strategy: Strategy, unavailableHistorically: Record<string, string>): boolean {
  return unavailableComponents(strategy, unavailableHistorically).every((c) => c.component !== "insider_cluster");
}
