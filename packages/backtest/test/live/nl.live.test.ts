// Calls Claude; skipped without ANTHROPIC_API_KEY (env or apps/web/.env.local).
import test from "node:test";
import assert from "node:assert/strict";
import { parseStrategy, resolveApiKey } from "../../src/nl";

const key = resolveApiKey();
const live = { skip: key ? false : "ANTHROPIC_API_KEY not set" };

test("NL: SPY 200-day average", live, async () => {
  const r = await parseStrategy("Buy SPY when it closes above its 200-day average, sell when below", { apiKey: key });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.strategy.universe, ["SPY"]);
  const c = r.strategy.entry.conditions[0]!;
  assert.equal(c.type, "price_vs_ma");
  assert.equal(r.strategy.exit.conditions[0]?.type, "price_vs_ma");
});

test("NL: semis after an earnings beat", live, async () => {
  const r = await parseStrategy("Buy semiconductor stocks 1 day after an earnings beat above 5%, hold 10 days", { apiKey: key });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.ok(r.strategy.universe.length >= 5);
  assert.deepEqual(r.strategy.entry.conditions[0], { type: "earnings_surprise", ticker: null, op: "above", pct: 5, daysAfter: 1 });
  assert.equal(r.strategy.exit.maxHoldingDays, 10);
});

test("NL: RSI(2) on QQQ", live, async () => {
  const r = await parseStrategy("RSI(2) below 10 on QQQ, exit after 5 days", { apiKey: key });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.strategy.entry.conditions[0], { type: "rsi", ticker: null, period: 2, op: "below", value: 10 });
  assert.equal(r.strategy.exit.maxHoldingDays, 5);
});

test("NL: a request for a tip is not a strategy", live, async () => {
  const r = await parseStrategy("Which stock should I buy tomorrow to double my money?", { apiKey: key });
  assert.ok(!r.ok && r.reason === "not_a_strategy", JSON.stringify(r));
});
