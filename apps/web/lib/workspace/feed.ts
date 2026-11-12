import {
  isWeakSignal,
  opportunityCard,
  type Confidence,
  type Direction,
  type LinkEvidence,
  type Relation,
  type RippleCard,
  type RippleHit,
  type SightingsFeed,
  type TodaySummary,
} from "@falcon/ripple";
import { SECTORS } from "@/lib/onboarding";

/**
 * Everything the Workspace derives from a Sightings feed, client-side: the
 * Today summary (Net direction v0), per-ticker exposure, the events touching a
 * ticker and its connections. Pure functions, no fetching.
 *
 * Framing: information about what the record shows. Nothing here ranks a
 * stock as something to buy or sell.
 */

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { low: 0.34, medium: 0.67, high: 1 };
const DEGREE_WEIGHT: Record<1 | 2, number> = { 1: 1, 2: 0.5 };
const DIRECTION_SIGN: Record<Direction, number> = { up: 1, down: -1, unclear: 0 };

export const RELATIONS: readonly Relation[] = ["customer", "supplier", "competitor", "peer"];

export const RELATION_LABEL: Record<Relation, string> = {
  customer: "Customer",
  supplier: "Supplier",
  competitor: "Competitor",
  peer: "Peer",
};

/** "Supplier to NVDA", "Customer of NVDA": the hit company seen from the other one. */
export function relationPhrase(relation: Relation, other: string): string {
  switch (relation) {
    case "supplier":
      return `Supplier to ${other}`;
    case "customer":
      return `Customer of ${other}`;
    case "competitor":
      return `Competitor of ${other}`;
    case "peer":
      return `Peer of ${other}`;
  }
}

/** The same link seen from the other end. */
export const INVERSE: Record<Relation, Relation> = {
  customer: "supplier",
  supplier: "customer",
  competitor: "competitor",
  peer: "peer",
};

export const KIND_LABEL: Record<RippleCard["event"]["kind"], string> = {
  earnings_surprise: "Earnings",
  guidance: "Guidance",
  filing: "Filing",
  news: "News",
};

export function hitWeight(hit: Pick<RippleHit, "confidence" | "degree">): number {
  return CONFIDENCE_WEIGHT[hit.confidence] * DEGREE_WEIGHT[hit.degree];
}

/** Net direction for a set of hits: -100 (all down) to 100 (all up), null with no hits. */
export function netDirection(hits: readonly Pick<RippleHit, "confidence" | "degree" | "direction">[]): number | null {
  let total = 0;
  let signed = 0;
  for (const hit of hits) {
    const w = hitWeight(hit);
    total += w;
    signed += w * DIRECTION_SIGN[hit.direction];
  }
  if (total === 0) return null;
  return Math.round((signed / total) * 100);
}

export function toSet(tickers: readonly string[]): Set<string> {
  return new Set(tickers.map((t) => t.toUpperCase()));
}

/** True when the card's event company or any company it hits is in `focus`. */
export function touchesFocus(card: RippleCard, focus: Set<string>): boolean {
  return focus.has(card.event.ticker) || card.hits.some((h) => focus.has(h.ticker));
}

/** The card's hits on focus-list companies (the event itself carries no direction). */
export function focusHits(card: RippleCard, focus: Set<string>): RippleHit[] {
  return card.hits.filter((h) => focus.has(h.ticker));
}

/** Newest event first. */
export function sortByTime(cards: readonly RippleCard[]): RippleCard[] {
  return [...cards].sort((a, b) => Date.parse(b.event.occurredAt) - Date.parse(a.event.occurredAt));
}

export type TickerExposure = {
  ticker: string;
  companyName: string;
  /** Sum of hit weights: how much of today's feed reaches this ticker. */
  weight: number;
  net: number | null;
  events: number;
};

/** Every focus ticker with what the feed shows about it, most reached first. Weak signals do not count. */
export function exposureByTicker(
  feed: SightingsFeed | null,
  focus: readonly { ticker: string; name?: string }[],
): TickerExposure[] {
  const rows = focus.map((f) => {
    const hits: RippleHit[] = [];
    let events = 0;
    let companyName = f.name ?? "";
    for (const card of feed?.cards ?? []) {
      if (isWeakSignal(card)) continue;
      const own = card.hits.filter((h) => h.ticker === f.ticker);
      if (own.length || card.event.ticker === f.ticker) events += 1;
      hits.push(...own);
      if (!companyName) companyName = own[0]?.companyName ?? (card.event.ticker === f.ticker ? card.event.companyName : "");
    }
    return {
      ticker: f.ticker,
      companyName,
      weight: hits.reduce((s, h) => s + hitWeight(h), 0),
      net: netDirection(hits),
      events,
    };
  });
  return rows.sort((a, b) => b.weight - a.weight || b.events - a.events || a.ticker.localeCompare(b.ticker));
}

function eventCount(n: number): string {
  return n === 1 ? "1 event is" : `${n} events are`;
}

/**
 * The Today summary, built from the feed and the member's focus list. Weak
 * signals (card confidence "low") are on neither list; Opportunities hold
 * only the hits the engine marked eligible (@falcon/ripple `opportunityCard`).
 */
export function buildTodaySummary(
  feed: SightingsFeed | null,
  focusTickers: readonly string[],
  now = new Date(),
): TodaySummary {
  const focus = toSet(focusTickers);
  const cards = sortByTime(feed?.cards ?? []);
  const portfolio = cards.filter((c) => touchesFocus(c, focus) && !isWeakSignal(c));
  const opportunities = cards
    .filter((c) => !touchesFocus(c, focus))
    .map((c) => opportunityCard(c, focus))
    .filter((c): c is RippleCard => c !== null);
  const hits = portfolio.flatMap((c) => focusHits(c, focus));
  const value = netDirection(hits);

  let why: string;
  if (focus.size === 0) {
    why = "Your focus list is empty.";
  } else if (portfolio.length === 0) {
    why = "No events are hitting your portfolio right now.";
  } else {
    const top = exposureByTicker({ generatedAt: feed?.generatedAt ?? "", cards: portfolio }, Array.from(focus).map((ticker) => ({ ticker })))[0];
    why =
      top && top.weight > 0
        ? `${eventCount(portfolio.length)} hitting your portfolio. ${top.ticker} is the most exposed.`
        : `${eventCount(portfolio.length)} hitting your portfolio.`;
  }

  return {
    date: now.toISOString().slice(0, 10),
    metric: { kind: "net_direction", value, label: "Net direction" },
    why,
    portfolio,
    opportunities,
  };
}

/** Events where `ticker` is hit, and events at `ticker` itself. */
export function cardsForTicker(feed: SightingsFeed | null, ticker: string) {
  const hitting: { card: RippleCard; hit: RippleHit }[] = [];
  const at: RippleCard[] = [];
  for (const card of sortByTime(feed?.cards ?? [])) {
    if (card.event.ticker === ticker) at.push(card);
    const hit = card.hits.find((h) => h.ticker === ticker);
    if (hit) hitting.push({ card, hit });
  }
  return { hitting, at };
}

export type Connection = {
  ticker: string;
  companyName: string;
  /** How this company relates to the one the page is about. */
  relation: Relation | null;
  /** Phrase as seen from the page's company, e.g. "Supplier to NVDA". */
  phrase: string;
  evidence: LinkEvidence[];
  cardIds: string[];
};

/** The companies the feed links to `ticker`, with the filing quotes behind each link. */
export function connectionsFor(feed: SightingsFeed | null, ticker: string): Connection[] {
  const byTicker = new Map<string, Connection>();
  const add = (c: Omit<Connection, "cardIds" | "evidence">, evidence: LinkEvidence[], cardId: string) => {
    const existing = byTicker.get(c.ticker);
    if (existing) {
      for (const e of evidence) if (!existing.evidence.some((x) => x.quote === e.quote)) existing.evidence.push(e);
      if (!existing.cardIds.includes(cardId)) existing.cardIds.push(cardId);
      return;
    }
    byTicker.set(c.ticker, { ...c, evidence: [...evidence], cardIds: [cardId] });
  };

  for (const card of feed?.cards ?? []) {
    if (card.event.ticker === ticker) {
      // Companies this ticker's events reach directly.
      for (const hit of card.hits) {
        if (hit.degree !== 1 || hit.ticker === ticker) continue;
        add(
          { ticker: hit.ticker, companyName: hit.companyName, relation: hit.relation, phrase: relationPhrase(hit.relation, ticker) },
          hit.evidence,
          card.id,
        );
      }
    }
    const own = card.hits.find((h) => h.ticker === ticker);
    if (!own) continue;
    // The company the ripple reached this ticker through.
    const from = own.degree === 2 && own.via ? own.via : card.event.ticker;
    if (from === ticker) continue;
    const fromName =
      from === card.event.ticker ? card.event.companyName : card.hits.find((h) => h.ticker === from)?.companyName ?? from;
    add(
      { ticker: from, companyName: fromName, relation: INVERSE[own.relation], phrase: relationPhrase(INVERSE[own.relation], ticker) },
      own.evidence,
      card.id,
    );
  }
  return Array.from(byTicker.values()).sort((a, b) => b.evidence.length - a.evidence.length || a.ticker.localeCompare(b.ticker));
}

/** A company name for `ticker` from anywhere in the feed. */
export function companyNameFor(feed: SightingsFeed | null, ticker: string): string | null {
  for (const card of feed?.cards ?? []) {
    if (card.event.ticker === ticker) return card.event.companyName;
    const hit = card.hits.find((h) => h.ticker === ticker);
    if (hit) return hit.companyName;
  }
  return null;
}

/** The sector the feed files `ticker` under (the event company's card sector). */
export function sectorFor(feed: SightingsFeed | null, ticker: string): string | null {
  for (const card of feed?.cards ?? []) if (card.event.ticker === ticker) return card.sector;
  for (const card of feed?.cards ?? []) if (card.hits.some((h) => h.ticker === ticker)) return card.sector;
  return null;
}

const SECTOR_ALIASES: Record<string, string> = { semis: "Semiconductors", tech: "Technology" };

/** A sector id from the engine ("semis", "real_estate") as a label. */
export function sectorLabel(sector: string): string {
  const key = sector.trim().toLowerCase();
  const known = SECTOR_ALIASES[key] ?? SECTORS.find((s) => s.id === key)?.label;
  if (known) return known;
  const words = key.replace(/[_-]+/g, " ");
  return words ? words[0].toUpperCase() + words.slice(1) : "Unclassified";
}

/** Accepts the feed bare or wrapped ({ feed }); anything else is treated as no feed. */
export function parseFeed(body: unknown): SightingsFeed | null {
  const candidate =
    body && typeof body === "object" && "feed" in body ? (body as { feed: unknown }).feed : body;
  if (!candidate || typeof candidate !== "object") return null;
  const cards = (candidate as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return null;
  const valid = cards.filter(
    (c): c is RippleCard =>
      !!c &&
      typeof c === "object" &&
      typeof (c as RippleCard).id === "string" &&
      !!(c as RippleCard).event &&
      typeof (c as RippleCard).event.ticker === "string" &&
      Array.isArray((c as RippleCard).hits),
  );
  const generatedAt = (candidate as { generatedAt?: unknown }).generatedAt;
  return {
    generatedAt: typeof generatedAt === "string" ? generatedAt : new Date().toISOString(),
    // Defaults for anything optional-looking, so one odd card never breaks a screen.
    cards: valid.map((c) => ({
      ...c,
      sector: sectorLabel(typeof c.sector === "string" ? c.sector : ""),
      event: {
        ...c.event,
        companyName: c.event.companyName || c.event.ticker,
        headline: c.event.headline || "",
        summary: c.event.summary || "",
        source: c.event.source ?? { title: "", url: "", publisher: "" },
      },
      hits: c.hits
        .filter((h) => !!h && typeof h.ticker === "string")
        .map((h) => ({ ...h, evidence: Array.isArray(h.evidence) ? h.evidence : [], history: h.history ?? null })),
    })),
  };
}
