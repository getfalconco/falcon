/**
 * Insider activity in words: the card's one-line title per event, its date,
 * the path that brings a linked company into view, and the lines behind an
 * opened row. Every sentence states what was filed; none reads into it.
 *
 * Pure: the caller hands in its `say` (the translated table) and language.
 */

import { formatUsd, shortDate, type Say } from "./earnings-view";
import type { InsiderEvent, InsiderRole, InsiderTrade } from "./insider-types";

const ROLE_KEY: Readonly<Record<InsiderRole, string>> = {
  ceo: "insiders.role.ceo",
  cfo: "insiders.role.cfo",
  officer: "insiders.role.officer",
  director: "insiders.role.director",
  owner10: "insiders.role.owner10",
  other: "insiders.role.other",
};

export function roleLabel(role: InsiderRole, say: Say): string {
  return say(ROLE_KEY[role]);
}

function percent(n: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: n >= 0.1 ? 0 : 1 }).format(n);
  } catch {
    return `${Math.round(n * 100)}%`;
  }
}

function stake(pct: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 }).format(pct / 100);
  } catch {
    return `${pct}%`;
  }
}

/** What happened, in one line: "3 insiders made open market purchases, $4.2M". */
export function eventTitle(e: InsiderEvent, say: Say, lang: string): string {
  const value = formatUsd(e.value, lang);
  const role = roleLabel(e.roles[0] ?? "other", say);
  switch (e.kind) {
    case "purchase_cluster":
      return value ? say("insiders.kind.purchaseCluster", { count: e.insiders, value }) : say("insiders.kind.purchaseClusterNoValue", { count: e.insiders });
    case "sale_cluster":
      return value ? say("insiders.kind.saleCluster", { count: e.insiders, value }) : say("insiders.kind.saleClusterNoValue", { count: e.insiders });
    case "large_purchase": {
      const first = e.trades[0];
      const bought = e.trades.reduce((s, t) => s + t.shares, 0);
      const v = value ?? say("insiders.value.unpriced");
      if (first?.firstPosition) return say("insiders.kind.largePurchaseFirst", { role, value: v });
      if (first && first.sharesBefore !== null && first.sharesBefore > 0) {
        const up = bought / first.sharesBefore;
        if (up >= 0.2) return say("insiders.kind.largePurchaseUp", { role, value: v, pct: percent(up, lang) });
      }
      return say("insiders.kind.largePurchase", { role, value: v });
    }
    case "unplanned_sale":
      return say("insiders.kind.unplannedSale", { role, value: value ?? say("insiders.value.unpriced") });
    case "large_unplanned_sale": {
      const v = value ?? say("insiders.value.unpriced");
      const first = e.trades[0];
      const sold = e.trades.reduce((s, t) => s + t.shares, 0);
      if (first && first.sharesBefore !== null && first.sharesBefore > 0 && sold / first.sharesBefore >= 0.1) {
        return say("insiders.kind.largeUnplannedSaleShare", { role, value: v, pct: percent(Math.min(1, sold / first.sharesBefore), lang) });
      }
      return say("insiders.kind.largeUnplannedSale", { role, value: v });
    }
    case "activist_13d": {
      const filer = e.filing?.filer ?? say("insiders.filer.unknown");
      return e.filing?.percent != null ? say("insiders.kind.activist13dPct", { filer, pct: stake(e.filing.percent, lang) }) : say("insiders.kind.activist13d", { filer });
    }
    case "activist_13d_amendment":
      return say("insiders.kind.activist13dAmendment", { filer: e.filing?.filer ?? say("insiders.filer.unknown") });
    case "new_holder_13g": {
      const filer = e.filing?.filer ?? say("insiders.filer.unknown");
      return e.filing?.percent != null ? say("insiders.kind.newHolder13gPct", { filer, pct: stake(e.filing.percent, lang) }) : say("insiders.kind.newHolder13g", { filer });
    }
  }
}

/** The row's date: the latest trade or the filing date, "Oct 6". */
export function eventDate(e: InsiderEvent, lang: string): string {
  return shortDate(e.date, lang);
}

/** "Oct 1 to Oct 6" for a span, the single date otherwise. */
export function eventSpan(e: InsiderEvent, say: Say, lang: string): string {
  return e.firstDate === e.date ? shortDate(e.date, lang) : say("insiders.detail.span", { from: shortDate(e.firstDate, lang), to: shortDate(e.date, lang) });
}

/** "TSM supplier of NVDA"; null for the reader's own names. */
export function pathText(e: InsiderEvent, say: Say): string | null {
  if (!e.via) return null;
  return say(`insiders.path.${e.via.relation}`, { ticker: e.ticker, holding: e.via.holding });
}

/** One trade behind an opened row: "Jane Doe, CFO · Oct 6 · 2,000 shares · $236K". */
export function tradeLine(t: InsiderTrade, say: Say, lang: string): string {
  let shares: string;
  try {
    shares = new Intl.NumberFormat(lang).format(t.shares);
  } catch {
    shares = String(t.shares);
  }
  const date = t.firstDate === t.lastDate ? shortDate(t.lastDate, lang) : say("insiders.detail.span", { from: shortDate(t.firstDate, lang), to: shortDate(t.lastDate, lang) });
  const value = formatUsd(t.value, lang);
  return say(value ? "insiders.detail.trade" : "insiders.detail.tradeNoValue", {
    name: displayName(t.name),
    role: roleLabel(t.role, say),
    date,
    shares,
    value: value ?? "",
  });
}

/**
 * EDGAR spells reporters surname first in capitals ("HUANG JEN HSUN"); shown
 * in title case so a row does not shout. Names already in mixed case stay.
 */
export function displayName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s\-'.(])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** The events the card lists. */
export function cardEvents(events: readonly InsiderEvent[], limit: number): InsiderEvent[] {
  return events.slice(0, limit);
}

/** Only sec.gov addresses open from the card. */
export function safeSecUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/(www\.)?sec\.gov\//i.test(url) ? url : null;
}

/**
 * The Stock tab's Changes section: the focus company's insider events dated
 * on or after the section's start (`since`, YYYY-MM-DD), most significant
 * first. When there are any, they stand in for the section's plain Form 4
 * totals; when there are none, the totals stay.
 */
export function changesInsiderEvents(events: readonly InsiderEvent[] | null | undefined, ticker: string, since: string): InsiderEvent[] {
  const self = ticker.toUpperCase();
  return (events ?? []).filter((e) => e.ticker === self && e.date >= since);
}

/** Who is behind a trade event, for a detail line: "Lisa Su, CEO; Jane Doe, Director +1". */
export function insidersLine(e: InsiderEvent, say: Say, max = 3): string | null {
  if (e.trades.length === 0) return null;
  const seen = new Set<string>();
  const people: string[] = [];
  for (const t of e.trades) {
    const key = t.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(`${displayName(t.name)}, ${roleLabel(t.role, say)}`);
  }
  const shown = people.slice(0, max).join("; ");
  return people.length > max ? `${shown} +${people.length - max}` : shown;
}

/** The filing a row's source link opens: the 13D / 13G, or the latest Form 4. */
export function eventSource(e: InsiderEvent): { label: string; url: string | null } {
  if (e.filing) return { label: e.filing.form, url: safeSecUrl(e.filing.url) };
  const last = [...e.trades].sort((a, b) => a.lastDate.localeCompare(b.lastDate)).pop();
  return { label: "Form 4", url: safeSecUrl(last?.url) };
}
