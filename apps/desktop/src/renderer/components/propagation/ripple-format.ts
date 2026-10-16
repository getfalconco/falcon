import { withClock } from "../../lib/clock";
import type { MessageKey } from "../../lib/i18n";
import { formatDuration, plural, type Translate } from "../../lib/panels-format";
import type {
  PricingStatus,
  PropagationDirection,
  PropagationMateriality,
  PropagationRole,
  PropagationStrengthTier,
  PropagationTarget,
  PropagationTier,
  Stage2Verdict,
} from "../../../shared/propagation-run-types";

/** The product's money state: OPEN is the only accent on the screen. */
export const ACCENT = "#189E9A";
export const INK = "#1d1b1b";
export const MUTED = "#6b7280";
export const FAINT = "#b4b4ae";
export const HAIRLINE = "#e0e0da";
/** The third neutral: a refuted thesis is neither open (teal) nor priced (grey). */
export const AMBER = "#B45309";
export const AMBER_SOFT = "#FEF3C7";
export const AMBER_LINE = "#E7C08A";
export const GAIN = "#16A34A";
export const LOSS = "#DC2626";

/**
 * The mark for a value that is not there. Never a dash (shared/copy-rules.ts);
 * views pass their language's own `common.na`, this is the fallback.
 */
export const NOT_AVAILABLE = "n/a";

export function directionColor(direction: PropagationDirection): string {
  if (direction === "positive") return GAIN;
  if (direction === "negative") return LOSS;
  return FAINT;
}

export function directionGlyph(direction: PropagationDirection): string {
  if (direction === "positive") return "▲";
  if (direction === "negative") return "▼";
  if (direction === "mixed") return "◆";
  return "◇";
}

const DIRECTIONS: readonly PropagationDirection[] = ["positive", "negative", "mixed", "unclear"];

export function directionWord(direction: PropagationDirection, t: Translate): string {
  const d = DIRECTIONS.includes(direction) ? direction : "unclear";
  return t(`panels.ripple.direction.${d}`);
}

export function tierStroke(tier: PropagationTier): number {
  if (tier === "strong") return 3;
  if (tier === "moderate") return 2;
  return 1.25;
}

const ROLES: readonly PropagationRole[] = ["supplier", "customer", "competitor", "partner", "dependency", "depended_on_by"];

export function roleWord(role: PropagationRole, t: Translate): string {
  return ROLES.includes(role) ? t(`panels.ripple.role.${role}`) : humanize(role);
}

/**
 * A relationship's strength (critical / important / marginal), or the raw
 * value when it is new; "unrated" when the tier was never measured (it still
 * ranks as `tier`).
 */
export function strengthWord(tier: PropagationStrengthTier | string, t: Translate, measured = true): string {
  if (!measured) return t("panels.ripple.strength.unrated");
  return tier === "critical" || tier === "important" || tier === "marginal" ? t(`panels.ripple.strength.${tier}`) : humanize(tier);
}

/** A transmission tier (strong / moderate / weak). */
export function tierWord(tier: PropagationTier | string, t: Translate): string {
  return tier === "strong" || tier === "moderate" || tier === "weak" ? t(`panels.ripple.tier.${tier}`) : humanize(tier);
}

export function verdictWord(verdict: Stage2Verdict | string, t: Translate): string {
  return verdict === "confirmed" || verdict === "vetoed" || verdict === "adjusted" ? t(`panels.ripple.verdict.${verdict}`) : humanize(verdict);
}

export function materialityWord(materiality: PropagationMateriality | string, t: Translate): string {
  return materiality === "high" || materiality === "standard" || materiality === "low"
    ? t(`panels.ripple.materiality.${materiality}`)
    : humanize(materiality);
}

export const PRICING_KEY: Record<PricingStatus, MessageKey> = {
  open: "panels.ripple.pricing.open",
  partial: "panels.ripple.pricing.partial",
  priced: "panels.ripple.pricing.priced",
  contradicted: "panels.ripple.pricing.contradicted",
  stale: "panels.ripple.pricing.stale",
  unknown: "panels.ripple.pricing.unknown",
};

export function pricingWord(target: PropagationTarget, t: Translate): string {
  if (target.stage2?.verdict === "vetoed") return t("panels.ripple.pricing.vetoed");
  if (!target.tracked) return t("panels.ripple.pricing.unknown");
  return t(PRICING_KEY[target.pricing.status] ?? "panels.ripple.pricing.unknown");
}

/*
 * Figures stay in en-US notation whatever the language: a percentage, a price
 * or a ratio reads the same on every desk.
 */

export function fmtPct(value: number | null | undefined, digits = 2, na = NOT_AVAILABLE): string {
  if (value == null || !Number.isFinite(value)) return na;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function fmtAbsPct(value: number | null | undefined, digits = 2, na = NOT_AVAILABLE): string {
  if (value == null || !Number.isFinite(value)) return na;
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtNum(value: number | null | undefined, digits = 2, na = NOT_AVAILABLE): string {
  return value == null || !Number.isFinite(value) ? na : value.toFixed(digits);
}

export function fmtMoney(value: number | null | undefined, na = NOT_AVAILABLE): string {
  return value == null || !Number.isFinite(value) ? na : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A date and time of day in the reader's language, on the reader's clock. */
export function fmtWhen(iso: string | null | undefined, locale?: string, na = NOT_AVAILABLE): string {
  if (!iso) return na;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale ?? [], withClock({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
}

export function fmtDay(iso: string | null | undefined, locale?: string, na = NOT_AVAILABLE): string {
  if (!iso) return na;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale ?? [], { month: "short", day: "numeric" });
}

export function humanize(text: string): string {
  return text.replace(/_/g, " ");
}

const EVENT_TYPES = [
  "earnings_results",
  "guidance",
  "supply_chain_ops",
  "regulatory_decision",
  "product_clinical",
  "ma_activity",
  "contract_partnership",
  "legal",
  "management_governance",
  "financing_credit",
  "analyst_action",
  "ownership_flows",
  "macro_sector",
  "capital_allocation",
  "other",
] as const;

export function eventTypeWord(type: string, t: Translate): string {
  return (EVENT_TYPES as readonly string[]).includes(type)
    ? t(`panels.ripple.eventType.${type as (typeof EVENT_TYPES)[number]}`)
    : humanize(type);
}

export type SummaryCounts = {
  targets: number;
  open: number;
  partial: number;
  priced: number;
  contradicted?: number;
  untracked: number;
  stale: number;
  vetoed: number;
};

/** "12 names · 2 open · 1 priced in": the count, then each pricing state present. */
export function summaryLine(s: SummaryCounts, t: Translate, locale: string): string {
  const parts = [plural(t, locale, "panels.ripple.summary.names", s.targets)];
  if (s.open) parts.push(t("panels.ripple.summary.open", { n: s.open }));
  if (s.partial) parts.push(t("panels.ripple.summary.partial", { n: s.partial }));
  if (s.priced) parts.push(t("panels.ripple.summary.priced", { n: s.priced }));
  if (s.contradicted) parts.push(t("panels.ripple.summary.against", { n: s.contradicted }));
  if (s.stale) parts.push(t("panels.ripple.summary.stale", { n: s.stale }));
  if (s.untracked) parts.push(t("panels.ripple.summary.untracked", { n: s.untracked }));
  if (s.vetoed) parts.push(t("panels.ripple.summary.vetoed", { n: s.vetoed }));
  return parts.join(" · ");
}

/**
 * How long the engine took to see an event: the number that decides whether
 * a second-order move was still catchable. Sub-hour is the goal; days mean
 * the tape had already absorbed it before the run existed.
 */
export function fmtLag(
  eventTs: string | null | undefined,
  producedAt: string | null | undefined,
  t: Translate,
  locale: string,
): string | null {
  if (!eventTs || !producedAt) return null;
  const ms = Date.parse(producedAt) - Date.parse(eventTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (Math.round(ms / 60000) < 1) return t("panels.ripple.lagUnderMinute");
  return t("panels.ripple.lag", { duration: formatDuration(ms, locale) });
}
