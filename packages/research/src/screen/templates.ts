/**
 * Template filling + the number formats every read uses. Pure; the strings
 * live in config (§9) so wording is calibration, not code. Deliberately not
 * shared with Gauge's helpers — Screen is read-only towards Gauge.
 */

import type { ScreenTemplates } from "./config.js";

export function fill(templates: ScreenTemplates, key: string, vars: Record<string, string | number> = {}): string {
  const template = templates[key];
  if (template == null) throw new Error(`screen: missing template "${key}"`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v == null ? `{${name}}` : String(v);
  });
}

/** Signed percent from a fraction: 0.0464 → "+4.6%" (typographic minus). */
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

/** Two-decimal value with a typographic minus. */
export function fmtZ(v: number, digits = 2): string {
  const s = v.toFixed(digits);
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
}

export function fmtRatio(v: number, digits = 2): string {
  return v.toFixed(digits);
}

/** Compact USD: 1_250_000 → "$1.3M", 80_000 → "$80K". */
export function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(abs / 1e3)}K`;
  return `$${Math.round(abs)}`;
}

/** Round a value for the payload (4 significant decimals keep it readable in JSON). */
export function round4(v: number | null): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

/**
 * §6 guard — banned words (and their plain inflections: -s, -ed, -ing) as
 * whole words, case-insensitive. "buying" trips "buy"; "hedging" trips
 * "hedge" (dropped e); "diversified" trips "diversify" (y→i); "address" does
 * not trip "add", "longer" does not trip "long".
 */
export function bannedWordHits(text: string, bannedWords: string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const hits: string[] = [];
  for (const word of bannedWords) {
    const trimmed = word.trim();
    if (!trimmed) continue;
    const stems = [esc(trimmed)];
    if (/e$/i.test(trimmed)) stems.push(esc(trimmed.slice(0, -1))); // hedge → hedging/hedged
    if (/y$/i.test(trimmed)) stems.push(`${esc(trimmed.slice(0, -1))}i`); // diversify → diversified/diversifies
    // An optional doubled final consonant covers "stopped" / "trimming".
    const last = esc(trimmed.slice(-1));
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(?:${stems.join("|")})(?:${last})?(s|es|ed|ing)?(?=$|[^\\p{L}\\p{N}_])`, "iu");
    if (re.test(text)) hits.push(word);
  }
  return hits;
}
