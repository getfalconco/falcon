import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPTIONS_CAVEAT,
  cardOptions,
  historyAbsMovePct,
  optionsChip,
  optionsSentence,
  withoutOptions,
  type RippleCard,
  type RippleHistory,
  type RippleOptions,
} from "../src/index.ts";

const O: RippleOptions = {
  asOf: "2026-11-13T20:45:00.000Z",
  source: "OPRA via Databento",
  spot: 151.38,
  atmIv: 63.1,
  impliedMove5: { sessions: 5, expiration: "2026-11-20", rawPct: 4.12, marketAdjustedPct: 2.61 },
  impliedMove20: { sessions: 20, expiration: "2026-12-18", rawPct: 9.9, marketAdjustedPct: 6.2 },
  skew: 3.4,
  cpSpread: -3.8,
};

const history = (windowDays: number, abn: number[]): RippleHistory => ({
  sample: abn.length,
  avgMovePct: 0,
  hitRate: 0.5,
  windowDays,
  events: abn.map((a, i) => ({ accession: String(i), eventDate: "2024-01-01", reactionDate: "2024-01-02", movePct: a + 2, benchmarkPct: 2 })),
});

describe("options helpers", () => {
  it("history in matched units: mean |move - benchmark| over >= 6 events", () => {
    assert.equal(historyAbsMovePct(history(5, [3, -3, 4, -2, 1, -5])), 3);
    assert.equal(historyAbsMovePct(history(5, [3, -3, 4])), null);
    assert.equal(historyAbsMovePct(null), null);
    assert.equal(historyAbsMovePct({ ...history(5, [1, 1, 1, 1, 1, 1]), events: undefined }), null);
  });

  it("sentence: the options move alone, or next to history in matched units", () => {
    assert.equal(optionsSentence(O), "Options price a move of about ±4.1% over the next week (±2.6% beyond the market).");
    assert.equal(
      optionsSentence({ ...O, matched: { windowDays: 5, rawPct: 4.12, impliedPct: 2.61, historyPct: 3.2, sample: 22 } }),
      "Options price a move of about ±4.1% over the next week (±2.6% beyond the market). After similar events this stock moved about ±3.2% beyond the market over a week.",
    );
    assert.match(optionsSentence({ ...O, matched: { windowDays: 20, rawPct: 9.9, impliedPct: 6.2, historyPct: 7.3, sample: 50 } })!, /over the next month .* over a month\.$/);
    assert.equal(optionsSentence({ ...O, impliedMove5: { ...O.impliedMove5!, marketAdjustedPct: null } }), "Options price a move of about ±4.1% over the next week.");
    assert.equal(optionsSentence({ ...O, impliedMove5: null }), "Options price a move of about ±9.9% over the next month (±6.2% beyond the market).");
    assert.equal(optionsSentence({ ...O, impliedMove5: null, impliedMove20: null }), null);
    assert.equal(optionsSentence(undefined), null);
  });

  it("wording stays descriptive", () => {
    const text = `${optionsSentence({ ...O, matched: { windowDays: 5, rawPct: 4, impliedPct: 2, historyPct: 3, sample: 6 } })} ${OPTIONS_CAVEAT}`.toLowerCase();
    for (const w of ["should", "undervalued", "overvalued", "recommend", "opportunity", "edge", "buy", "sell"]) assert.ok(!text.includes(w), w);
    assert.match(OPTIONS_CAVEAT, /For information only/);
  });

  it("chip and card block", () => {
    assert.equal(optionsChip(O), "±4.1% priced");
    assert.equal(optionsChip(null), null);
    const card = { options: undefined, hits: [{ options: undefined }, { options: O }] } as unknown as RippleCard;
    assert.equal(cardOptions(card), O);
  });

  it("withoutOptions strips the card's and every hit's block, leaves the rest, and does not mutate", () => {
    const card = {
      id: "c",
      options: O,
      hits: [
        { ticker: "A", options: O, history: null },
        { ticker: "B", history: null },
      ],
    } as unknown as RippleCard;
    const out = withoutOptions(card);
    assert.equal("options" in out, false);
    assert.equal(out.hits.some((h) => "options" in h), false);
    assert.equal(out.hits[0]!.ticker, "A");
    assert.equal(card.options, O, "input untouched");
    assert.equal(card.hits[0]!.options, O, "input hits untouched");
    const plain = { id: "p", hits: [{ ticker: "A" }] } as unknown as RippleCard;
    assert.equal(withoutOptions(plain), plain);
  });
});
