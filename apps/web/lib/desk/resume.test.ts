// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/resume.test.ts
// How a Falcon AI reply cut by the request deadline (or a failure) carries on in a new request.
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { CONTINUE_NOTE, RESUME_NOTE, canResume, cutMessages, cutTurn, joinResumed, reattemptHop, rewound, toolsStarved } from "./resume";
import { streamFailure } from "./errors";

type Block = Anthropic.Beta.BetaContentBlock;
const thinking = (s = "sig"): Block => ({ type: "thinking", thinking: "", signature: s }) as Block;
const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id = "t1"): Block => ({ type: "tool_use", id, name: "quote", input: { ticker: "AAPL" } }) as Block;
const serverUse = (id = "s1"): Block => ({ type: "server_tool_use", id, name: "bash_code_execution", input: { command: "python x.py" } }) as Block;
const serverResult = (id = "s1"): Block => ({ type: "bash_code_execution_tool_result", tool_use_id: id, content: { type: "bash_code_execution_result", stdout: "ok", stderr: "", return_code: 0, content: [] } }) as Block;

test("cut mid-text: keeps the finished blocks and the text up to its last whole word; the client drops the cut word", () => {
  const cut = cutTurn([thinking(), text("Implied volatility is the market's expected size of mo")], 1);
  assert.equal(cut.follow, "user");
  assert.deepEqual(cut.kept.map((b) => b.type), ["thinking", "text"]);
  assert.equal((cut.kept[1] as { text: string }).text, "Implied volatility is the market's expected size of");
  assert.equal(cut.rewind, " mo".length);
  assert.equal(cut.joint, " ");
  const msgs = cutMessages(cut);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, "assistant");
  assert.deepEqual(msgs[1], { role: "user", content: CONTINUE_NOTE });
});

test("cut mid-text after a paragraph break: the break is the joint", () => {
  const cut = cutTurn([text("First paragraph.\n\nSecond")], 0);
  assert.equal((cut.kept[0] as { text: string }).text, "First paragraph.");
  assert.equal(cut.joint, "\n\n");
  assert.equal(cut.rewind, "\n\nSecond".length);
});

test("cut in the first word: nothing kept, the round runs again and the client drops what it showed", () => {
  const cut = cutTurn([thinking(), text("Implie")], 1);
  assert.deepEqual(cutMessages(cut), []);
  assert.equal(cut.rewind, 6);
});

test("cut while thinking or before anything: the round runs again", () => {
  assert.deepEqual(cutMessages(cutTurn([thinking()], 0)), []);
  assert.deepEqual(cutMessages(cutTurn([], 0)), []);
  assert.deepEqual(cutMessages(cutTurn(undefined, 0)), []);
  // A finished thinking block alone says nothing.
  assert.deepEqual(cutMessages(cutTurn([thinking(), thinking("b")], 2)), []);
});

test("cut while writing a client tool call: the text before it is kept, the call is made again", () => {
  const cut = cutTurn([thinking(), text("Looking up the data. "), toolUse()], 2);
  assert.equal(cut.follow, "user");
  assert.deepEqual(cut.kept.map((b) => b.type), ["thinking", "text"]);
  assert.equal(cut.rewind, 0);
});

test("a finished client tool_use is never kept (it would need a result), nor anything after it", () => {
  const cut = cutTurn([text("Checking. "), toolUse("a"), toolUse("b"), text("late")], 3);
  assert.deepEqual(cut.kept.map((b) => b.type), ["text"]);
  // The text after the call was shown; the client drops it.
  assert.equal(cut.rewind, 4);
});

test("cut while the code execution tool runs: kept up to the last server result, then a system note", () => {
  const blocks = [text("Running the test. "), serverUse("s1"), serverResult("s1"), serverUse("s2")];
  const cut = cutTurn(blocks, 4);
  assert.deepEqual(cut.kept.map((b) => b.type), ["text", "server_tool_use", "bash_code_execution_tool_result"]);
  assert.equal(cut.follow, "system");
  assert.deepEqual(cutMessages(cut)[1], { role: "system", content: RESUME_NOTE });
});

test("a server_tool_use still waiting for its result is never kept (a 400)", () => {
  const cut = cutTurn([text("Writing the script. "), serverUse("s1")], 2);
  assert.deepEqual(cut.kept.map((b) => b.type), ["text"]);
  assert.equal(cut.follow, "user");
});

test("after a fallback hop only the fallback model's part is kept", () => {
  const fb = { type: "fallback", from: { model: "a" }, to: { model: "b" } } as unknown as Block;
  const cut = cutTurn([text("declined part "), fb, text("The answer is")], 2);
  assert.equal(cut.kept[0]!.type, "fallback");
  assert.equal((cut.kept[1] as { text: string }).text, "The answer");
});

test("canResume: only while the member is there and resumes remain", () => {
  assert.equal(canResume({ clientGone: false, n: 0, max: 8 }), true);
  assert.equal(canResume({ clientGone: false, n: 6, max: 8 }), true);
  assert.equal(canResume({ clientGone: false, n: 7, max: 8 }), false);
  assert.equal(canResume({ clientGone: true, n: 0, max: 8 }), false);
});

test("joinResumed: the joint goes in unless the new text starts with a space or punctuation", () => {
  assert.equal(joinResumed(" ", "mo"), " mo");
  assert.equal(joinResumed("\n\n", "Next"), "\n\nNext");
  assert.equal(joinResumed(" ", " mo"), " mo");
  assert.equal(joinResumed(" ", ", then"), ", then");
  assert.equal(joinResumed("", "x"), "x");
  // A line break stays a line break when the model starts again with a space.
  assert.equal(joinResumed("\n", " - **Next**"), "\n- **Next**");
  assert.equal(joinResumed("\n\n", "\n\nNext"), "\n\nNext");
});

test("rewound: drops the cut word from the client's text", () => {
  assert.equal(rewound("size of mo", 3), "size of");
  assert.equal(rewound("abc", 10), "");
  assert.equal(rewound("abc", undefined), "abc");
  assert.equal(rewound("abc", -1), "abc");
  assert.equal(rewound("abc", "2"), "abc");
});

test("reattemptHop: a broken hop is posted again once, only with a token and not after Stop", () => {
  assert.equal(reattemptHop({ aborted: false, token: "t", attempts: 0 }), true);
  assert.equal(reattemptHop({ aborted: false, token: "t", attempts: 1 }), false);
  assert.equal(reattemptHop({ aborted: false, token: null, attempts: 0 }), false);
  assert.equal(reattemptHop({ aborted: true, token: "t", attempts: 0 }), false);
});

test("streamFailure: with a token the message says Retry continues", () => {
  assert.match(streamFailure("timeout", true, true), /Retry to continue/);
  assert.match(streamFailure("overloaded", false, true), /heavy load.*Retry to continue/);
  assert.equal(streamFailure("timeout", false), "Falcon AI took longer than usual. Try again.");
});

test("toolsStarved: an options pull or /flow needs about 20 s, a lookup 3 s", () => {
  const o = { slow: ["falcon_options", "flow"], slowMs: 20_000, minMs: 3_000 };
  // Two /options calls after a first round (about 32 s left of 50, 15 s kept for the answer): run now.
  assert.equal(toolsStarved(["falcon_options", "falcon_options"], 32_000 - 15_000 + 5_000, o), false);
  // The second, sequential /options call at about 27 s: 23 - 15 = 8 s would starve it; resume first.
  assert.equal(toolsStarved(["falcon_options"], 8_000, o), true);
  assert.equal(toolsStarved(["quote", "history"], 8_000, o), false);
  assert.equal(toolsStarved(["quote"], 2_000, o), true);
  assert.equal(toolsStarved([], 0, o), false);
});
