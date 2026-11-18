import type Anthropic from "@anthropic-ai/sdk";

/**
 * How a Falcon AI reply carries on past one request (app/api/desk/chat). A
 * request ends within its deadline (Netlify's 60 s function limit); a reply
 * still going then hands the client a signed resume token and the client posts
 * again with it. A round cut in the middle keeps what can go back to the API:
 *
 *  - finished blocks up to the first client tool_use (it would need a result)
 *    and never a server_tool_use still waiting for its result (a 400);
 *  - the text being written when it was cut, up to its last whole word, so the
 *    member's text stays and the next request carries on after it. The client
 *    drops the cut word (`rewind`) and the next request writes it again.
 *
 * A turn kept up to a code execution result is followed by a system message
 * (the API continues a server-tool turn after one); a turn ending in text by a
 * short user note, since a system message may not follow assistant text.
 * Nothing worth keeping: the round runs again from the start in the next request.
 */

export const RESUME_NOTE = "The reply was renewed at the server's time limit. Continue the task from the last finished step; do not repeat finished steps or mention the break.";
export const CONTINUE_NOTE =
  "(Falcon: your reply above was cut off by the server's time limit. Continue it exactly where it stops, in the same language and format, without repeating anything already written and without mentioning the break.)";

const SERVER_RESULTS = new Set(["bash_code_execution_tool_result", "text_editor_code_execution_tool_result", "code_execution_tool_result"]);
export const isServerResult = (type: string) => SERVER_RESULTS.has(type);

export type Cut = {
  /** The assistant blocks to send back (empty: run the round again). */
  kept: Anthropic.Beta.BetaContentBlockParam[];
  /** What follows them in the tail: a system note after a server result, a user note after text. */
  follow: "system" | "user" | null;
  /** Characters of streamed text the client drops (the word that was cut). */
  rewind: number;
  /** What goes between the kept text and the next text: the whitespace that followed the last kept word, or "\n\n" after a finished block. */
  joint: string;
};

const NONE: Cut = { kept: [], follow: null, rewind: 0, joint: "\n\n" };

/**
 * The part of a cut round that can go back to the API. `content` is the
 * stream's snapshot (`stream.currentMessage.content`), `finished` the number
 * of blocks whose content_block_stop arrived; the block at `finished`, if any,
 * was being written when the round was cut.
 */
export function cutTurn(content: readonly Anthropic.Beta.BetaContentBlock[] | undefined, finished: number): Cut {
  if (!content?.length) return NONE;
  // After a fallback hop only the fallback model's part counts (the route keeps the same cut for whole turns).
  const hop = content.slice(0, Math.max(finished, 0)).map((b) => b.type).lastIndexOf("fallback");
  const from = hop >= 0 ? hop : 0;
  const done = content.slice(from, Math.max(finished, from));
  // The longest prefix that ends with no server tool waiting for its result and holds no client tool_use.
  let open = 0;
  let end = 0;
  let stopped = false;
  for (let i = 0; i < done.length; i++) {
    const t = done[i]!.type;
    if (t === "tool_use") {
      stopped = true;
      break;
    }
    if (t === "server_tool_use") open++;
    else if (isServerResult(t)) open = Math.max(0, open - 1);
    if (open === 0) end = i + 1;
  }
  if (open > 0) stopped = true;
  const blocks = done.slice(0, end) as Anthropic.Beta.BetaContentBlockParam[];

  let rewind = 0;
  let joint = "\n\n";
  const cutBlock = content[finished];
  if (!stopped && end === done.length && cutBlock?.type === "text" && cutBlock.text) {
    // The text being written: kept up to its last whole word; the client drops the rest.
    const text = cutBlock.text;
    const m = /\s+(?=\S*$)/.exec(text);
    const keep = m ? text.slice(0, m.index) : "";
    if (keep.trim()) {
      blocks.push({ type: "text", text: keep });
      rewind = text.length - keep.length;
      joint = m![0];
    } else rewind = text.length;
  } else if (cutBlock?.type === "text" && cutBlock.text) rewind = cutBlock.text.length;
  // A turn ending in thinking says nothing; keep up to the last text or server result (a thinking block before kept text stays).
  while (blocks.length && (blocks[blocks.length - 1]!.type === "thinking" || blocks[blocks.length - 1]!.type === "redacted_thinking")) blocks.pop();

  const last = blocks[blocks.length - 1];
  const hasText = blocks.some((b) => b.type === "text" && b.text.trim());
  if (last && isServerResult(last.type)) return { kept: blocks, follow: "system", rewind, joint: "\n\n" };
  if (last?.type === "text" && hasText) return { kept: blocks, follow: "user", rewind, joint };
  return { ...NONE, rewind };
}

/** The tail messages for a cut: the kept turn and its note (none: the round runs again). */
export function cutMessages(cut: Cut): Anthropic.Beta.BetaMessageParam[] {
  if (!cut.kept.length || !cut.follow) return [];
  return [{ role: "assistant", content: cut.kept }, cut.follow === "system" ? { role: "system", content: RESUME_NOTE } : { role: "user", content: CONTINUE_NOTE }];
}

/**
 * Whether a reply stopped by the deadline (or by a dropped upstream
 * connection) carries on in a new request rather than failing: the member is
 * still there and the reply has resumes left. `n` is how many times this reply
 * has been resumed already.
 */
export function canResume(o: { clientGone: boolean; n: number; max: number }): boolean {
  return !o.clientGone && o.n + 1 < o.max;
}

/**
 * The text that starts a resumed request: `joint` (what separated the kept
 * text from the cut word, or a paragraph break) unless the new text already
 * starts with whitespace or closing punctuation.
 */
export function joinResumed(joint: string, next: string): string {
  if (!joint) return next;
  // A line or paragraph break stays one, even when the new text starts with a space instead.
  if (joint.includes("\n")) return next.startsWith("\n") ? next : joint + next.replace(/^[ \t]+/, "");
  if (/^[\s.,;:!?)\]}%»”’]/.test(next)) return next;
  return joint + next;
}

/** The reply's text after a `continue` line's `rewind` (characters of a cut word the next request writes again). */
export function rewound(text: string, rewind: unknown): string {
  const n = typeof rewind === "number" && Number.isFinite(rewind) && rewind > 0 ? Math.floor(rewind) : 0;
  return n ? text.slice(0, Math.max(0, text.length - n)) : text;
}

/** Whether the client posts a broken hop again by itself: once, and only with a resume token (so nothing is asked twice). */
export function reattemptHop(o: { aborted: boolean; token: string | null; attempts: number }): boolean {
  return !o.aborted && !!o.token && o.attempts < 1;
}

/**
 * Whether a round's tool calls would run starved in the time left (`availableMs`: what is left before the answer
 * reserve): a slow tool (an on-demand options pull, /flow: about 20-25 s) needs `slowMs`, any other `minMs`. A
 * starved round hands off so the next request runs the calls with a full budget.
 */
export function toolsStarved(names: readonly string[], availableMs: number, o: { slow: readonly string[]; slowMs: number; minMs: number }): boolean {
  return names.some((n) => availableMs < (o.slow.includes(n) ? o.slowMs : o.minMs));
}
