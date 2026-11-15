import test from "node:test";
import assert from "node:assert/strict";
import { expandListUniverse, findTickerLists, normalizeTicker, withHandles } from "../src/ai/lists";
import { converse, listInput, modelToSpec, untypedTickers } from "../src/ai/converse";
import { isSession, isWeekdayEve, isoToDay, prevSession } from "../src/calendar";
import { rebalanceFlags } from "../src/output";
import { describeSpec, runChecked, validateSpec } from "../src/index";
import { sessions, specData, walkBars } from "./v2-helpers";

const SP = "AAPL, NVDA, MSFT, AMZN, GOOGL, AVGO, META, LLY, TSLA, BRK.B, AMD, JPM, MU, V, XOM, JNJ";

test("normalizeTicker: class shares get a dash, exchange suffixes keep their dot", () => {
  assert.equal(normalizeTicker("BRK.B"), "BRK-B");
  assert.equal(normalizeTicker("brk/b"), "BRK-B");
  assert.equal(normalizeTicker("$bf.b"), "BF-B");
  assert.equal(normalizeTicker("BRK-B"), "BRK-B");
  assert.equal(normalizeTicker("VOD.L"), "VOD.L");
  assert.equal(normalizeTicker("SHOP.TO"), "SHOP.TO");
  assert.equal(normalizeTicker(" aapl "), "AAPL");
});

test("findTickerLists: a long typed list is found, prose next to it is not", () => {
  const text = `Every Tuesday purchase previous 3 month's top 3 gainers. With %10 trailing stop\n${SP}`;
  const lists = findTickerLists(text);
  assert.equal(lists.length, 1);
  assert.equal(lists[0]!.id, "L1");
  assert.equal(lists[0]!.tickers.length, 16);
  assert.equal(lists[0]!.tickers[0], "AAPL");
  assert.ok(lists[0]!.tickers.includes("BRK-B"));
  assert.ok(!lists[0]!.tickers.includes("STOP"));
  const handled = withHandles(text, lists);
  assert.ok(handled.startsWith("Every Tuesday purchase previous 3 month's top 3 gainers. With %10 trailing stop\n[ticker list L1: 16 tickers"));
  assert.ok(!handled.includes("JNJ"));
});

test("findTickerLists: short lists stay inline; space-separated upper case, lower case and 'and' lists count", () => {
  assert.equal(findTickerLists("Buy AAPL, MSFT and NVDA when RSI(2) is below 10").length, 0);
  const spaced = findTickerLists("Rank these: AAPL NVDA MSFT AMZN GOOGL AVGO META LLY TSLA AMD JPM MU by momentum.");
  assert.equal(spaced[0]?.tickers.length, 12);
  assert.equal(spaced[0]?.tickers.at(-1), "MU");
  const lower = findTickerLists("aapl, nvda, msft, amzn, googl, avgo, meta, lly, tsla, amd, jpm and mu");
  assert.equal(lower[0]?.tickers.length, 12);
  assert.equal(lower[0]?.tickers.at(-1), "MU");
  // A dozen ordinary words in a row are not a list.
  assert.equal(findTickerLists("buy it when the price is up and then hold it for a week or so and sell").length, 0);
  // Repeats count once.
  assert.equal(findTickerLists(`${SP}, AAPL, NVDA`)[0]!.tickers.length, 16);
});

test("expandListUniverse: a handle becomes a static universe; unknown handles explain themselves", () => {
  const lists = new Map([["L1", ["AAPL", "NVDA"]]]);
  assert.deepEqual(expandListUniverse({ kind: "list", list: "L1", tickers: ["spy"] }, lists).universe, { kind: "static", tickers: ["AAPL", "NVDA", "SPY"] });
  assert.match(expandListUniverse({ kind: "list", list: "L2" }, lists).error ?? "", /no ticker list L2/);
  const st = { kind: "static", tickers: ["KO"] };
  assert.equal(expandListUniverse(st, lists).universe, st);
});

const rankJson = (universe: unknown) =>
  JSON.stringify({
    name: "Weekly top 3 by 3-month return",
    universe,
    params: { lookback: { type: "int", value: 63, min: 21, max: 252, step: 21 }, n: { type: "int", value: 3, min: 1, max: 10, step: 1 } },
    defs: {},
    portfolio: { mode: "rank", score: "ret(close, $lookback)", order: "desc", select: { n: "$n" }, filter: null, weighting: "equal" },
    rebalance: "weekly",
    rebalance_weekday: 2,
    risk: { stop_pct: null, trailing_pct: 10, take_profit_pct: null, max_hold_days: null },
  });

test("modelToSpec + validateSpec: a 250-ticker list handle, Tuesday rebalance and a trailing stop make a valid spec", () => {
  const tickers = Array.from({ length: 250 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
  const spec = modelToSpec(rankJson({ kind: "list", list: "L1" }), "intent", [], new Map([["L1", tickers]]));
  assert.ok(spec);
  const check = validateSpec(spec);
  assert.ok(check.ok, JSON.stringify(!check.ok && check.issues));
  assert.equal(check.ok && check.spec.universe.kind === "static" && check.spec.universe.tickers.length, 250);
  const rules = describeSpec(check.ok ? check.spec : spec).rules;
  assert.match(rules[0]!, /^1\. Trades any of 250 tickers: .* and 230 more\.$/);
  assert.match(rules[1]!, /^2\. Each week, on the close of the session before Tuesday, ranks/);
  assert.match(rules[2]!, /at Tuesday's open/);
  assert.ok(rules.some((r) => r.endsWith("Trailing stop 10% below the highest close since entry.")));
  // An unknown handle goes back to the model as a fixable problem.
  const problems: string[] = [];
  modelToSpec(rankJson({ kind: "list", list: "L9" }), "intent", [], new Map([["L1", tickers]]), problems);
  assert.match(problems[0] ?? "", /no ticker list L9/);
});

test("validateSpec: a trading weekday needs weekly rebalancing; more than 500 tickers is refused", () => {
  const spec = modelToSpec(rankJson({ kind: "static", tickers: ["AAPL", "MSFT"] }), "i", [])!;
  assert.ok(validateSpec(spec).ok);
  const monthly = { ...spec, rebalance: "monthly" as const };
  const bad = validateSpec(monthly);
  assert.ok(!bad.ok && bad.issues.some((i) => i.path === "rebalance_weekday"));
  const many = Array.from({ length: 501 }, (_, i) => `X${i}`);
  const big = validateSpec({ ...spec, universe: { kind: "static", tickers: many } });
  assert.ok(!big.ok);
});

test("untypedTickers: tickers from a typed list (BRK.B typed, BRK-B in the spec) count as typed", () => {
  const input = { intent: `Top 3 every Tuesday\n${SP}`, answers: [] };
  const listed = listInput(input);
  assert.equal(listed.lists.get("L1")?.length, 16);
  const spec = modelToSpec(rankJson({ kind: "list", list: "L1" }), input.intent, [], listed.lists)!;
  const check = validateSpec(spec);
  assert.ok(check.ok);
  assert.deepEqual(untypedTickers(check.ok ? check.spec : spec, input, listed.lists), []);
});

test("listInput: an edit sends a long current universe as list L0, not as 250 tickers", () => {
  const tickers = Array.from({ length: 30 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}${i >= 26 ? "Z" : ""}`);
  const current = validateSpec(modelToSpec(rankJson({ kind: "static", tickers }), "i", [])!);
  assert.ok(current.ok);
  const listed = listInput({ intent: "i", answers: [], edit: { request: "use a 15% trailing stop", current: current.ok ? current.spec : (null as never) } });
  assert.deepEqual(listed.current?.universe, { kind: "list", list: "L0" });
  assert.equal(listed.lists.get("L0")?.length, 30);
  assert.equal(listed.current?.intent, undefined);
});

test("converse: the model sees a handle, writes a short spec, and the list is filled back in", async () => {
  const sent: string[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: { messages: { content: string }[] }) => {
          sent.push(params.messages[0]!.content);
          const text = JSON.stringify({ outcome: "spec", questions: [], assumptions: [], not_expressible: [], message: "", spec_json: rankJson({ kind: "list", list: "L1" }) });
          return { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } };
        },
      },
    },
  };
  const r = await converse({ intent: `Every Tuesday purchase previous 3 month's top 3 gainers. With %10 trailing stop\n${SP}`, answers: [] }, { client: client as never });
  assert.equal(r.kind, "spec", JSON.stringify(r));
  assert.ok(sent[0]!.includes("[ticker list L1: 16 tickers typed by the person, starting AAPL, NVDA, MSFT, AMZN, GOOGL]"));
  assert.ok(!sent[0]!.includes("JNJ"));
  if (r.kind === "spec") {
    assert.equal(r.spec.universe.kind === "static" && r.spec.universe.tickers.length, 16);
    assert.ok(r.spec.universe.kind === "static" && r.spec.universe.tickers.includes("BRK-B"));
    assert.equal(r.spec.rebalance_weekday, 2);
  }
});

test("converse: more than 500 tickers is refused in plain words before any model call", async () => {
  const many = Array.from({ length: 520 }, (_, i) => `Q${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}`).join(",");
  let called = false;
  const client = { beta: { messages: { create: async () => ((called = true), {}) } } };
  const r = await converse({ intent: `Top 3 weekly\n${many}`, answers: [] }, { client: client as never });
  assert.equal(r.kind, "error");
  assert.ok(r.kind === "error" && r.reason === "too_long" && /520 tickers; Falcon tests up to 500/.test(r.message), JSON.stringify(r));
  assert.equal(called, false);
});

test("isWeekdayEve / rebalanceFlags: Tuesday trades are decided on Monday's close, or Friday's when Monday is a holiday", () => {
  const day = (iso: string) => isoToDay(iso);
  assert.equal(isWeekdayEve(day("2026-11-09"), 2), true); // Monday -> Tuesday 10th
  assert.equal(isWeekdayEve(day("2026-11-10"), 2), false); // Tuesday -> Wednesday
  assert.equal(isWeekdayEve(day("2026-11-06"), 2), false); // Friday -> Monday 9th
  // Monday 2026-01-19 (MLK day) is a holiday: Friday the 16th decides, Tuesday the 20th trades.
  assert.equal(isWeekdayEve(day("2026-01-16"), 2), true);
  // Thanksgiving Thursday 2026-11-26: Thursday trades move to Friday the 27th, decided Wednesday.
  assert.equal(isWeekdayEve(day("2026-11-25"), 4), true);
  // Monday = the first session of each week, the same days as the default weekly rule.
  assert.equal(isWeekdayEve(day("2026-11-06"), 1), true);
  const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"];
  const prep = { panel: { dates }, startIndex: 0 } as never;
  const flags = Array.from(rebalanceFlags(prep, "weekly", 2));
  // First session (initial allocation), then Mondays 2026-11-09 and 2026-11-16.
  assert.deepEqual(dates.filter((_, i) => flags[i]), ["2026-11-02", "2026-11-09", "2026-11-16"]);
  const plain = Array.from(rebalanceFlags(prep, "weekly"));
  assert.deepEqual(dates.filter((_, i) => plain[i]), ["2026-11-02", "2026-11-06", "2026-11-13"]);
});

test("engine: a Tuesday top-3 rank with a 10% trailing stop enters on Tuesdays and stops out in between", () => {
  // NYSE sessions (holidays left out, as in real data): every rebalance entry is a Tuesday open, the first allocation aside.
  const dates = sessions("2022-01-03", 560).filter((d) => isSession(isoToDay(d))).slice(0, 520);
  const names = Array.from({ length: 14 }, (_, i) => `N${String.fromCharCode(65 + i)}`);
  const bars: Record<string, ReturnType<typeof walkBars>> = { SPY: walkBars(dates, 1, { vol: 0.01 }) };
  names.forEach((t, i) => (bars[t] = walkBars(dates, 100 + i, { vol: 0.03 })));
  const spec = modelToSpec(rankJson({ kind: "static", tickers: names }), "i", [])!;
  spec.period = { start: dates[300]!, end: dates[519]! };
  const now = new Date(`${dates[519]}T22:00:00Z`);
  const check = validateSpec(spec, now);
  assert.ok(check.ok);
  const res = runChecked(check as never, { data: specData(bars), now });
  const first = res.trades.reduce((m, t) => (t.entryDate < m ? t.entryDate : m), "9999");
  const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  // A Tuesday, or the next session when Tuesday is a holiday (2023-07-05 after July 4).
  const tradeDay = (iso: string) => weekday(iso) === 2 || isWeekdayEve(prevSession(isoToDay(iso)), 2);
  for (const t of res.trades) assert.ok(tradeDay(t.entryDate) || t.entryDate === first, `${t.ticker} entered ${t.entryDate}`);
  const reasons = new Set(res.trades.map((t) => t.exitReason));
  assert.ok(reasons.has("trailing_stop"), Array.from(reasons).join(","));
  assert.ok(reasons.has("rebalance"));
  for (const t of res.trades.filter((x) => x.exitReason === "rebalance")) assert.ok(tradeDay(t.exitDate), `${t.ticker} rebalanced out ${t.exitDate}`);
});
