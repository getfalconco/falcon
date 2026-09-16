import type {
  HorizonStats,
  Strategy,
  StrategyFilter,
  StrategyTrigger,
} from "../../../shared/quantlab-types";

/** An em dash, not a zero: a missing number must never read as a measured one. */
export const DASH = "—";

export function pct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

export function ratio(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return value.toFixed(digits);
}

export function pctPlain(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

export function money(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/**
 * A rule rendered as the conditions that must ALL hold (§2).
 *
 * Deliberately a list rather than a formula: the whole design position is that
 * a strategy is readable clause by clause, and that when it fails you can name
 * the clause. A rendered weighted score would undo that.
 */
export function triggerLines(trigger: StrategyTrigger): string[] {
  const lines: string[] = [];
  if (trigger.event) {
    const items = trigger.event.types.map((t) => t.replace("8k_item_", "")).join(" / ");
    lines.push(
      trigger.event.on === "root"
        ? `an 8-K carrying item ${items} is filed by the ticker itself`
        : `an 8-K carrying item ${items} is filed by a graph neighbour's counterparty`,
    );
  }
  if (trigger.graph) {
    lines.push(
      `the link is at least ${trigger.graph.min_tier}, ${trigger.graph.max_hops} hop${trigger.graph.max_hops === 1 ? "" : "s"}, and was disclosed on or before the signal session`,
    );
  }
  if (trigger.pattern) {
    const names = trigger.pattern.names.join(" or ");
    lines.push(
      trigger.pattern.state === "new"
        ? `Screen's ${names} pattern is on its FIRST session`
        : `Screen's ${names} pattern holds`,
    );
  }
  if (trigger.setup) {
    lines.push(`Gauge reads setup ${trigger.setup.names.join(" or ")} in state ${trigger.setup.state}`);
  }
  return lines;
}

export function filterLine(filter: StrategyFilter): string {
  switch (filter.kind) {
    case "r2_floor":
      return `r² is at least ${filter.min}`;
    case "no_earnings_within":
      return `no earnings announcement within ${filter.sessions} sessions`;
    case "unpriced":
      return `the session's sector-relative move is under ${filter.max_ratio}× its daily vol (still unpriced)`;
    case "liquidity":
      return `20-session median dollar volume is at least ${money(filter.min_dollar_volume_20d)}`;
    case "vol_regime":
      return `the vol regime is at or below ${filter.max}`;
  }
}

export function entryLine(strategy: Strategy): string {
  return strategy.entry.when === "signal_close"
    ? "enter at the close of the signal session"
    : "enter at the open of the following session";
}

export function directionLine(strategy: Strategy): string {
  switch (strategy.direction.kind) {
    case "long_only":
      return "always long";
    case "event_direction":
      return "signed by the event's own direction";
    case "pattern_direction":
      return "signed by the pattern or setup's direction";
  }
}

/** True when the horizon beat its base rate with an interval that clears it. */
export function beatsBaseRate(h: HorizonStats): boolean | null {
  if (h.insufficient || h.median == null || h.base_rate_median == null) return null;
  if (h.ci_low == null || h.ci_high == null) return null;
  if (h.ci_low <= h.base_rate_median && h.base_rate_median <= h.ci_high) return false;
  return h.median > h.base_rate_median;
}

export function edgeOf(h: HorizonStats): number | null {
  if (h.median == null || h.base_rate_median == null) return null;
  return h.median - h.base_rate_median;
}
