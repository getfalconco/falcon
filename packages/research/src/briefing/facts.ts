/**
 * Filings and insiders: the order the briefing lists its facts in, and how
 * many it lists.
 *
 * The facts are records the desktop's SEC readers already keep (a red flag in
 * a filing, an insider cluster, a linked company's report date, a new risk
 * factor heading); this module only ranks and caps them. The rank is fixed,
 * not scored, so the same records always print in the same order:
 *
 *   0  red flags (restatement, auditor change, going concern, material
 *      weakness, late filing notice)
 *   1  insider clusters (2+ insiders' purchases, 3+ insiders' sales)
 *   2  a linked company reporting on the session this report hands over to;
 *      a reader's own name's earnings release with a figure outside its
 *      guide, or a guide raised or cut against the earlier one
 *   3  new risk factors in the latest 10-K or 10-Q
 *   4  the rest: other insider events, a linked report on the session
 *      after, a release with its figure inside the guide, a customer or
 *      supplier named for the first time, a share moved
 *
 * Inside a rank: held names before watched ones, the later date first, then
 * the kind, the ticker and the id. At most MAX_BRIEFING_FACTS are kept.
 *
 * Pure: no fs, no network, no clock.
 */

import type { BriefingFact, BriefingFactKind } from "./types.js";

/** The panel shows a glance, not a feed. */
export const MAX_BRIEFING_FACTS = 5;

const TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const KIND_ORDER: Record<BriefingFactKind, number> = {
  red_flag: 0,
  insider: 1,
  linked_report: 2,
  guidance_result: 3,
  guidance_revision: 4,
  risk_factor: 5,
  counterparty_named: 6,
  share_change: 7,
};

/** The fixed rank above; lower is listed first. */
export function factTier(fact: BriefingFact): number {
  switch (fact.kind) {
    case "red_flag":
      return 0;
    case "insider":
      return fact.event === "purchase_cluster" || fact.event === "sale_cluster" ? 1 : 4;
    case "linked_report":
      return fact.on_session ? 2 : 4;
    case "guidance_result":
      return fact.position === "inside" ? 4 : 2;
    case "guidance_revision":
      return 2;
    case "risk_factor":
      return 3;
    default:
      return 4;
  }
}

/**
 * An address on sec.gov over https, or null. The panel opens it in the
 * browser, so anything else (another host, another scheme) is dropped here
 * rather than trusted because the reader that produced it is our own.
 */
export function secUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  return host === "sec.gov" || host.endsWith(".sec.gov") ? url.toString() : null;
}

function wellFormed(fact: unknown): fact is BriefingFact {
  if (fact === null || typeof fact !== "object") return false;
  const f = fact as Partial<BriefingFact>;
  return (
    typeof f.id === "string" &&
    f.id !== "" &&
    typeof f.kind === "string" &&
    f.kind in KIND_ORDER &&
    typeof f.ticker === "string" &&
    TICKER.test(f.ticker) &&
    (f.scope === "held" || f.scope === "watchlist") &&
    typeof f.date === "string" &&
    YMD.test(f.date)
  );
}

function compare(a: BriefingFact, b: BriefingFact): number {
  return (
    factTier(a) - factTier(b) ||
    (a.scope === b.scope ? 0 : a.scope === "held" ? -1 : 1) ||
    b.date.localeCompare(a.date) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    (a.kind === "insider" && b.kind === "insider" ? b.score - a.score : 0) ||
    a.ticker.localeCompare(b.ticker) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The facts in the fixed order, one per id, at most `max`. Malformed entries
 * are dropped and every link is held to sec.gov, so whatever a source hands
 * over, what reaches the panel has the shape the panel draws.
 */
export function rankBriefingFacts(facts: readonly unknown[], max = MAX_BRIEFING_FACTS): BriefingFact[] {
  const seen = new Set<string>();
  const kept: BriefingFact[] = [];
  for (const raw of Array.isArray(facts) ? facts : []) {
    if (!wellFormed(raw) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    kept.push({ ...raw, url: secUrl(raw.url) });
  }
  return kept.sort(compare).slice(0, Math.max(0, Math.floor(max)));
}
