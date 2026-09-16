/**
 * Template filling + the number formats every reason line uses. Pure; the
 * strings themselves live in config (§9) so wording is calibration, not code.
 */

import type { GaugeTemplates } from "./config.js";

export function fill(templates: GaugeTemplates, key: string, vars: Record<string, string | number> = {}): string {
  const template = templates[key];
  if (template == null) throw new Error(`gauge: missing template "${key}"`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v == null ? `{${name}}` : String(v);
  });
}

/** Signed percent from a fraction: 0.0464 → "+4.6%". */
export function fmtSignedPct(v: number, digits = 1): string {
  const pct = v * 100;
  const rounded = Number(pct.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(digits)}%`;
}

/** Unsigned percent from a fraction: 0.049 → "4.9%". */
export function fmtPct(v: number, digits = 1): string {
  return `${(Math.abs(v) * 100).toFixed(digits)}%`;
}

/** Signed value with two decimals, typographic minus: −1.23 → "−1.23". */
export function fmtZ(v: number, digits = 2): string {
  const s = v.toFixed(digits);
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
}

export function fmtRatio(v: number, digits = 2): string {
  return v.toFixed(digits);
}

export function plural(n: number): string {
  return n === 1 ? "" : "s";
}
