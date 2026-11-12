import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import type { Confidence, Direction, RippleCard, RippleHit, SightingsFeed, TodaySummary } from "@falcon/ripple";
import { heldTickers, useHoldings, type Holdings } from "./holdings";
import { SECTORS, type SectorId } from "./onboarding";

/**
 * The Sightings feed from the Ripple Engine (GET /api/sightings on the app
 * host) and the Today summary built from it on the phone.
 */

/**
 * The app host that serves /api/sightings. The browser preview talks to the
 * local site (http://app.localhost:3000); everything else to app.getfalcon.co.
 * EXPO_PUBLIC_API_BASE overrides both.
 */
export const API_BASE = (
  process.env.EXPO_PUBLIC_API_BASE ||
  (Platform.OS === "web" && __DEV__ ? "http://app.localhost:3000" : "https://app.getfalcon.co")
).replace(/\/$/, "");

/**
 * Development only: a local fixture shaped like the contract, for designing
 * while the engine API is not up. "1" always uses it, "0" never, anything else
 * only when the API can't be reached. Release builds never load it.
 */
const FIXTURE_MODE = (process.env.EXPO_PUBLIC_SIGHTINGS_FIXTURE ?? "").trim();

const TIMEOUT_MS = 8000;
/** Coming back to the app after this long asks for the feed again. */
const STALE_MS = 5 * 60 * 1000;

export type FeedStatus = "loading" | "ready" | "unavailable";

export type FeedState = {
  status: FeedStatus;
  feed: SightingsFeed | null;
  /** True when the cards come from the development fixture. */
  sample: boolean;
  /** Tickers the feed was asked for, comma separated. */
  key: string | null;
  refreshing: boolean;
  /** When the last answer (or failure) came in, ms since epoch. */
  loadedAt: number;
};

let state: FeedState = { status: "loading", feed: null, sample: false, key: null, refreshing: false, loadedAt: 0 };
let inflight: { key: string; promise: Promise<void> } | null = null;
let requests = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<FeedState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

function isCard(value: unknown): value is RippleCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<RippleCard>;
  return (
    typeof card.id === "string" &&
    !!card.event &&
    typeof card.event.ticker === "string" &&
    typeof card.event.headline === "string" &&
    Array.isArray(card.hits)
  );
}

/** The feed out of a response body; tolerates a `{ feed }` wrapper. */
function readFeed(body: unknown): SightingsFeed | null {
  if (!body || typeof body !== "object") return null;
  const root = body as { cards?: unknown; feed?: { cards?: unknown; generatedAt?: unknown }; generatedAt?: unknown };
  const source = Array.isArray(root.cards) ? root : root.feed && Array.isArray(root.feed.cards) ? root.feed : null;
  if (!source) return null;
  const cards = (source.cards as unknown[]).filter(isCard).map((card) => ({
    ...card,
    hits: card.hits.filter((hit) => hit && typeof hit.ticker === "string"),
  }));
  const generatedAt = typeof source.generatedAt === "string" ? source.generatedAt : new Date().toISOString();
  return { generatedAt, cards };
}

async function requestFeed(tickers: string): Promise<SightingsFeed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/sightings?tickers=${encodeURIComponent(tickers)}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sightings ${res.status}`);
    const feed = readFeed(await res.json());
    if (!feed) throw new Error("sightings: unexpected body");
    return feed;
  } finally {
    clearTimeout(timer);
  }
}

function devFixture(): SightingsFeed | null {
  if (!__DEV__ || FIXTURE_MODE === "0") return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sampleFeed } = require("@/features/sightings/fixture") as typeof import("@/features/sightings/fixture");
  return sampleFeed();
}

function load(key: string, refreshing: boolean): Promise<void> {
  if (inflight && inflight.key === key) return inflight.promise;
  if (refreshing) set({ refreshing: true });
  else set({ status: state.key === key && state.feed ? state.status : "loading", key });

  const request = ++requests;
  const promise = (async () => {
    // Lets `inflight` be set before any result lands.
    await Promise.resolve();
    let feed: SightingsFeed | null = null;
    let sample = false;
    if (__DEV__ && FIXTURE_MODE === "1") {
      feed = devFixture();
      sample = feed !== null;
    } else {
      try {
        feed = await requestFeed(key);
      } catch {
        feed = devFixture();
        sample = feed !== null;
      }
    }
    // A newer request (other tickers) took over while this one ran.
    if (request !== requests) return;
    inflight = null;
    // A failed refresh keeps the cards already on screen.
    if (!feed && state.key === key && state.feed) {
      set({ refreshing: false, loadedAt: Date.now() });
      return;
    }
    set({ status: feed ? "ready" : "unavailable", feed, sample, key, refreshing: false, loadedAt: Date.now() });
  })();
  inflight = { key, promise };
  return promise;
}

// Back in the foreground after a while (the morning open): ask again.
AppState.addEventListener("change", (next) => {
  if (next !== "active" || state.key === null || inflight) return;
  if (Date.now() - state.loadedAt < STALE_MS) return;
  void load(state.key, state.feed !== null);
});

/**
 * The feed for the member's holdings. Loads on first use and again when the
 * holdings change; `refresh` asks again (pull to refresh).
 */
export function useSightings(): FeedState & { holdings: Holdings | null | undefined; refresh: () => Promise<void> } {
  const holdings = useHoldings();
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const key = holdings === undefined ? null : [...heldTickers(holdings)].sort().join(",");

  useEffect(() => {
    if (key === null) return;
    if (state.key === key && state.status !== "loading") return;
    void load(key, false);
  }, [key]);

  const refresh = useCallback(() => (key === null ? Promise.resolve() : load(key, true)), [key]);

  // Until the holdings are read, the feed counts as loading.
  const view = key === null || snapshot.key !== key ? { ...snapshot, status: "loading" as const } : snapshot;
  return { ...view, holdings, refresh };
}

/* ------------------------------------------------------------------ */
/* Today                                                               */
/* ------------------------------------------------------------------ */

const WEIGHT: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
const SIGN: Record<Direction, number> = { up: 1, down: -1, unclear: 0 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_RANK[confidence] ?? 0;
}

/** The card's hits on held tickers. */
export function heldHits(card: RippleCard, held: Set<string>): RippleHit[] {
  return card.hits.filter((hit) => held.has(hit.ticker.toUpperCase()));
}

/** Whether the card reaches the portfolio: a held company is hit, or is the event company. */
export function hitsPortfolio(card: RippleCard, held: Set<string>): boolean {
  return held.has(card.event.ticker.toUpperCase()) || heldHits(card, held).length > 0;
}

/** Hits in the order a card lists them: held first, then by confidence, then direct links. */
export function orderedHits(card: RippleCard, held: Set<string>): RippleHit[] {
  return [...card.hits].sort((a, b) => {
    const heldDiff = Number(held.has(b.ticker.toUpperCase())) - Number(held.has(a.ticker.toUpperCase()));
    if (heldDiff) return heldDiff;
    const confidenceDiff = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (confidenceDiff) return confidenceDiff;
    return a.degree - b.degree;
  });
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function sectorKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_|_$/g, "");
}

function followsSector(card: RippleCard, sectors: Set<string>): boolean {
  return sectors.has(sectorKey(card.sector ?? ""));
}

/** Weight of the held hits on a card (how hard it presses on the portfolio). */
function portfolioWeight(card: RippleCard, held: Set<string>): number {
  const direct = held.has(card.event.ticker.toUpperCase()) ? WEIGHT.high : 0;
  return direct + heldHits(card, held).reduce((sum, hit) => sum + (WEIGHT[hit.confidence] ?? 1), 0);
}

function topConfidence(card: RippleCard): number {
  return card.hits.reduce((best, hit) => Math.max(best, confidenceRank(hit.confidence)), -1);
}

/** Cards that reach the portfolio, the ones that press hardest first. */
export function portfolioCards(cards: RippleCard[], held: Set<string>): RippleCard[] {
  return cards
    .filter((card) => hitsPortfolio(card, held))
    .sort(
      (a, b) =>
        portfolioWeight(b, held) - portfolioWeight(a, held) || time(b.event.occurredAt) - time(a.event.occurredAt),
    );
}

/** Cards that only reach companies outside the portfolio; followed sectors first. */
export function opportunityCards(cards: RippleCard[], held: Set<string>, sectors: SectorId[]): RippleCard[] {
  const followed = new Set<string>(
    sectors.flatMap((id) => [id, sectorKey(SECTORS.find((s) => s.id === id)?.label ?? id)]),
  );
  return cards
    .filter((card) => card.hits.length > 0 && !hitsPortfolio(card, held))
    .sort(
      (a, b) =>
        Number(followsSector(b, followed)) - Number(followsSector(a, followed)) ||
        topConfidence(b) - topConfidence(a) ||
        time(b.event.occurredAt) - time(a.event.occurredAt),
    );
}

/**
 * Net direction, -100 to 100: the held hits' directions weighted by
 * confidence (low 1, medium 2, high 3), over the total weight. Null with no
 * held hits.
 */
export function netDirection(cards: RippleCard[], held: Set<string>): number | null {
  let signed = 0;
  let total = 0;
  for (const card of cards) {
    for (const hit of heldHits(card, held)) {
      const weight = WEIGHT[hit.confidence] ?? 1;
      signed += (SIGN[hit.direction] ?? 0) * weight;
      total += weight;
    }
  }
  if (total === 0) return null;
  return Math.max(-100, Math.min(100, Math.round((signed / total) * 100)));
}

/** The held ticker the day's cards press on hardest. */
function mostExposed(cards: RippleCard[], held: Set<string>): string | null {
  const load = new Map<string, number>();
  const add = (ticker: string, weight: number) => load.set(ticker, (load.get(ticker) ?? 0) + weight);
  for (const card of cards) {
    const eventTicker = card.event.ticker.toUpperCase();
    if (held.has(eventTicker)) add(eventTicker, WEIGHT.high);
    for (const hit of heldHits(card, held)) add(hit.ticker.toUpperCase(), WEIGHT[hit.confidence] ?? 1);
  }
  let best: string | null = null;
  let bestLoad = 0;
  for (const [ticker, value] of load) {
    if (value > bestLoad) {
      best = ticker;
      bestLoad = value;
    }
  }
  return best;
}

function whyLine(portfolio: RippleCard[], held: Set<string>): string {
  if (held.size === 0) return "No holdings added yet.";
  const n = portfolio.length;
  if (n === 0) return "Nothing is hitting your portfolio today.";
  const count = `${n} ${n === 1 ? "event is" : "events are"} hitting your portfolio.`;
  const top = mostExposed(portfolio, held);
  return top ? `${count} ${top} is the most exposed.` : count;
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's top block, built from the feed on the phone. */
export function buildToday(feed: SightingsFeed | null, holdings: Holdings | null | undefined): TodaySummary {
  const held = heldTickers(holdings);
  const cards = feed?.cards ?? [];
  const portfolio = portfolioCards(cards, held);
  return {
    date: localDate(new Date()),
    metric: { kind: "net_direction", value: netDirection(portfolio, held), label: "Net direction" },
    why: feed ? whyLine(portfolio, held) : "",
    portfolio,
    opportunities: opportunityCards(cards, held, holdings?.sectors ?? []),
  };
}

/** A card from the loaded feed by id. */
export function useSightingCard(id: string | undefined) {
  const sightings = useSightings();
  const card = id ? (sightings.feed?.cards.find((c) => c.id === id) ?? null) : null;
  return { ...sightings, card };
}
