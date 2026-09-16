import type {
  PricingStatus,
  PropagationDirection,
  PropagationRole,
  PropagationTarget,
  PropagationTier,
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

export function directionWord(direction: PropagationDirection): string {
  if (direction === "positive") return "positive";
  if (direction === "negative") return "negative";
  if (direction === "mixed") return "mixed";
  return "unclear";
}

export function tierStroke(tier: PropagationTier): number {
  if (tier === "strong") return 3;
  if (tier === "moderate") return 2;
  return 1.25;
}

export const ROLE_WORD: Record<PropagationRole, string> = {
  supplier: "supplier",
  customer: "customer",
  competitor: "competitor",
  partner: "partner",
  dependency: "dependency",
  depended_on_by: "dependent",
};

export const PRICING_WORD: Record<PricingStatus, string> = {
  open: "OPEN",
  partial: "PARTIAL",
  priced: "PRICED",
  contradicted: "AGAINST",
  stale: "STALE",
  unknown: "UNTRACKED",
};

export function pricingWord(t: PropagationTarget): string {
  if (t.stage2?.verdict === "vetoed") return "VETOED";
  if (!t.tracked) return "UNTRACKED";
  return PRICING_WORD[t.pricing.status];
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function fmtAbsPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtNum(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

export function fmtMoney(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function humanize(text: string): string {
  return text.replace(/_/g, " ");
}

export function eventTypeWord(type: string): string {
  const map: Record<string, string> = {
    earnings_results: "Earnings",
    guidance: "Guidance",
    supply_chain_ops: "Supply chain",
    regulatory_decision: "Regulatory",
    product_clinical: "Product / clinical",
    ma_activity: "M&A",
    contract_partnership: "Contract / partnership",
    legal: "Legal",
    management_governance: "Management",
    financing_credit: "Financing",
    analyst_action: "Analyst action",
    ownership_flows: "Ownership flows",
    macro_sector: "Macro / sector",
    capital_allocation: "Capital allocation",
    other: "Other",
  };
  return map[type] ?? humanize(type);
}

export function summaryLine(s: { targets: number; open: number; partial: number; priced: number; contradicted?: number; untracked: number; stale: number; vetoed: number }): string {
  const parts = [`${s.targets} target${s.targets === 1 ? "" : "s"}`];
  if (s.open) parts.push(`${s.open} open`);
  if (s.partial) parts.push(`${s.partial} partial`);
  if (s.priced) parts.push(`${s.priced} priced`);
  if (s.contradicted) parts.push(`${s.contradicted} against`);
  if (s.stale) parts.push(`${s.stale} stale`);
  if (s.untracked) parts.push(`${s.untracked} untracked`);
  if (s.vetoed) parts.push(`${s.vetoed} vetoed`);
  return parts.join(" · ");
}

/**
 * How long the engine took to see an event — the number that decides whether
 * a second-order move was still catchable. Sub-hour is the target; days mean
 * the tape had already absorbed it before the run existed.
 */
export function fmtLag(eventTs: string | null | undefined, producedAt: string | null | undefined): string | null {
  if (!eventTs || !producedAt) return null;
  const ms = Date.parse(producedAt) - Date.parse(eventTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1m after the event";
  if (min < 60) return `${min}m after the event`;
  const h = ms / 3600000;
  if (h < 48) return `${h.toFixed(1)}h after the event`;
  return `${Math.round(h / 24)}d after the event`;
}
