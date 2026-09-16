import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { decodeEscapes } from "./explanation-cache";
import type { InsightChatRequest } from "../../shared/insight-chat";

/**
 * The Insight panel's conversation. One question, the event's own facts, and
 * whatever has been said so far — answered in the same voice the brief is
 * written in.
 *
 * Nothing here is cached. The brief is one text per event and worth sharing;
 * a conversation is one reader's and worth nothing to the next, so every turn
 * is a live call and the history lives only in the open panel.
 */

const MODEL = "claude-opus-5";
const MAX_TOKENS = 1600;
const TIMEOUT_MS = 60_000;
/** Enough for a real exchange, short enough that the prompt stays cheap. */
const MAX_TURNS = 16;
const MAX_QUESTION_CHARS = 1000;

const SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are answering questions about one market event inside an equity-research
app. The reader is looking at that event's brief and the companies it reaches.

Voice: plain, concrete, no hype, no hedging filler, no disclaimers, no
greetings. Answer the question that was asked and stop. Three or four
sentences is usually right; a single sentence is fine when the question is
small. Never open with "Great question" or restate the question.

You know only what is in this prompt: the event, the brief, the names it
reaches, and how far each of those names has travelled toward the move the
engine called. A positive share means the name is moving the way the call
said, negative means it is moving against it, and past 100% means it has
overshot.

If the answer is not in what you were given, say so in one line and say what
would settle it. Never invent numbers, dates, filings or quotes. Never give
personalised investment advice — describe the mechanism and the evidence, and
leave the decision to the reader.

Return JSON only, with your answer in "reply".`;

function pricedIn(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "nothing to measure it by yet";
  const p = Math.round(value * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}% of the called move`;
}

function buildUser(req: InsightChatRequest): string {
  const lines = [
    "THE EVENT",
    `Headline: ${req.headline}`,
    `It happened at: ${req.root_ticker.toUpperCase()}`,
    req.event_type ? `Type: ${req.event_type}` : null,
    req.event_direction ? `Direction at the root: ${req.event_direction}` : null,
    req.event_materiality ? `Materiality: ${req.event_materiality}` : null,
  ].filter((line): line is string => line !== null);

  if (req.summary) lines.push("", "THE BRIEF THE READER IS LOOKING AT", req.summary);
  for (const point of req.points ?? []) lines.push(`- ${point}`);

  const names = req.names ?? [];
  if (names.length > 0) {
    lines.push("", "THE NAMES IT REACHES");
    for (const n of names) {
      lines.push(
        `- ${n.ticker}${n.label ? ` (${n.label})` : ""}${n.mechanism ? ` — ${n.mechanism}` : ""}` +
          `; ${pricedIn(n.priced_in)}`,
      );
    }
  }

  const turns = req.turns.slice(-MAX_TURNS);
  lines.push("", "THE CONVERSATION SO FAR");
  if (turns.length <= 1) {
    lines.push("(nothing yet — this is the first question)");
  } else {
    for (const turn of turns.slice(0, -1)) {
      lines.push(`${turn.role === "user" ? "Reader" : "You"}: ${turn.text}`);
    }
  }

  const question = turns[turns.length - 1];
  lines.push("", "THE QUESTION TO ANSWER NOW", question?.text ?? "");
  return lines.join("\n");
}

export async function askInsightChat(req: InsightChatRequest): Promise<string> {
  const last = req.turns?.[req.turns.length - 1];
  if (!last || last.role !== "user" || !last.text.trim()) {
    throw new Error("Nothing to answer.");
  }
  if (last.text.length > MAX_QUESTION_CHARS) {
    throw new Error("That question is too long — trim it and ask again.");
  }
  if (!glossConfigured()) throw new Error("ANTHROPIC_API_KEY is not configured");

  const output = await anthropicGlossCaller({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    effort: "low",
    system: SYSTEM,
    user: buildUser(req),
    output_schema: SCHEMA as unknown as Record<string, unknown>,
    timeout_ms: TIMEOUT_MS,
  });

  let parsed: { reply?: unknown };
  try {
    parsed = JSON.parse(output.text) as { reply?: unknown };
  } catch {
    throw new Error("the model returned malformed JSON");
  }
  const reply = typeof parsed.reply === "string" ? decodeEscapes(parsed.reply.trim()) : "";
  if (!reply) throw new Error("the model returned an empty answer");
  return reply;
}
