// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/ask.test.ts
// Pure checks of the ask_user card and its history pairing; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { askForHistory, askFromStream, askToSend, answersForHistory, cleanAnswers, cleanAsk, parseAskInput } from "./ask";
import { IGNORED_NOTE, askOutcome, pairingProblems, pickAsk, resumeFromAsk, signAsk, type AskPending } from "./tools/ask";

type Message = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

const SECRET = "test-secret";
const USER = "member-1";
const QUESTIONS = [
  {
    question: "Which stocks should the test cover?",
    header: "Universe",
    multiSelect: false,
    options: [
      { label: "Nasdaq 100", description: "Large tech-heavy names" },
      { label: "S&P 500", description: "Today's members", recommended: true },
      { label: "Other", description: "dropped: the card adds its own" },
    ],
  },
];

const thinking: Block = { type: "thinking", thinking: "The member did not say which universe.", signature: "sig" };
const askUse = (id = "toolu_ask"): Block => ({ type: "tool_use", id, name: "ask_user", input: { questions: QUESTIONS } });

function pending(assistant: Block[], results: Block[], askId = "toolu_ask"): AskPending {
  const parsed = parseAskInput({ questions: QUESTIONS });
  assert.ok(parsed.ok);
  return { tail: [{ role: "assistant", content: assistant }], results, askId, questions: parsed.questions, container: null, runId: null, dataFiles: [], files: {}, n: 0 };
}

/** The client's text history after the card: the question, the asking reply, then the answer or the member's message. */
const history = (last: Block[] | string): Message[] => [
  { role: "user", content: [{ type: "text", text: "bir momentum stratejisi test et" }] },
  { role: "assistant", content: [{ type: "text", text: "Which universe?\n\n[You asked the member: ...]" }] },
  { role: "user", content: typeof last === "string" ? [{ type: "text", text: last }] : last },
];

test("parseAskInput: recommended first, Other dropped, limits", () => {
  const p = parseAskInput({ questions: QUESTIONS });
  assert.ok(p.ok);
  assert.deepEqual(
    p.questions[0]!.options.map((o) => o.label),
    ["S&P 500", "Nasdaq 100"],
  );
  assert.equal(p.questions[0]!.options[0]!.recommended, true);
  assert.equal(parseAskInput({ questions: [{ question: "Pick?", header: "X", options: [{ label: "A" }, { label: "a" }], multiSelect: false }] }).ok, false);
  assert.equal(parseAskInput({ questions: [] }).ok, false);
  assert.equal(parseAskInput({ questions: [1, 2, 3, 4].map(() => QUESTIONS[0]) }).ok, false);
});

test("cleanAnswers: known labels only, one pick for single-select, something for each", () => {
  const p = parseAskInput({ questions: QUESTIONS });
  assert.ok(p.ok);
  assert.deepEqual(cleanAnswers([{ choices: ["S&P 500", "made up"] }], p.questions), [{ choices: ["S&P 500"] }]);
  assert.equal(cleanAnswers([{ choices: ["S&P 500", "Nasdaq 100"] }], p.questions), null);
  assert.equal(cleanAnswers([{ choices: [] }], p.questions), null);
  assert.deepEqual(cleanAnswers([{ choices: [], other: "  Russell 2000 " }], p.questions), [{ choices: [], other: "Russell 2000" }]);
  const multi = [{ ...p.questions[0]!, multiSelect: true }];
  assert.deepEqual(cleanAnswers([{ choices: ["Nasdaq 100", "S&P 500"], other: "DAX" }], multi), [{ choices: ["S&P 500", "Nasdaq 100"], other: "DAX" }]);
});

test("answered: the ask's tool_result carries the picked label; history pairs", () => {
  const token = signAsk(pending([thinking, { type: "text", text: "One thing first." }, askUse()], [{ type: "tool_result", tool_use_id: "toolu_ask", content: "" }]), SECRET, USER);
  const r = resumeFromAsk(history("Universe: S&P 500"), { token, answers: [{ choices: ["S&P 500"] }] }, SECRET, USER);
  assert.ok(r);
  assert.equal(r.messages.length, 1);
  const full = [...r.messages, ...r.resumed.tail];
  assert.deepEqual(pairingProblems(full), []);
  assert.equal(full.length, 3);
  const user = full[2]!.content as Block[];
  assert.equal(user.length, 1);
  assert.ok(user[0]!.type === "tool_result" && typeof user[0]!.content === "string" && user[0]!.content.includes("S&P 500"));
  // The thinking block goes back unchanged.
  assert.deepEqual((full[1]!.content as Block[])[0], thinking);
});

test("answered with Other: the member's own words", () => {
  const token = signAsk(pending([askUse()], [{ type: "tool_result", tool_use_id: "toolu_ask", content: "" }]), SECRET, USER);
  const r = resumeFromAsk(history('Universe: "Russell 2000"'), { token, answers: [{ choices: [], other: "Russell 2000" }] }, SECRET, USER);
  assert.ok(r);
  const res = (r.resumed.tail[1]!.content as Block[])[0]!;
  assert.ok(res.type === "tool_result" && String(res.content).includes('their own answer: "Russell 2000"'));
});

test("ignored: a note as the result, then the member's message (images kept) in the same turn", () => {
  const token = signAsk(pending([thinking, askUse()], [{ type: "tool_result", tool_use_id: "toolu_ask", content: "" }]), SECRET, USER);
  const image: Block = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const r = resumeFromAsk(history([image, { type: "text", text: "Actually, just explain momentum." }]), { token }, SECRET, USER);
  assert.ok(r);
  const full = [...r.messages, ...r.resumed.tail];
  assert.deepEqual(pairingProblems(full), []);
  const user = full[full.length - 1]!.content as Block[];
  assert.ok(user[0]!.type === "tool_result" && user[0]!.content === IGNORED_NOTE);
  assert.deepEqual(user[1], image);
  assert.ok(user[2]!.type === "text" && user[2]!.text.includes("explain momentum"));
});

test("parallel tools: the other results stay, in call order, the ask's filled in", () => {
  const calls = [
    { id: "toolu_q", name: "quote", input: { ticker: "SPY" } },
    { id: "toolu_ask", name: "ask_user", input: { questions: QUESTIONS } },
    { id: "toolu_ask2", name: "ask_user", input: { questions: QUESTIONS } },
    { id: "toolu_bad", name: "ask_user", input: { questions: [{ question: "?", header: "x", options: [], multiSelect: false }] } },
    { id: "toolu_lp", name: "load_prices", input: { start: "2020-01-01" } },
  ];
  const pick = pickAsk(calls);
  assert.equal(pick.chosen?.id, "toolu_ask");
  assert.equal(pick.errors.size, 2);
  assert.equal(askOutcome("toolu_ask", pick).ok, true);
  assert.equal(askOutcome("toolu_ask2", pick).ok, false);
  assert.equal(askOutcome("toolu_bad", pick).ok, false);
  // What the route builds for the round: one result per call, in order, then uploads.
  const results: Block[] = [
    ...calls.map((c) => {
      const content = c.name === "ask_user" ? askOutcome(c.id, pick).content : '{"close":600}';
      return { type: "tool_result" as const, tool_use_id: c.id, content, is_error: c.name === "ask_user" && c.id !== "toolu_ask" };
    }),
    { type: "container_upload", file_id: "file_1" },
  ];
  const assistant: Block[] = [thinking, ...calls.map((c) => ({ type: "tool_use" as const, ...c }))];
  const token = signAsk(pending(assistant, results), SECRET, USER);
  const r = resumeFromAsk(history("Universe: Nasdaq 100"), { token, answers: [{ choices: ["Nasdaq 100"] }] }, SECRET, USER);
  assert.ok(r);
  const full = [...r.messages, ...r.resumed.tail];
  assert.deepEqual(pairingProblems(full), []);
  const user = full[full.length - 1]!.content as Block[];
  assert.deepEqual(
    user.map((b) => (b.type === "tool_result" ? b.tool_use_id : b.type)),
    ["toolu_q", "toolu_ask", "toolu_ask2", "toolu_bad", "toolu_lp", "container_upload"],
  );
  const ask = user[1]!;
  assert.ok(ask.type === "tool_result" && String(ask.content).includes("Nasdaq 100") && ask.is_error === false);
});

test("parallel tools, ignored: the member's message follows every tool_result", () => {
  const results: Block[] = [
    { type: "tool_result", tool_use_id: "toolu_q", content: "{}" },
    { type: "tool_result", tool_use_id: "toolu_ask", content: "" },
    { type: "container_upload", file_id: "file_1" },
  ];
  const assistant: Block[] = [{ type: "tool_use", id: "toolu_q", name: "quote", input: { ticker: "SPY" } }, askUse()];
  const token = signAsk(pending(assistant, results), SECRET, USER);
  const r = resumeFromAsk(history("never mind"), { token }, SECRET, USER);
  assert.ok(r);
  const full = [...r.messages, ...r.resumed.tail];
  assert.deepEqual(pairingProblems(full), []);
  assert.deepEqual(
    (full[full.length - 1]!.content as Block[]).map((b) => b.type),
    ["tool_result", "tool_result", "text", "container_upload"],
  );
});

test("a token that does not verify leaves the text history", () => {
  const p = pending([askUse()], [{ type: "tool_result", tool_use_id: "toolu_ask", content: "" }]);
  const token = signAsk(p, SECRET, USER);
  const body = { token, answers: [{ choices: ["S&P 500"] }] };
  assert.equal(resumeFromAsk(history("x"), body, SECRET, "someone-else"), null);
  assert.equal(resumeFromAsk(history("x"), body, "other-secret", USER), null);
  assert.equal(resumeFromAsk(history("x"), { ...body, token: `${token.slice(0, -2)}xx` }, SECRET, USER), null);
  assert.equal(resumeFromAsk(history("x"), body, SECRET, USER, Date.now() + 13 * 3_600_000), null);
  // An answer that does not fit the questions, or a history that does not end with the card's reply.
  assert.equal(resumeFromAsk(history("x"), { token, answers: [{ choices: ["S&P 500", "Nasdaq 100"] }] }, SECRET, USER), null);
  assert.equal(resumeFromAsk(history("x").slice(1), body, SECRET, USER), null);
});

test("pairingProblems catches a missing result", () => {
  const msgs: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [askUse()] },
    { role: "user", content: [{ type: "text", text: "hello?" }] },
  ];
  assert.deepEqual(pairingProblems(msgs), ["tool_use toolu_ask has no tool_result"]);
});

test("text history and the stream line", () => {
  const p = parseAskInput({ questions: QUESTIONS });
  assert.ok(p.ok);
  const ask = { id: "toolu_ask", questions: p.questions, token: "t", answers: [{ choices: [], other: "Russell 2000" }] };
  assert.equal(answersForHistory(ask), 'Universe: "Russell 2000"');
  assert.match(askForHistory(ask), /You asked the member: Which stocks should the test cover\? \(options: S&P 500; Nasdaq 100/);
  assert.match(askForHistory({ ...ask, answers: undefined, skipped: true }), /did not pick an option/);
  const raw = `Some text\n\u001c${JSON.stringify({ t: "ask", id: "toolu_ask", questions: QUESTIONS, token: "tok" })}\n`;
  const found = askFromStream(raw, "\u001c");
  assert.equal(found?.token, "tok");
  assert.equal(found?.questions[0]!.options[0]!.label, "S&P 500");
  assert.equal(cleanAsk({ ...found, answers: [{ choices: ["nope"] }], skipped: true })?.skipped, true);
});

test("askToSend: answers after an answered card, the token alone when the member typed instead", () => {
  const p = parseAskInput({ questions: QUESTIONS });
  assert.ok(p.ok);
  const card = { id: "toolu_ask", questions: p.questions, token: "tok" };
  const user = { role: "user" as const };
  assert.deepEqual(askToSend([user, { role: "assistant", ask: { ...card, answers: [{ choices: ["S&P 500"] }] } }]), { token: "tok", answers: [{ choices: ["S&P 500"] }] });
  assert.deepEqual(askToSend([user, { role: "assistant", ask: { ...card, skipped: true } }, user]), { token: "tok" });
  assert.equal(askToSend([user, { role: "assistant" }, user]), null);
  assert.equal(askToSend([user, { role: "assistant", ask: { ...card, answers: [{ choices: ["S&P 500"] }] } }, { role: "assistant" }, user]), null);
});
