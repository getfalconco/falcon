import test from "node:test";
import assert from "node:assert/strict";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { TurnOutput, converse, untypedTickers, modelToSpec } from "../src/ai/converse";
import { ReviewOutput, review, templateProblems } from "../src/ai/review";
import { CONVERSE_SYSTEM } from "../src/ai/prompts";
import { blankSpec, validateSpec, describeSpec, type QualityReport } from "../src/index";

function strict(schema: unknown) {
  const text = JSON.stringify(schema);
  for (const banned of ['"minimum"', '"maximum"', '"maxLength"', '"oneOf"', '"pattern"']) assert.ok(!text.includes(banned), banned);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.type === "object") assert.equal(o.additionalProperties, false);
    Object.values(o).forEach(walk);
  };
  walk(schema);
}

test("conversation and Explain output schemas are strict-mode compatible", () => {
  strict(betaZodOutputFormat(TurnOutput).schema);
  strict(betaZodOutputFormat(ReviewOutput).schema);
  // The API compiles at most 16 nullable or union-typed parameters per schema.
  const unions = (node: unknown): number => {
    if (!node || typeof node !== "object") return 0;
    const o = node as Record<string, unknown>;
    const self = Array.isArray(o.type) || Array.isArray(o.anyOf) ? 1 : 0;
    return self + Object.values(o).reduce<number>((a, v) => a + unions(v), 0);
  };
  assert.ok(unions(betaZodOutputFormat(TurnOutput).schema) <= 16, `unions: ${unions(betaZodOutputFormat(TurnOutput).schema)}`);
  assert.ok(unions(betaZodOutputFormat(ReviewOutput).schema) <= 16);
  // The cached system prompt has no date or id in it (cache hits every turn) and no em dash.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(CONVERSE_SYSTEM));
  assert.ok(!CONVERSE_SYSTEM.includes("—"));
});

const model = (over: { tickers?: string[]; entry?: string } = {}) =>
  JSON.stringify({
    name: "Semis above their 50-day average",
    universe: { kind: "static", tickers: over.tickers ?? ["NVDA", "AMD"] },
    params: { ma: { type: "int", value: 50, min: 10, max: 200, step: 5 } },
    defs: {},
    portfolio: { mode: "rules", entry: over.entry ?? "close > ts_mean(close, $ma)", exit: "close < ts_mean(close, $ma)", max_positions: 2, clock: "close", reentry: "edge", tiebreak: "seeded", sizing: "equal" },
    rebalance: "monthly",
    risk: { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: null },
    cash: "tbill",
    benchmark: "SPY",
    period: { start: null, end: null },
  });

function fakeClient(replies: object[]) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    client: {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            sent.push(JSON.parse(JSON.stringify(params)));
            const body = replies[Math.min(sent.length - 1, replies.length - 1)];
            return { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(body) }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000 } };
          },
        },
      },
    } as never,
  };
}

const turn = (over: object) => ({ outcome: "spec", questions: [], assumptions: [], not_expressible: [], message: "", spec_json: model(), ...over });

test("converse: never accepts tickers the person did not type; repairs once, then asks", async () => {
  const { client, sent } = fakeClient([turn({}), turn({})]);
  const r = await converse({ intent: "semiconductor stocks above their 50-day average", answers: [] }, { client });
  assert.equal(r.kind, "questions");
  if (r.kind === "questions") assert.equal(r.questions[0]!.id, "tickers");
  assert.equal(sent.length, 2, "one automatic repair");
  const repair = JSON.stringify((sent[1]!.messages as unknown[]).at(-1));
  assert.match(repair, /not typed by the person/);
  // Request shape: Sonnet 5.5, structured output, 1-hour cached system prompt, no temperature.
  const p = sent[0]!;
  assert.equal(p.model, "claude-sonnet-5-5");
  assert.equal((p.system as { cache_control: { ttl: string } }[])[0]!.cache_control.ttl, "1h");
  assert.ok(!("temperature" in p));
  assert.ok((p.output_config as { format?: unknown }).format);
});

test("converse: typed tickers compile; describe() writes the rules; advice is dropped from assumptions", async () => {
  const { client } = fakeClient([turn({ assumptions: ["The average is a simple moving average.", "You should buy NVDA now."] })]);
  const r = await converse({ intent: "NVDA and AMD above their 50-day average", answers: [] }, { client });
  assert.equal(r.kind, "spec");
  if (r.kind !== "spec") return;
  assert.deepEqual(r.assumptions, ["The average is a simple moving average."]);
  assert.match(r.describe.rules[1]!, /Enters at the next open/);
  assert.equal(r.spec.intent, "NVDA and AMD above their 50-day average");
});

test("converse: a failing formula gets one repair with the checker's message", async () => {
  const bad = turn({ spec_json: model({ entry: "close > 50" }) });
  const { client, sent } = fakeClient([bad, turn({})]);
  const r = await converse({ intent: "NVDA and AMD above their 50-day average", answers: [] }, { client });
  assert.equal(r.kind, "spec");
  assert.ok(r.kind === "spec" && r.repaired);
  assert.match(JSON.stringify((sent[1]!.messages as unknown[]).at(-1)), /raw_close/);
});

test("converse: advice requests come back as not_a_strategy", async () => {
  const { client } = fakeClient([{ outcome: "not_a_strategy", questions: [], assumptions: [], not_expressible: [], message: "I recommend NVDA. Falcon tests rules you write.", spec_json: "" }]);
  const r = await converse({ intent: "what stock should I buy tomorrow?", answers: [] }, { client });
  assert.equal(r.kind, "not_a_strategy");
  if (r.kind === "not_a_strategy") assert.equal(r.message, "Falcon tests rules you write.");
});

test("untypedTickers: SPY and an edited spec's tickers are allowed; BRK.B matches BRK-B", () => {
  const s = modelToSpec(model({ tickers: ["BRK-B"], entry: 'close > ts_mean(close, $ma) and at("SPY", close > ts_mean(close, 200))' }), "x", [])!;
  assert.deepEqual(untypedTickers(s, { intent: "brk.b above its average", answers: [] }), []);
  assert.deepEqual(untypedTickers(s, { intent: "berkshire above its average", answers: [] }), ["BRK-B"]);
});

test("Explain: digits in templates and unknown refs are rejected and retried once; slots are filled by the server", async () => {
  const spec = blankSpec();
  const c = validateSpec(spec);
  assert.ok(c.ok);
  if (!c.ok) return;
  const report: QualityReport = {
    tiers: ["A"],
    label: { level: "thin", title: "Thin", heading: "Evidence in past data", subtitle: "", reasons: [] },
    checks: [{ id: 10, name: "Delay", tier: "A", level: "W", status: "warn", detail: "x" }],
    flags: [],
    values: { delay: { drop_pct: 62.5 }, sample: { trades: 41 } },
  };
  const bad = { headline: { template: "Waiting 1 session removed {} of the result.", slots: [{ ref: "delay.drop_pct" }] }, flags: [], interpretation_risks: [], next_experiments: [] };
  assert.ok(templateProblems(bad as never, report).some((p) => /digit/.test(p)));
  const good = {
    headline: { template: "Waiting one extra session removed {}% of the result over {} trades.", slots: [{ ref: "delay.drop_pct" }, { ref: "sample.trades" }] },
    flags: [{ check_id: 10, severity: "high", meaning: { template: "The record depends on entering at the first open; you should buy now.", slots: [] }, try_next: null }],
    interpretation_risks: [],
    next_experiments: [],
  };
  const { client, sent } = fakeClient([bad, good]);
  const r = await review({ spec: c.spec, describe: describeSpec(c.spec, c.uses), report }, { client });
  assert.equal(sent.length, 2);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.review.headline, "Waiting one extra session removed 62.5% of the result over 41 trades.");
  assert.equal(r.review.flags[0]!.meaning, "", "advice-like sentences are dropped by neutralize()");
});
