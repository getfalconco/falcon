/**
 * F7 `insider_cluster` events for the historical backfill (SEC Insider
 * Transactions Data Sets), design docs/design/ripple-engine-v1.md 3.2:
 *
 *   - open-market purchases only (transaction code P, non-derivative common
 *     stock, acquired), from original Form 4 filings;
 *   - purchases flagged 10b5-1 (AFF10B5ONE, 2023 onward) are dropped;
 *   - routine insiders are dropped: an insider who traded (P or S) the
 *     issuer's stock in the same calendar month in each of the prior three
 *     years (Cohen, Malloy & Pomorski 2012);
 *   - an event is either 3 or more distinct insiders filing purchases at one
 *     issuer within 5 business days, or one officer or director purchase of
 *     $100k or more at a company worth under $2B;
 *   - one event per issuer per cooldown (30 calendar days) so overlapping
 *     triggers of the same episode count once.
 *
 * Event time is the filing that completes the rule; `eventPublicMs` picks it
 * from per-accession acceptance times when they are known.
 *
 * Pure.
 */

import { addDays, isNyseSession } from "./abnormal.ts";

export type PurchaseFiling = {
  accession: string;
  issuerCik: string;
  /** The filing's first reporting owner (one filing = one insider). */
  ownerCik: string;
  /** EDGAR filing date, YYYY-MM-DD. */
  filingDate: string;
  /** Earliest purchase transaction date in the filing. */
  transDate: string;
  isOfficerOrDirector: boolean;
  /** Sum of shares x price over the filing's P transactions. */
  valueUsd: number;
  /** Value-weighted purchase price. */
  price: number;
};

export type InsiderEvent = {
  issuerCik: string;
  date: string;
  kind: "cluster" | "single" | "both";
  /** Distinct insiders with purchase filings in the 5-business-day window ending on `date`. */
  insiders: number;
  /** Purchase value in that window. */
  valueUsd: number;
  /** Filings dated `date` that can complete the rule, with what each does. */
  dayFilings: Array<{ accession: string; ownerCik: string; newOwner: boolean; single: boolean }>;
  /** New insiders needed on `date` to reach the cluster threshold (0 when only the single rule fires). */
  clusterNeeded: number;
  /** The issuer's market value used by the single rule (null if unknown). */
  marketValueUsd: number | null;
};

export const F7_RULES = {
  minInsiders: 3,
  businessDays: 5,
  singleMinUsd: 100_000,
  singleMaxCapUsd: 2_000_000_000,
  cooldownDays: 30,
  routineYears: 3,
} as const;

export type F7Rules = { [K in keyof typeof F7_RULES]: number };

/** Key of an insider at one issuer. */
export function insiderKey(ownerCik: string, issuerCik: string): string {
  return `${ownerCik}|${issuerCik}`;
}

/**
 * Months (YYYY-MM) each insider traded each issuer's stock, from all
 * open-market purchases and sales (codes P and S) by transaction date.
 */
export function tradeMonths(trades: Iterable<{ ownerCik: string; issuerCik: string; transDate: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of trades) {
    const k = insiderKey(t.ownerCik, t.issuerCik);
    let s = out.get(k);
    if (!s) out.set(k, (s = new Set()));
    s.add(t.transDate.slice(0, 7));
  }
  return out;
}

/** CMP routine: traded in the same calendar month in each of the prior `years` years. */
export function isRoutine(months: ReadonlyMap<string, ReadonlySet<string>>, ownerCik: string, issuerCik: string, transDate: string, years: number = F7_RULES.routineYears): boolean {
  const s = months.get(insiderKey(ownerCik, issuerCik));
  if (!s) return false;
  const y = Number(transDate.slice(0, 4));
  const mm = transDate.slice(5, 7);
  for (let k = 1; k <= years; k++) if (!s.has(`${y - k}-${mm}`)) return false;
  return true;
}

/** The NYSE business day `n` business days before a date (the date itself counts as day 0 when it is one). */
export function businessDaysBack(ymd: string, n: number): string {
  let d = ymd;
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    if (isNyseSession(d)) left--;
  }
  return d;
}

/**
 * Insider events from non-routine, non-10b5-1 purchase filings (any order).
 * `marketValue` gives the issuer's market value for a filing (null unknown;
 * the single rule then does not fire).
 */
export function findInsiderEvents(
  filings: readonly PurchaseFiling[],
  marketValue: (f: PurchaseFiling) => number | null,
  rules: F7Rules = F7_RULES,
): InsiderEvent[] {
  const byIssuer = new Map<string, PurchaseFiling[]>();
  for (const f of filings) {
    let a = byIssuer.get(f.issuerCik);
    if (!a) byIssuer.set(f.issuerCik, (a = []));
    a.push(f);
  }
  const out: InsiderEvent[] = [];
  for (const [issuerCik, list] of byIssuer) {
    list.sort((a, b) => (a.filingDate < b.filingDate ? -1 : a.filingDate > b.filingDate ? 1 : a.accession < b.accession ? -1 : 1));
    const dates = [...new Set(list.map((f) => f.filingDate))];
    let lastEvent: string | null = null;
    for (const d of dates) {
      if (lastEvent !== null && d <= addDays(lastEvent, rules.cooldownDays)) continue;
      const from = businessDaysBack(d, rules.businessDays - 1);
      const win = list.filter((f) => f.filingDate >= from && f.filingDate <= d);
      const before = new Set(win.filter((f) => f.filingDate < d).map((f) => f.ownerCik));
      const owners = new Set(win.map((f) => f.ownerCik));
      const today = win.filter((f) => f.filingDate === d);
      const cluster = owners.size >= rules.minInsiders;
      let mv: number | null = null;
      const singles = new Set<string>();
      for (const f of today) {
        if (!f.isOfficerOrDirector || f.valueUsd < rules.singleMinUsd) continue;
        const v = marketValue(f);
        if (v !== null && mv === null) mv = v;
        if (v !== null && v < rules.singleMaxCapUsd) singles.add(f.accession);
      }
      if (!cluster && !singles.size) continue;
      const seen = new Set(before);
      const dayFilings = today.map((f) => {
        const newOwner = !seen.has(f.ownerCik);
        seen.add(f.ownerCik);
        return { accession: f.accession, ownerCik: f.ownerCik, newOwner, single: singles.has(f.accession) };
      });
      out.push({
        issuerCik,
        date: d,
        kind: cluster && singles.size ? "both" : cluster ? "cluster" : "single",
        insiders: owners.size,
        valueUsd: win.reduce((s, f) => s + f.valueUsd, 0),
        dayFilings,
        clusterNeeded: cluster ? Math.max(0, rules.minInsiders - before.size) : 0,
        marketValueUsd: mv,
      });
      lastEvent = d;
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.issuerCik < b.issuerCik ? -1 : 1));
}

/**
 * When an event became public: the earliest acceptance that completes either
 * rule, from per-accession acceptance instants. Null when a needed accession
 * has no known time (the caller then falls back to the filing date's close).
 */
export function eventPublicMs(event: InsiderEvent, acceptedMs: ReadonlyMap<string, number>): number | null {
  const candidates: number[] = [];
  for (const f of event.dayFilings) if (f.single && acceptedMs.has(f.accession)) candidates.push(acceptedMs.get(f.accession)!);
  if (event.kind !== "single") {
    if (event.clusterNeeded === 0) return null;
    // Per new owner, the earliest of their filings that day; the needed-th earliest of those.
    const firstByOwner = new Map<string, number>();
    let unknown = false;
    for (const f of event.dayFilings) {
      if (!f.newOwner) continue;
      const t = acceptedMs.get(f.accession);
      if (t === undefined) {
        unknown = true;
        continue;
      }
      firstByOwner.set(f.ownerCik, Math.min(firstByOwner.get(f.ownerCik) ?? Infinity, t));
    }
    const ts = [...firstByOwner.values()].sort((a, b) => a - b);
    // With some times unknown the needed-th known time is an upper bound: a later (conservative) entry.
    if (ts.length >= event.clusterNeeded) candidates.push(ts[event.clusterNeeded - 1]!);
    else if (unknown && !candidates.length) return null;
  }
  return candidates.length ? Math.min(...candidates) : null;
}
