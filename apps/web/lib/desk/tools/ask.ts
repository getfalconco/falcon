/**
 * `ask_user`: the Desk AI asks the member a clarifying question with a card
 * of 2-4 options (lab/AskCard.tsx). Server-only (signing). Shapes, checks and
 * the text-history forms are shared with the client in lib/desk/ask.ts.
 *
 * The route ends the reply when Claude calls it, without inventing a result:
 * the assistant turn (thinking and tool_use blocks unchanged) and the other
 * results of that round go into a signed token the card carries. The next
 * request sends `ask: { token, answers? }`; `resumeFromAsk` puts the turn back
 * and supplies the one missing tool_result, so every tool_use keeps its
 * tool_result:
 *   answered  -> the picked labels / own words
 *   ignored   -> IGNORED_NOTE, then the member's message in the same user turn
 * A token that no longer verifies (expired, other member) leaves the plain
 * text history, where the question and the answer read as ordinary turns.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { ASK_LIMITS, ASK_TOOL_NAME, answerText, cleanAnswers, parseAskInput, type AskAnswer, type AskQuestion } from "../ask";
import { isContextText } from "../history-context";
import type { ResumeState } from "../strategy-run";
import type { DeskToolOutcome } from "./index";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Message = Anthropic.Beta.BetaMessageParam;

export const IGNORED_NOTE = "The member did not pick an option; their message follows.";

export const ASK_USER_TOOL = {
  name: ASK_TOOL_NAME,
  description:
    "Asks the member a clarifying question as a card with 2 to 4 options to click (the card always adds an \"Other\" choice for their own words). Use it only when you cannot go on without the member's choice and no sensible default exists, e.g. which universe, period or risk settings a strategy test should use. The reply ends when you call it; the member's answer comes back as this tool's result, or, if they type a message instead, a note followed by that message. Call it at most once per reply, with nothing else after it.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: ASK_LIMITS.questions,
        description: "1 to 3 questions, usually one.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", maxLength: ASK_LIMITS.question, description: "The question, short and specific, in the member's language." },
            header: { type: "string", maxLength: ASK_LIMITS.header, description: "A one- or two-word chip shown above it, e.g. \"Universe\", \"Period\", \"Risk\"." },
            options: {
              type: "array",
              minItems: ASK_LIMITS.minOptions,
              maxItems: ASK_LIMITS.maxOptions,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", maxLength: ASK_LIMITS.label, description: "1 to 5 words." },
                  description: { type: "string", maxLength: ASK_LIMITS.description, description: "One short line: what this choice means or implies." },
                  recommended: { type: "boolean", description: "True on at most one option: the one you would pick. It is shown first." },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
            multiSelect: { type: "boolean", description: "True when several options can be chosen together." },
          },
          required: ["question", "header", "options", "multiSelect"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/* ------------------------------------------------------------------ one round's calls */

export type AskPick = { chosen: { id: string; questions: AskQuestion[] } | null; errors: Map<string, string> };

/** The first valid ask_user call of a round; the others (invalid, or a second one) get an error result straight away. */
export function pickAsk(calls: { id: string; name: string; input: unknown }[]): AskPick {
  const out: AskPick = { chosen: null, errors: new Map() };
  for (const c of calls) {
    if (c.name !== ASK_TOOL_NAME) continue;
    const p = parseAskInput(c.input);
    if (!p.ok) out.errors.set(c.id, p.error);
    else if (out.chosen) out.errors.set(c.id, "Only one ask_user call per reply: ask this after the member answers the first card.");
    else out.chosen = { id: c.id, questions: p.questions };
  }
  return out;
}

/** The route's outcome for an ask_user call: an error, or a placeholder the member's answer fills in (resumeFromAsk). */
export function askOutcome(id: string, pick: AskPick): DeskToolOutcome {
  const error = pick.errors.get(id);
  if (error || pick.chosen?.id !== id) return { name: ASK_TOOL_NAME, ok: false, content: JSON.stringify({ error: error ?? "Not shown." }), label: "Question not shown", ms: 0 };
  return { name: ASK_TOOL_NAME, ok: true, content: "", label: "Asked the member", ms: 0 };
}

/** The tool_result text for the member's answers. */
export function askResultText(questions: AskQuestion[], answers: AskAnswer[]): string {
  const lines = questions.map((q, i) => {
    const a = answers[i]!;
    const own = a.other ? `their own answer: "${a.other}"` : "";
    return `- ${q.question} -> ${[a.choices.join(", "), own].filter(Boolean).join("; ") || answerText(a)}`;
  });
  return `The member answered:\n${lines.join("\n")}`;
}

/* ------------------------------------------------------------------ pending state */

/** What the card's token carries: the reply so far (ending with the ask_user turn) and the round's results with the ask's still open. */
export type AskPending = ResumeState & {
  /** The user turn of tool_result (and container_upload) blocks, in call order; the ask's content is filled in later. */
  results: Block[];
  askId: string;
  questions: AskQuestion[];
};

/** A member may come back to an open card later in the same browser session. */
const TOKEN_TTL_MS = 12 * 3_600_000;

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("falcon-desk-ask-v1").digest();
}

export function signAsk(state: AskPending, secret: string, userId: string | null, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...state, u: userId, exp: now + TOKEN_TTL_MS })).toString("base64url");
  return `${body}.${createHmac("sha256", key(secret)).update(body).digest("base64url")}`;
}

export function verifyAsk(token: unknown, secret: string, userId: string | null, now = Date.now()): AskPending | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "base64url");
  const want = createHmac("sha256", key(secret)).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AskPending & { u: string | null; exp: number };
    if (s.u !== userId || typeof s.exp !== "number" || s.exp < now || !Array.isArray(s.tail) || !Array.isArray(s.results) || typeof s.askId !== "string") return null;
    const q = parseAskInput({ questions: s.questions });
    if (!q.ok) return null;
    return {
      tail: s.tail,
      results: s.results,
      askId: s.askId,
      questions: q.questions,
      container: s.container ?? null,
      runId: s.runId ?? null,
      dataFiles: Array.isArray(s.dataFiles) ? s.dataFiles : [],
      files: s.files ?? {},
      n: Number(s.n) || 0,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ pairing */

/** The user turn that closes the ask_user round: every result of the round, the ask's filled in, then the member's message when they typed one. */
export function completeAsk(p: Pick<AskPending, "results" | "askId" | "questions">, reply: { answers: AskAnswer[] } | { message: Block[] }): Message {
  const content = "answers" in reply ? askResultText(p.questions, reply.answers) : IGNORED_NOTE;
  let filled = false;
  const blocks: Block[] = p.results.map((b) => {
    if (b.type !== "tool_result" || b.tool_use_id !== p.askId) return b;
    filled = true;
    return { type: "tool_result", tool_use_id: p.askId, content, is_error: false };
  });
  if (!filled) blocks.unshift({ type: "tool_result", tool_use_id: p.askId, content, is_error: false });
  // tool_result blocks lead the turn; the member's own words follow them.
  const results = blocks.filter((b) => b.type === "tool_result");
  const rest = blocks.filter((b) => b.type !== "tool_result");
  return { role: "user", content: [...results, ...("message" in reply ? reply.message : []), ...rest] };
}

/**
 * The request after a card: `messages` (the client's text history) ends with
 * the asking reply and the member's answer or message. With a token that
 * verifies, those two are replaced by the reply's real turns and the user turn
 * that answers the ask; the route then carries on as from a resume. Null when
 * the token or the history does not fit (the text history is used as it is).
 */
export function resumeFromAsk(messages: Message[], body: unknown, secret: string, userId: string | null, now = Date.now()): { messages: Message[]; resumed: ResumeState } | null {
  const o = (body ?? {}) as { token?: unknown; answers?: unknown };
  const p = verifyAsk(o.token, secret, userId, now);
  if (!p) return null;
  const n = messages.length;
  if (n < 3 || messages[0]!.role !== "user" || messages[n - 2]!.role !== "assistant" || messages[n - 1]!.role !== "user") return null;
  let reply: { answers: AskAnswer[] } | { message: Block[] };
  if (o.answers !== undefined) {
    const answers = cleanAnswers(o.answers, p.questions);
    if (!answers) return null;
    reply = { answers };
  } else {
    const last = messages[n - 1]!.content;
    // The member's own words; the history context about the asking reply is dropped (its real turns come back instead).
    reply = { message: typeof last === "string" ? [{ type: "text", text: last }] : (last as Block[]).filter((b) => !(b.type === "text" && isContextText(b.text))) };
  }
  return {
    messages: messages.slice(0, -2),
    resumed: { tail: [...p.tail, completeAsk(p, reply)], container: p.container, runId: p.runId, dataFiles: p.dataFiles, files: p.files, n: p.n },
  };
}

/**
 * Problems with tool pairing in a conversation, for tests: each client
 * tool_use must be answered by a tool_result in the next (user) message, and
 * each tool_result must answer a tool_use of the message before. Empty when sound.
 */
export function pairingProblems(messages: Message[]): string[] {
  const problems: string[] = [];
  const blocks = (m: Message | undefined): Block[] => (!m || typeof m.content === "string" ? [] : (m.content as Block[]));
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      const uses = blocks(m).flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
      if (!uses.length) return;
      const next = messages[i + 1];
      const answered = next?.role === "user" ? blocks(next).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])) : [];
      for (const id of uses) if (!answered.includes(id)) problems.push(`tool_use ${id} has no tool_result`);
      const nb = blocks(next);
      const firstOther = nb.findIndex((b) => b.type !== "tool_result");
      if (firstOther >= 0 && nb.slice(firstOther).some((b) => b.type === "tool_result")) problems.push(`message ${i + 1}: tool_result after other content`);
    } else if (m.role === "user") {
      const prev = messages[i - 1];
      const uses = prev?.role === "assistant" ? blocks(prev).flatMap((b) => (b.type === "tool_use" ? [b.id] : [])) : [];
      for (const b of blocks(m)) if (b.type === "tool_result" && !uses.includes(b.tool_use_id)) problems.push(`tool_result ${b.tool_use_id} answers no tool_use`);
    }
  });
  return problems;
}
