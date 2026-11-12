/**
 * "Backtest this" on a Sightings card: rules that test past events of the
 * card's type on the companies it reaches.
 *
 *   earnings_surprise card  Buy the linked companies at the open after each past
 *                           release of the event company with an EPS beat (or
 *                           miss, as on the card), hold for the card's window.
 *                           Real data: the event company's earnings history.
 *   guidance, filing, news  The same window after a ripple card reaches the
 *                           company with the card's relation and direction.
 *                           Ripple card history is not connected yet, so these
 *                           runs show no trades until it is.
 *
 * Long positions only (the backtester does not short). Type-only imports, so
 * the iPhone app can use this file without the schema's runtime.
 */

import type { Direction, Relation, RippleCard, RippleHit } from "@falcon/ripple";
import type { Condition, Strategy } from "./schema";

/** Same spelling rule as the schema's TICKER_RE (kept local: no runtime import). */
const TICKER = /^\^?[A-Z0-9][A-Z0-9.\-]{0,9}$/;
/** Leaves room under the 25-ticker cap and keeps a cold run inside the API deadline. */
const MAX_UNIVERSE = 12;
const DEFAULT_HOLD = 5;
const MAX_HOLD = 60;

export type SightingBacktest = {
  strategy: Strategy;
  /** How the card became rules, one neutral sentence each. */
  notes: string[];
  /** False when the event type has no history in the data yet (the run has no trades). */
  hasHistory: boolean;
  holdDays: number;
  /** What the rules test, short: "NVDA EPS beats", "ripple cards like this one". */
  basis: string;
};

const CONF_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Upper end of a window in words, in trading days ("1 to 5 trading days" is 5, "1 to 4 weeks" is 20). */
export function windowDays(text: string): number | null {
  const nums = (text.match(/\d+/g) ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const unit = /month/i.test(text) ? 21 : /week/i.test(text) ? 5 : 1;
  return Math.max(...nums) * unit;
}

function holdFor(hits: readonly RippleHit[]): number {
  const days = hits.map((h) => h.history?.windowDays ?? windowDays(h.window)).filter((d): d is number => d !== null);
  const d = days.length ? Math.max(...days) : DEFAULT_HOLD;
  return Math.min(MAX_HOLD, Math.max(1, Math.round(d)));
}

/** Beat or miss, from the card's words, else from how the linked companies are expected to move. */
function isBeat(card: RippleCard): boolean {
  const text = `${card.event.headline} ${card.event.summary}`.toLowerCase();
  const beat = /\b(above|beat|beats|topped|exceeded|ahead of)\b/.test(text);
  const miss = /\b(below|miss|missed|short of|under)\b/.test(text);
  if (beat !== miss) return beat;
  const linked = card.hits.find((h) => h.degree === 1 && h.relation !== "competitor" && h.direction !== "unclear");
  return linked ? linked.direction === "up" : true;
}

function only<T>(values: readonly T[]): T | null {
  return values.length && values.every((v) => v === values[0]) ? values[0]! : null;
}

export function strategyFromSighting(card: RippleCard): SightingBacktest {
  const eventTicker = card.event.ticker.trim().toUpperCase();
  const seen = new Set<string>([eventTicker]);
  const all = [...card.hits]
    .sort((a, b) => a.degree - b.degree || CONF_RANK[a.confidence] - CONF_RANK[b.confidence])
    .filter((h) => {
      const t = h.ticker.trim().toUpperCase();
      if (!TICKER.test(t) || seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  const up = all.filter((h) => h.direction === "up");
  const chosen = (up.length ? up : all).slice(0, MAX_UNIVERSE);
  const universe = chosen.map((h) => h.ticker.trim().toUpperCase());
  const holdDays = holdFor(chosen);
  const notes: string[] = [];
  if (!universe.length) {
    universe.push(eventTicker);
    notes.push("The card lists no linked companies, so the rules trade the event company itself.");
  } else if (up.length && up.length < all.length) {
    notes.push(`Long positions only: the ${up.length === 1 ? "company" : `${up.length} companies`} the card expects to move up.`);
  } else if (!up.length) {
    notes.push("Long positions only, so the run shows how the linked companies moved, whatever the card's direction.");
  }
  if (all.length > MAX_UNIVERSE && chosen.length === MAX_UNIVERSE) notes.push(`The first ${MAX_UNIVERSE} linked companies by degree and confidence.`);

  let entry: Condition;
  let name: string;
  let basis: string;
  let hasHistory: boolean;
  if (card.event.kind === "earnings_surprise") {
    const beat = isBeat(card);
    entry = { type: "earnings_surprise", ticker: eventTicker, op: beat ? "above" : "below", pct: 0, daysAfter: 1 };
    basis = `${eventTicker} EPS ${beat ? "beats" : "misses"}`;
    name = `After ${eventTicker} EPS ${beat ? "beats" : "misses"}, ${holdDays} days`;
    hasHistory = true;
    notes.push(
      `Every ${eventTicker} release with an EPS ${beat ? "beat" : "miss"} in the window counts, not only this one. Entry at the open after the release, held ${holdDays} trading days.`,
    );
  } else {
    const relation: Relation | null = only(chosen.map((h) => h.relation));
    const direction: Direction | null = up.length ? "up" : null;
    entry = {
      type: "ripple_event",
      relation,
      direction,
      minConfidence: null,
      maxDegree: chosen.some((h) => h.degree === 2) ? 2 : 1,
      daysAfter: 1,
    };
    basis = "ripple cards like this one";
    name = `After ripple cards like ${eventTicker}'s, ${holdDays} days`;
    hasHistory = false;
    notes.push("Past events of this type are read from ripple card history, which is not connected yet, so this run shows no trades.");
  }

  const strategy: Strategy = {
    version: 1,
    name: name.slice(0, 80),
    universe,
    entry: { mode: "all", conditions: [entry] },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: holdDays },
    sizing: { maxPositions: Math.min(10, universe.length), positionPct: null },
    rebalance: "none",
  };
  return { strategy, notes, hasHistory, holdDays, basis };
}
