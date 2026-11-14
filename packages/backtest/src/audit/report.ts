/**
 * The QualityReport (design 6): deterministic checks, the evidence label and
 * flag texts built from templates with slots filled from the report's own
 * values. No model writes any of this. Pure.
 */

export type CheckLevel = "G" | "W" | "I";
export type CheckStatus = "pass" | "warn" | "gate" | "info" | "skipped";

export type Check = {
  id: number;
  name: string;
  tier: "A" | "B";
  level: CheckLevel;
  status: CheckStatus;
  /** Deterministic sentence(s) with numbers filled in by the server. */
  detail: string;
};

export type EvidenceLevel = "insufficient" | "thin" | "some" | "consistent";

export const EVIDENCE_TITLE: Record<EvidenceLevel, string> = {
  insufficient: "Insufficient sample",
  thin: "Thin",
  some: "Some",
  consistent: "Consistent",
};

export const EVIDENCE_HEADING = "Evidence in past data";

export const EVIDENCE_SUBTITLE =
  "This describes the past only. Published effects often shrink: of 447 anomalies, 64% were not significant once microcaps were handled, and 85% failed a t of 3 hurdle (Hou, Xue & Zhang, https://www.nber.org/papers/w23394).";

export const HYPOTHETICAL = "Hypothetical, simulated on past data. Not a forecast.";

/** Numbers the flag templates and Explain slots refer to, by path (e.g. "delay.drop_pct"). */
export type ReportValues = Record<string, Record<string, number | string | null>>;

export type Flag = { check_id: number; severity: "high" | "medium" | "low"; text: string };

export type QualityReport = {
  tiers: ("A" | "B")[];
  label: { level: EvidenceLevel; title: string; heading: string; subtitle: string; reasons: string[] };
  checks: Check[];
  flags: Flag[];
  values: ReportValues;
};

/** Resolves "group.key" in the values; null when missing. */
export function resolveRef(values: ReportValues, ref: string): number | string | null {
  const [g, k] = ref.split(".");
  if (!g || !k) return null;
  const v = values[g]?.[k];
  return v === undefined ? null : v;
}

/** Formats a slot value for text: rounded numbers, no exponent. */
export function slotText(v: number | string | null): string {
  if (v === null) return "n/a";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Fills "{group.key}" slots from the values. */
export function fill(template: string, values: ReportValues): string {
  return template.replace(/\{([a-z_]+\.[a-z0-9_]+)\}/g, (_, ref: string) => slotText(resolveRef(values, ref)));
}

/** At most 5 flags: gates first, then warnings, in check order. */
export function topFlags(checks: Check[], values: ReportValues): Flag[] {
  // Gates first, then warnings; the standing survivorship note and the null comparison come last.
  const sev = (c: Check) => (c.status === "gate" ? 0 : c.id === 15 ? 3 : c.id === 7 ? 2 : 1);
  return checks
    .filter((c) => c.status === "gate" || c.status === "warn")
    .sort((a, b) => sev(a) - sev(b) || a.id - b.id)
    .slice(0, 5)
    .map((c) => ({ check_id: c.id, severity: c.status === "gate" ? "high" : c.id === 6 || c.id === 9 || c.id === 10 || c.id === 14 ? "high" : "medium", text: fill(c.detail, values) }));
}
