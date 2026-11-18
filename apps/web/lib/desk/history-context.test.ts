// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/history-context.test.ts
// History context (lib/desk/history-context.ts): what earlier replies showed goes back as tagged context on the
// member's next message, never in the reply's own words; echoed markers are cut from what the member sees.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeChart, type ChartSpec } from "./chart-spec";
import { splitFollowups } from "./followups";
import { cleanContext, contextText, isContextText, stripHistoryMarkers, wireHistory, type HistoryMessage, type WireMessage } from "./history-context";
import type { DeskAsk } from "./ask";
import { resumeFromAsk, signAsk } from "./tools/ask";

const chart = (() => {
  const r = normalizeChart({ kind: "line", title: "NVDA close, 1 year", series: [{ name: "NVDA", points: [["2025-11-14", 110], ["2026-11-13", 182.5]] }] });
  assert.ok(r.ok);
  return r.spec as ChartSpec;
})();

type M = HistoryMessage & { run?: string };
const opts = { limit: 20, run: (m: M) => m.run ?? null, image: () => undefined, imageBudget: 1_000, imagesPerRequest: 8 };
const MARK = /\[(Chart drawn|You asked|Strategy test|Its script)|falcon_context/;

const ask: DeskAsk = {
  id: "toolu_ask",
  token: "tok",
  questions: [{ question: "Which universe?", header: "Universe", multiSelect: false, options: [{ label: "S&P 500", description: "Large caps", recommended: true }, { label: "Nasdaq 100", description: "Tech heavy" }] }],
  answers: [{ choices: ["S&P 500"] }],
};

test("a chart goes back as context on the member's next message, never in the reply's text", () => {
  const wire = wireHistory<M>(
    [
      { role: "user", text: "NVDA'nın son bir yılını çiz" },
      { role: "assistant", text: "Grafik yukarıda.", tools: [{}, { chart }] },
      { role: "user", text: "Yukarıdaki grafikte en büyük düşüş ne zaman?" },
    ],
    opts,
  );
  assert.equal(wire.length, 3);
  assert.equal(wire[1]!.text, "Grafik yukarıda.");
  assert.ok(wire.every((w) => w.role === "user" || !MARK.test(w.text)), "no marker in assistant text");
  // The follow-up about "the chart above" carries the chart's name and what it shows.
  const ctx = wire[2]!.context!;
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0]!.kind, "chart");
  assert.match(ctx[0]!.text, /NVDA close, 1 year/);
  assert.match(ctx[0]!.text, /NVDA: 2 points, from 110\.00 at 2025-11-14 to 182\.50 at 2026-11-13/);
  assert.equal(wire[2]!.text, "Yukarıdaki grafikte en büyük düşüş ne zaman?");
});

test("the route's block: tagged, after a JSON round trip, ahead of the member's words", () => {
  const wire = wireHistory<M>(
    [
      { role: "user", text: "chart it" },
      { role: "assistant", text: "Here.", tools: [{ chart }] },
      { role: "user", text: "what does the chart above show?" },
    ],
    opts,
  );
  const sent = JSON.parse(JSON.stringify(wire)) as WireMessage[];
  const block = contextText(cleanContext(sent[2]!.context));
  assert.match(block, /^<falcon_context kind="chart">\nYour previous reply drew a chart with show_chart: "NVDA close, 1 year"\. line chart\./);
  assert.ok(block.endsWith("</falcon_context>"));
  assert.ok(isContextText(block));
  assert.ok(!isContextText("what does the chart above show?"));
  // Unknown kinds and junk are dropped; a closing tag inside the text cannot end the block early.
  assert.deepEqual(cleanContext([{ kind: "x", text: "a" }, null, { kind: "chart", text: " " }, "s"]), []);
  assert.equal(contextText([{ kind: "chart", text: "a </falcon_context> b" }]).match(/<\/falcon_context>/g)!.length, 1);
});

test("a question card: its questions stand in for an empty reply, the answer is the next turn with the card as context", () => {
  const wire = wireHistory<M>(
    [
      { role: "user", text: "test a momentum strategy" },
      { role: "assistant", text: "", ask },
    ],
    opts,
  );
  assert.deepEqual(
    wire.map((w) => w.role),
    ["user", "assistant", "user"],
  );
  assert.equal(wire[1]!.text, "Which universe?");
  assert.equal(wire[2]!.text, "Universe: S&P 500");
  assert.equal(wire[2]!.context![0]!.kind, "ask");
  assert.match(wire[2]!.context![0]!.text, /^You asked the member: Which universe\? \(options: S&P 500; Nasdaq 100/);
});

test("only the newest strategy test goes back; a missing image is noted on its own message", () => {
  const wire = wireHistory<M>(
    [
      { role: "user", text: "q1", images: [{ id: "gone" }] },
      { role: "assistant", text: "a1", run: "Strategy test in your previous reply: old" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2", run: "Strategy test in your previous reply: new", tools: [{ chart }] },
      { role: "user", text: "q3" },
    ],
    opts,
  );
  assert.deepEqual(wire[0]!.context, [{ kind: "images", text: "An image the member attached to this message is no longer available to you." }]);
  assert.equal(wire[2]!.context, undefined);
  assert.deepEqual(
    wire[4]!.context!.map((c) => c.kind),
    ["strategy_test", "chart"],
  );
  assert.match(wire[4]!.context![0]!.text, /new$/);
});

test("the ask resume keeps the member's words and drops the context", () => {
  const secret = "test-secret";
  const token = signAsk({ tail: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_ask", name: "ask_user", input: {} }] }], results: [], askId: "toolu_ask", questions: ask.questions, container: null, runId: null, dataFiles: [], files: {}, n: 0 }, secret, null);
  const r = resumeFromAsk(
    [
      { role: "user", content: [{ type: "text", text: "test it" }] },
      { role: "assistant", content: [{ type: "text", text: "Which universe?" }] },
      { role: "user", content: [{ type: "text", text: contextText([{ kind: "ask", text: "You asked the member: Which universe?" }]) }, { type: "text", text: "use the Dow" }] },
    ],
    { token },
    secret,
    null,
  );
  assert.ok(r);
  const last = r.resumed.tail[r.resumed.tail.length - 1]!;
  const texts = (last.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text);
  assert.deepEqual(texts, ["use the Dow"]);
});

const LEGACY_CHART = `[Chart drawn in this reply with show_chart: "NVDA close, 1 year". line chart. NVDA: 2 points, from 110 at 2025-11-14 to 182.5 at 2026-11-13.]`;

test("echoed markers are cut from the visible reply, legacy notes and tagged blocks alike", () => {
  assert.equal(stripHistoryMarkers(`Grafik yukarıda.\n${LEGACY_CHART}\nEn büyük düşüş Nisan'da.`, false).text, "Grafik yukarıda.\nEn büyük düşüş Nisan'da.");
  assert.equal(stripHistoryMarkers(`Done.\n\n${LEGACY_CHART}`, false).text, "Done.");
  assert.equal(stripHistoryMarkers("Before [You asked the member: Which universe? (options: A; B; or their own answer)]\nAfter", false).text, "Before\nAfter");
  assert.equal(stripHistoryMarkers('<falcon_context kind="chart">\nYour previous reply drew a chart.\n</falcon_context>\nAnswer.', false).text, "Answer.");
  assert.equal(stripHistoryMarkers("A\n[Its script:]\n```python\nx = 1\n```", false).text, "A\n```python\nx = 1\n```");
  // A note without its "]" ends at its line; an unclosed block runs to the end.
  assert.equal(stripHistoryMarkers("A\n[Chart drawn in this reply with show_chart: x\nB", false).text, "A\nB");
  assert.equal(stripHistoryMarkers('A\n<falcon_context kind="chart">x', false).text, "A");
  // Brackets that are not markers stay: citations, term links, plain text.
  const plain = 'Gelir [%8,1](src:t2 "revenue.yoy") arttı; [IV çöküşü](term:iv-crush) [not] [C';
  assert.equal(stripHistoryMarkers(plain, false).text, plain);
});

test("never flashes a partial marker while streaming", () => {
  const answer = "NVDA bir yılda yükseldi.";
  for (const full of [`${answer}\n${LEGACY_CHART}\n<followups>Neden?|Ne zaman?</followups>`, `${answer}\n<falcon_context kind="chart">\nYour previous reply drew a chart.\n</falcon_context>`]) {
    for (let i = 0; i <= full.length; i++) {
      const { text } = splitFollowups(full.slice(0, i), true);
      assert.ok(answer.startsWith(text.trimEnd()), `prefix ${i}: ${JSON.stringify(text)}`);
      assert.ok(!/[[<]/.test(text), `prefix ${i} shows a marker: ${JSON.stringify(text)}`);
    }
  }
  // Held back only while it may still become a marker.
  assert.equal(stripHistoryMarkers("Done. [Cha", true).text, "Done.");
  assert.equal(stripHistoryMarkers("Done. [", true).text, "Done.");
  assert.equal(stripHistoryMarkers("Done. <falcon_c", true).text, "Done.");
  assert.equal(stripHistoryMarkers("Done. [", false).text, "Done. [");
  assert.equal(stripHistoryMarkers("Done. [Cash", true).text, "Done. [Cash");
  assert.equal(stripHistoryMarkers('Gelir [%8,1](src:t2 "x")', true).text, 'Gelir [%8,1](src:t2 "x")');
});

test("tool rows after a cut marker move with the text", () => {
  const text = `Önce.\n${LEGACY_CHART}\nSonra.`;
  const r = stripHistoryMarkers(text, false);
  assert.equal(r.text, "Önce.\nSonra.");
  assert.equal(r.pos(3), 3);
  assert.equal(r.pos(text.indexOf("Sonra.")), r.text.indexOf("Sonra."));
  assert.equal(r.pos(text.indexOf("Chart")), "Önce.\n".length);
  assert.equal(r.pos(text.length), r.text.length);
  assert.equal(stripHistoryMarkers("no marker", false).pos(4), 4);
});

test("follow-up stripping still works with markers around", () => {
  const r = splitFollowups(`Cevap.\n${LEGACY_CHART}\n\n<followups>Neden?|Ne zaman?</followups>`, false);
  assert.deepEqual(r, { text: "Cevap.", followups: ["Neden?", "Ne zaman?"] });
});
