/** Small helpers the detectors share. Pure. */

import type { Source } from "@falcon/ripple";

export function inWindow(iso: string | null, since: Date, until: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= since.getTime() && t < until.getTime();
}

/** Weekday index of a YYYY-MM-DD date (holidays count as business days; close enough for a 5-day window). */
export function businessDayIndex(ymd: string): number {
  const days = Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 86_400_000);
  // 1970-01-01 was a Thursday: shift so weeks start on Monday.
  const shifted = days + 3;
  const week = Math.floor(shifted / 7);
  const dow = shifted - week * 7; // 0 = Monday
  // A weekend day maps to the following Monday.
  return week * 5 + Math.min(dow, 5);
}

/** Whole-dollar amounts as people read them: $940, $12,500, $1.2M, $3.45B. */
export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${trim(n / 1e9, 2)}B`;
  if (a >= 1e6) return `$${trim(n / 1e6, a >= 1e7 ? 1 : 2)}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

export function shares(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "Nov 10, 2026" from YYYY-MM-DD. */
export function day(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function edgarSource(title: string, url: string, publishedAt: string | null): Source {
  return { title, url, publisher: "SEC EDGAR", ...(publishedAt ? { publishedAt } : {}) };
}

/** Title case for an all-caps EDGAR name ("ACME HOLDINGS INC" -> "Acme Holdings Inc"); mixed case is kept. */
export function displayName(name: string): string {
  const clean = name.replace(/\s*\/\s*[A-Z]{2,4}\s*\/?\s*$/i, "").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bLlc\b/g, "LLC")
    .replace(/\bPlc\b/g, "PLC")
    .replace(/\bLp\b/g, "LP");
}

/**
 * An insider's name for reading. Form 4 writes people "LAST FIRST MIDDLE"
 * (EDGAR's conformed name, sometimes "LAST, FIRST"), so the last name moves
 * to the end; entities keep their name. A free-form "First Last" filing
 * (rare) comes out reversed; quotes keep the name as filed.
 */
export function personName(name: string): string {
  const n = name.trim().replace(/[,\s]+$/, "");
  if (/\b(LLC|L\.?P\.?|INC|CORP|FUND|TRUST|CAPITAL|PARTNERS|HOLDINGS|MANAGEMENT|ADVISORS|LTD|GROUP|FOUNDATION|BANK|PARTNERSHIP|COMPANY)\b/i.test(n)) return displayName(n);
  const comma = /^([^,]+),\s*(.+)$/.exec(n);
  if (comma) return displayName(`${comma[2]} ${comma[1]}`.replace(/,/g, ""));
  let parts = n.split(/\s+/);
  if (parts.length < 2) return displayName(n);
  const suffixes = parts.filter((p) => SUFFIX.test(p));
  parts = parts.filter((p) => !SUFFIX.test(p));
  // "DE ANGOITIA ALFONSO": a particle belongs to the last name.
  let lastLen = 1;
  while (lastLen < parts.length - 1 && PARTICLE.test(parts[lastLen - 1]!)) lastLen++;
  const last = parts.slice(0, lastLen);
  const rest = parts.slice(lastLen);
  return displayName([...rest, ...last, ...suffixes].join(" "));
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?,?$/i;
const PARTICLE = /^(de|del|della|di|da|van|von|der|den|le|la|mac|st\.?)$/i;

/** Runs `fn` over `items` with at most `limit` at once. */
export async function eachLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
