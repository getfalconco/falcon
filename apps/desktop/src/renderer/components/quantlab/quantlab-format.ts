import { na } from "@/lib/i18n/na";
import type { TFunction } from "@/lib/i18n";
import type {
  HorizonStats,
  Strategy,
  StrategyFilter,
  StrategyTrigger,
} from "../../../shared/quantlab-types";
import { plural } from "../base/plural";

/** Missing numbers read as `na()` ("n/a" in the reader's language), never a zero. */

export function pct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return na();
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

export function ratio(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return na();
  return value.toFixed(digits);
}

export function pctPlain(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return na();
  return `${(value * 100).toFixed(digits)}%`;
}

export function money(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/** "a or b or c" in the reader's language, for names that are data (patterns, setups). */
function orList(names: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { type: "disjunction" }).format(names);
  } catch {
    return names.join(" / ");
  }
}

/**
 * A rule rendered as the conditions that must ALL hold (§2).
 *
 * Deliberately a list rather than a formula: the whole design position is that
 * a strategy is readable clause by clause, and that when it fails you can name
 * the clause. A rendered weighted score would undo that.
 */
export function triggerLines(trigger: StrategyTrigger, t: TFunction, locale: string): string[] {
  const lines: string[] = [];
  if (trigger.event) {
    const items = trigger.event.types.map((type) => type.replace("8k_item_", "")).join(" / ");
    lines.push(
      trigger.event.on === "root"
        ? t("instruments.quantlab.rule.eventRoot", { items })
        : t("instruments.quantlab.rule.eventNeighbour", { items }),
    );
  }
  if (trigger.graph) {
    const hops = trigger.graph.max_hops;
    lines.push(
      t(plural(locale, hops, "instruments.quantlab.rule.graph.one", "instruments.quantlab.rule.graph.other"), {
        tier: trigger.graph.min_tier,
        hops,
      }),
    );
  }
  if (trigger.pattern) {
    const names = orList(trigger.pattern.names, locale);
    lines.push(
      trigger.pattern.state === "new"
        ? t("instruments.quantlab.rule.patternNew", { names })
        : t("instruments.quantlab.rule.patternHolds", { names }),
    );
  }
  if (trigger.setup) {
    lines.push(
      t("instruments.quantlab.rule.setup", { names: orList(trigger.setup.names, locale), state: trigger.setup.state }),
    );
  }
  return lines;
}

export function filterLine(filter: StrategyFilter, t: TFunction): string {
  switch (filter.kind) {
    case "r2_floor":
      return t("instruments.quantlab.rule.r2", { min: filter.min });
    case "no_earnings_within":
      return t("instruments.quantlab.rule.noEarnings", { n: filter.sessions });
    case "unpriced":
      return t("instruments.quantlab.rule.unpriced", { ratio: filter.max_ratio });
    case "liquidity":
      return t("instruments.quantlab.rule.liquidity", { amount: money(filter.min_dollar_volume_20d) });
    case "vol_regime":
      return t("instruments.quantlab.rule.volRegime", { max: filter.max });
  }
}

export function entryLine(strategy: Strategy, t: TFunction): string {
  return strategy.entry.when === "signal_close"
    ? t("instruments.quantlab.rule.entryClose")
    : t("instruments.quantlab.rule.entryOpen");
}

export function directionLine(strategy: Strategy, t: TFunction): string {
  switch (strategy.direction.kind) {
    case "long_only":
      return t("instruments.quantlab.rule.upOnly");
    case "event_direction":
      return t("instruments.quantlab.rule.eventDirection");
    case "pattern_direction":
      return t("instruments.quantlab.rule.patternDirection");
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
