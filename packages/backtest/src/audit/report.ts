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
  /** Deterministic sentence(s) with numbers filled in by the server (technical, for "All checks"). */
  detail: string;
  /** The same finding in plain words for anyone, shown as the flag; falls back to `detail`. */
  plain?: string;
};

export type EvidenceLevel = "insufficient" | "thin" | "some" | "consistent";

export const EVIDENCE_TITLE: Record<EvidenceLevel, string> = {
  insufficient: "Not enough trades to judge",
  thin: "Weak evidence",
  some: "Some evidence",
  consistent: "Strong evidence",
};

export const EVIDENCE_HEADING = "How much can you trust this result?";

export const EVIDENCE_SUBTITLE =
  "This only describes the past. Strategies that look good on past data usually do worse afterwards: in one large study, most published patterns did not hold up when checked again.";

/** The study behind the subtitle, shown as a link. */
export const EVIDENCE_SOURCE = { label: "Hou, Xue & Zhang, Replicating Anomalies", url: "https://www.nber.org/papers/w23394" } as const;

export const HYPOTHETICAL = "Simulated on past data. Not a forecast.";

/** Numbers the flag templates and Explain slots refer to, by path (e.g. "delay.drop_pct"). */
export type ReportValues = Record<string, Record<string, number | string | null>>;

export type Flag = { check_id: number; severity: "high" | "medium" | "low"; text: string };

export type QualityReport = {
  tiers: ("A" | "B")[];
  label: { level: EvidenceLevel; title: string; heading: string; subtitle: string; reasons: string[]; source?: { label: string; url: string } };
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

/**
 * What each value in report.values measures, so a filled slot carries its unit
 * ("45.7% a year", "24.49 points", "$6.27") whatever the template says:
 *   pct     a percent ("%"): returns, shares of the profit, turnover, percentiles
 *   pts     a difference of two annual returns, in percentage points (" points")
 *   count   a whole number (trades, tickers, seeds), with thousands separators
 *   years   a length of time in years (" years")
 *   usd     a price in dollars ("$")
 *   bp      basis points (" bp")
 *   number  a plain statistic (t, deflated Sharpe)
 *   text    a string as stored (tickers, dates, calendar years, "yes"/"no")
 * Every value tiers.ts produces is listed (test/explain.test.ts checks it).
 */
export type ValueUnit = "pct" | "pts" | "count" | "years" | "usd" | "bp" | "number" | "text";

export const VALUE_UNITS: Record<string, Record<string, ValueUnit>> = {
  prefix: { cut_date: "text", ok: "text" },
  availability: { missing: "text", missing_count: "count", cross_section_changes: "count" },
  sanity: { bad_ticks: "count", zero_volume: "count", high_below_low: "count", stale_runs: "count" },
  hindsight: {
    years_back: "years",
    tickers: "count",
    start_year: "text",
    confirmed: "text",
    late_listed: "count",
    late_examples: "text",
    list_annual_pct: "pct",
    spy_annual_pct: "pct",
    strategy_annual_pct: "pct",
    list_vs_spy_pct: "pts",
    rules_vs_list_pct: "pts",
  },
  sample: { trades: "count", event_dates: "count", rebalances: "count", years: "years" },
  null: { percentile: "pct", seeds: "count", beaten: "count", kind: "text" },
  event: { mean_pct: "pct", t: "number", dates_up: "count", dates: "count", window: "count" },
  benchmarks: { active_pct: "pct", vs_equal_weight_pct: "pct", benchmark: "text" },
  active: { annual_pct: "pct", range_lo: "pct", range_hi: "pct", hac_t: "number" },
  bootstrap: { k: "count", n: "count", k_of_n: "text" },
  costs: { x2_active_pct: "pct", break_even_bps: "bp", modelled_bps: "bp", monthly_turnover_pct: "pct", drag_pct: "pct" },
  delay: { active_pct: "pct", drop_pct: "pct" },
  concentration: { top_ticker: "text", top_ticker_share_pct: "pct", top5_trades_share_pct: "pct", best_year: "text", best_year_share_pct: "pct" },
  liquidity: { over_adv: "count", capacity_adv_pct: "pct", min_raw_price: "usd" },
  multiple: { trials: "count", dsr: "number" },
  null_b: { percentile: "pct", seeds: "count", beaten: "count" },
  neighbourhood: { median_pct: "pct", q25_pct: "pct", runs: "count", chosen_pct: "pct" },
  loo: { worst_ticker: "text", worst_pct: "pct", runs: "count" },
  regimes: { above_200d_pct: "pct", below_200d_pct: "pct", low_vol_pct: "pct", mid_vol_pct: "pct", high_vol_pct: "pct" },
};

/** The unit of a value path; unlisted paths fall back on the name (…_pct, …_bps) or the type. */
export function valueUnit(ref: string, v?: number | string | null): ValueUnit {
  const [g, k] = ref.split(".");
  const listed = g && k ? VALUE_UNITS[g]?.[k] : undefined;
  if (listed) return listed;
  if (typeof v === "string") return "text";
  if (k?.endsWith("_pct")) return "pct";
  if (k?.endsWith("_bps")) return "bp";
  return "number";
}

/** A value with its unit: "45.7%", "24.49 points", "1,000", "10 years", "$6.27", "2.8 bp". */
export function formatValue(v: number | string | null, unit: ValueUnit): string {
  if (typeof v === "string") return v;
  if (v === null || !Number.isFinite(v)) return "n/a";
  switch (unit) {
    case "pct":
      return `${slotText(v)}%`;
    case "pts":
      return `${slotText(v)} ${Math.abs(v) === 1 ? "point" : "points"}`;
    case "count":
      return Math.round(v).toLocaleString("en-US");
    case "years":
      return `${slotText(v)} ${v === 1 ? "year" : "years"}`;
    case "usd":
      return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
    case "bp":
      return `${slotText(v)} bp`;
    default:
      return slotText(v);
  }
}

/** Unit words a template may already write right after a slot ("{}%", "{} points", "{} years"). */
const UNIT_AFTER = /^(\s*(?:%|per ?cent\b|percentage points?\b|points?\b|pts\b|basis points?\b|bps?\b|-?years?\b|(?:st|nd|rd|th)\b(?:\s+percentile\b)?|percentile\b))/i;

const OWN_AFTER: Partial<Record<ValueUnit, RegExp>> = {
  pct: /^\s*(?:%|per ?cent\b|(?:st|nd|rd|th)\b|percentile\b)/i,
  pts: /^\s*(?:percentage points?\b|points?\b|pts\b)/i,
  years: /^\s*-?years?\b/i,
  bp: /^\s*(?:basis points?\b|bps?\b)/i,
};
/** Unit words that clash with another unit: the template's word is replaced by the value's own unit. */
const SYMBOL_AFTER = /^\s*(?:%|per ?cent\b|percentage points?\b|points?\b|pts\b|basis points?\b|bps?\b)/i;

/**
 * Fills "{}" holes in order with the values at `refs`, each formatted by its
 * declared unit. A unit the template already wrote next to the hole is kept
 * once ("{}%" and "{}" both give "45.7%"); a clashing one ("{}%" for a value
 * in points) gives way to the value's own unit.
 */
export function fillSlots(template: string, refs: string[], values: ReportValues): string {
  let i = 0;
  let out = "";
  let pos = 0;
  const re = /\{\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    out += template.slice(pos, m.index);
    pos = m.index + 2;
    const ref = refs[i++] ?? "";
    const v = resolveRef(values, ref);
    const unit = valueUnit(ref, v);
    const rest = template.slice(pos);
    const after = UNIT_AFTER.exec(rest)?.[1] ?? "";
    const own = OWN_AFTER[unit];
    if (v === null || (typeof v === "number" && !Number.isFinite(v))) {
      out += "n/a";
      if (after && SYMBOL_AFTER.test(rest)) pos += after.length;
    } else if (typeof v === "string" || unit === "count" || unit === "number" || unit === "text") {
      out += formatValue(v, unit);
    } else if (unit === "usd" && out.endsWith("$")) {
      out += Number.isFinite(v) ? Math.abs(v).toFixed(2) : "n/a";
    } else if (own?.test(rest)) {
      out += slotText(v);
    } else if (after && SYMBOL_AFTER.test(rest)) {
      out += formatValue(v, unit);
      pos += after.length;
    } else {
      out += formatValue(v, unit);
    }
  }
  return out + template.slice(pos);
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
    .map((c) => ({ check_id: c.id, severity: c.status === "gate" ? "high" : c.id === 6 || c.id === 9 || c.id === 10 || c.id === 14 ? "high" : "medium", text: fill(c.plain ?? c.detail, values) }));
}
