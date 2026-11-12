import test from "node:test";
import assert from "node:assert/strict";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { PARSE_MODEL, ParseOutputSchema, interpretOutput, parseStrategy } from "../src/nl";
import { strategy } from "./helpers";

const spy200 = strategy({
  name: "SPY above 200-day average",
  universe: ["SPY"],
  entry: { mode: "all", conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "above" }] },
  exit: { conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "below" }], stopLossPct: null, takeProfitPct: null, maxHoldingDays: null },
});

const output = (over: object = {}) => ({
  outcome: "strategy",
  strategy: spy200,
  range: { start: null, end: null },
  assumptions: ["The 200-day average is a simple moving average.", "You should buy SPY now, it will make money."],
  unsupported: [],
  message: null,
  ...over,
});

test("the output schema sent to the API is strict-mode compatible", () => {
  const schema = betaZodOutputFormat(ParseOutputSchema).schema as Record<string, unknown>;
  const text = JSON.stringify(schema);
  for (const banned of ['"minimum"', '"maximum"', '"maxLength"', '"oneOf"', '"pattern"']) assert.ok(!text.includes(banned), banned);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.type === "object") assert.equal(o.additionalProperties, false);
    Object.values(o).forEach(walk);
  };
  walk(schema);
});

test("interpretOutput: validated rules, a summary written from them, advice dropped", () => {
  const r = interpretOutput(output());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.strategy.universe[0], "SPY");
  assert.equal(r.summary[1], "Buys at the next open when, on the close, SPY closes above its 200-day simple moving average.");
  assert.deepEqual(r.assumptions, ["The 200-day average is a simple moving average."]);
});

test("interpretOutput: not a strategy, invalid rules, bad shape", () => {
  const no = interpretOutput(output({ outcome: "not_a_strategy", strategy: null, message: "I recommend NVDA. Falcon tests rules you describe." }));
  assert.ok(!no.ok && no.reason === "not_a_strategy");
  assert.equal(!no.ok && no.message, "Falcon tests rules you describe.");

  const invalid = interpretOutput(output({ strategy: { ...spy200, universe: ["NOT A TICKER"] } }));
  assert.ok(!invalid.ok && invalid.reason === "invalid" && (invalid.errors?.length ?? 0) > 0);

  assert.ok(!interpretOutput({ foo: 1 }).ok);
});

test("parseStrategy: request shape (model, thinking off, structured output, no temperature)", async () => {
  let sent: Record<string, unknown> | null = null;
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          sent = params;
          return { model: PARSE_MODEL, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(output()) }] };
        },
      },
    },
  };
  const r = await parseStrategy("Buy SPY when it closes above its 200-day average, sell when below", {
    client: client as never,
    now: new Date("2026-11-12T00:00:00Z"),
  });
  assert.ok(r.ok);
  const p = sent as unknown as Record<string, any>;
  assert.equal(p.model, "claude-sonnet-5-5");
  assert.equal(p.temperature, undefined);
  assert.deepEqual(p.thinking, { type: "between_tools" });
  assert.equal(p.output_config.format.type, "json_schema");
  assert.equal(p.fallbacks, "default");
  assert.ok(String(p.messages[0].content).includes("2026-11-12"));
  assert.ok(String(p.messages[0].content).includes("<strategy_description>"));
});

test("parseStrategy: empty, too long, refusal and broken JSON", async () => {
  const reply = (msg: object) => ({ beta: { messages: { create: async () => msg } } }) as never;
  assert.equal(((await parseStrategy("  ")) as { reason: string }).reason, "empty");
  assert.equal(((await parseStrategy("x".repeat(2001))) as { reason: string }).reason, "too_long");
  const refusal = await parseStrategy("text", { client: reply({ stop_reason: "refusal", content: [] }) });
  assert.ok(!refusal.ok && refusal.reason === "refusal");
  const broken = await parseStrategy("text", { client: reply({ stop_reason: "end_turn", content: [{ type: "text", text: "{" }] }) });
  assert.ok(!broken.ok && broken.reason === "invalid");
});
