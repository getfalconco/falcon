import { test } from "node:test";
import assert from "node:assert/strict";
import type { RippleCard, RippleHit } from "@falcon/ripple";
import { strategyFromSighting, validateStrategy, windowDays } from "../src/index";

function hit(h: Partial<RippleHit> & Pick<RippleHit, "ticker">): RippleHit {
  return {
    companyName: h.ticker,
    relation: "supplier",
    degree: 1,
    direction: "up",
    confidence: "high",
    window: "1 to 5 trading days",
    mechanism: "",
    evidence: [],
    history: null,
    ...h,
  };
}

function card(kind: RippleCard["event"]["kind"], headline: string, hits: RippleHit[]): RippleCard {
  return {
    id: "c1",
    sector: "Semiconductors",
    generatedAt: "2026-11-01T00:00:00Z",
    hits,
    event: {
      id: "e1",
      ticker: "NVDA",
      companyName: "NVIDIA",
      kind,
      headline,
      occurredAt: "2026-11-01T00:00:00Z",
      summary: "",
      source: { title: "", url: "", publisher: "" },
    },
  };
}

test("windowDays reads the upper end of a window", () => {
  assert.equal(windowDays("1 to 5 trading days"), 5);
  assert.equal(windowDays("5 to 20 trading days"), 20);
  assert.equal(windowDays("1 to 4 weeks"), 20);
  assert.equal(windowDays("1 to 2 months"), 42);
  assert.equal(windowDays("soon"), null);
});

test("earnings card: linked companies after the event company's beats, valid rules", () => {
  const r = strategyFromSighting(
    card("earnings_surprise", "NVIDIA revenue came in 6% above the estimate", [
      hit({ ticker: "TSM" }),
      hit({ ticker: "MU", confidence: "medium", window: "5 to 20 trading days" }),
      hit({ ticker: "INTC", relation: "competitor", direction: "down" }),
    ]),
  );
  assert.deepEqual(r.strategy.universe, ["TSM", "MU"]);
  assert.deepEqual(r.strategy.entry.conditions[0], { type: "earnings_surprise", ticker: "NVDA", op: "above", pct: 0, daysAfter: 1 });
  assert.equal(r.strategy.exit.maxHoldingDays, 20);
  assert.equal(r.hasHistory, true);
  assert.ok(validateStrategy(r.strategy).ok);
  for (const n of r.notes) assert.ok(!/[—–]/.test(n));
});

test("earnings miss and non-earnings cards", () => {
  const miss = strategyFromSighting(card("earnings_surprise", "Revenue was below the estimate", [hit({ ticker: "TSM", direction: "down" })]));
  assert.equal((miss.strategy.entry.conditions[0] as { op: string }).op, "below");
  assert.deepEqual(miss.strategy.universe, ["TSM"]);
  const news = strategyFromSighting(card("news", "Capex plan raised", [hit({ ticker: "AMD", relation: "peer" })]));
  assert.equal(news.strategy.entry.conditions[0]!.type, "ripple_event");
  assert.equal(news.hasHistory, false);
  assert.ok(validateStrategy(news.strategy).ok);
  const empty = strategyFromSighting(card("earnings_surprise", "beat", []));
  assert.deepEqual(empty.strategy.universe, ["NVDA"]);
});
