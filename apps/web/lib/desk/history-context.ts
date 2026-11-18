/**
 * What earlier Falcon AI replies showed besides their words (charts drawn with
 * show_chart, question cards, strategy tests) and how it goes back to the model.
 *
 * It used to be appended to the assistant's own text as a bracketed line
 * ("[Chart drawn in this reply with show_chart: …]"), and the model then copied
 * that pattern into its visible replies. Now it travels as data the model never
 * wrote: the client attaches it to the member message that follows the reply
 * (`context` on that wire message, lab/sessions.ts), and the route puts it in
 * front of that turn as one tagged block, <falcon_context kind="chart">…</falcon_context>
 * (app/api/desk/chat/route.ts; lib/desk/system.ts says it is reference only).
 *
 * stripHistoryMarkers removes any echo of either form from a reply the member
 * sees, while it streams (a half-written marker never flashes) and when it is
 * saved; splitFollowups (lib/desk/followups.ts) calls it. Pure and client-safe.
 */

import { answersForHistory, askForHistory, type DeskAsk } from "./ask";
import { describeChart, type ChartSpec } from "./chart-spec";

export const CONTEXT_TAG = "falcon_context";
export const CONTEXT_KINDS = ["chart", "ask", "strategy_test", "images"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
/** One item of context about the reply just before a member message. */
export type HistoryContext = { kind: ContextKind; text: string };

/** Characters of context per member message the route accepts (a strategy script can be long). */
export const CONTEXT_MAX_CHARS = 16_000;

export function chartContext(spec: ChartSpec): HistoryContext {
  return { kind: "chart", text: `Your previous reply drew a chart with show_chart: "${spec.title}". ${describeChart(spec)}` };
}

export function askContext(ask: DeskAsk): HistoryContext {
  return { kind: "ask", text: askForHistory(ask) };
}

/** `text`: lab/run.ts runForHistory. */
export function runContext(text: string): HistoryContext {
  return { kind: "strategy_test", text };
}

export function imagesContext(missing: number): HistoryContext {
  return { kind: "images", text: `${missing === 1 ? "An image" : `${missing} images`} the member attached to this message ${missing === 1 ? "is" : "are"} no longer available to you.` };
}

/** Context items from a request body, checked: known kinds, text kept, the total capped. */
export function cleanContext(v: unknown): HistoryContext[] {
  if (!Array.isArray(v)) return [];
  const out: HistoryContext[] = [];
  let left = CONTEXT_MAX_CHARS;
  for (const x of v) {
    const kind = (x as { kind?: unknown } | null)?.kind;
    const text = (x as { text?: unknown } | null)?.text;
    if (!CONTEXT_KINDS.includes(kind as ContextKind) || typeof text !== "string" || !text.trim() || left <= 0) continue;
    const t = text.trim().slice(0, left);
    left -= t.length;
    out.push({ kind: kind as ContextKind, text: t });
  }
  return out;
}

/** The items as the text block that opens the member's turn. A closing tag inside the text is defused. */
export function contextText(items: HistoryContext[]): string {
  const close = new RegExp(`</?${CONTEXT_TAG}`, "gi");
  return items.map((c) => `<${CONTEXT_TAG} kind="${c.kind}">\n${c.text.replace(close, "<_")}\n</${CONTEXT_TAG}>`).join("\n");
}

/** Whether a text block is such context (the ask resume drops it from the member's own words). */
export function isContextText(text: string): boolean {
  return text.trimStart().startsWith(`<${CONTEXT_TAG}`);
}

/** A message as the request carries it (POST /api/desk/chat `messages`). `context`: about the reply just before it. */
export type WireMessage = { role: "user" | "assistant"; text: string; images?: { mediaType: string; data: string }[]; context?: HistoryContext[] };
/** The parts of a chat message (lab/sessions.ts LabMessage) the history reads. */
export type HistoryMessage = { role: "user" | "assistant"; text: string; tools?: { chart?: ChartSpec }[]; ask?: DeskAsk; images?: { id: string }[] };
export type WireOptions<M> = {
  /** Messages sent (the route keeps as many). */
  limit: number;
  /** The reply's strategy test for the model (lab/run.ts runForHistory), or null when it has none worth sending. */
  run: (m: M) => string | null;
  /** The full image still held for this page visit. */
  image: (id: string) => { mediaType: string; data: string } | undefined;
  /** Base64 characters and images per request. */
  imageBudget: number;
  imagesPerRequest: number;
};

/**
 * The last messages for the request: each reply's own words only, and what it showed (charts, a question card,
 * the newest strategy test) as context on the member message after it; full images newest first while they fit.
 */
export function wireHistory<M extends HistoryMessage>(messages: M[], o: WireOptions<M>): WireMessage[] {
  const recent = messages.filter((m) => !(m.role === "assistant" && !m.text.trim() && !m.ask)).slice(-o.limit);
  let budget = o.imageBudget;
  let count = 0;
  let runShown = false;
  const out: WireMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    const w: WireMessage = { role: m.role, text: m.text };
    if (m.role === "assistant") {
      const context: HistoryContext[] = [];
      // The newest strategy test goes back with its numbers and script, so a follow-up can change it.
      const run = runShown ? null : o.run(m);
      if (run) {
        context.push(runContext(run));
        runShown = true;
      }
      // Charts drawn in the reply (show_chart): named and described, so a follow-up can refer to them or redraw them.
      for (const t of m.tools ?? []) if (t.chart) context.push(chartContext(t.chart));
      // A question card (ask_user): the picked answer is the member's next turn. A reply that was only the card says its questions.
      if (m.ask) {
        context.push(askContext(m.ask));
        if (!w.text.trim()) w.text = m.ask.questions.map((q) => q.question).join(" ");
        if (m.ask.answers) out.unshift({ role: "user", text: answersForHistory(m.ask) });
      }
      const next = out[0];
      if (context.length && next?.role === "user") next.context = [...context, ...(next.context ?? [])];
    }
    if (m.role === "user" && m.images?.length) {
      const images: { mediaType: string; data: string }[] = [];
      let missing = 0;
      for (const img of m.images) {
        const full = o.image(img.id);
        if (full && count < o.imagesPerRequest && full.data.length <= budget) {
          images.push(full);
          budget -= full.data.length;
          count++;
        } else missing++;
      }
      if (images.length) w.images = images;
      if (missing) w.context = [...(w.context ?? []), imagesContext(missing)];
    }
    out.unshift(w);
  }
  return out;
}

/** The bracketed notes history used to carry in the assistant's text, by their opening words. */
const LEGACY = ["[Chart drawn in this reply", "[You asked the member:", "[Strategy test in this reply", "[Its script:"];
const OPENERS = [...LEGACY, `<${CONTEXT_TAG}`];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A legacy note runs to the "]" that ends its line (else the first "]"); a context block to its closing tag.
 * Spaces before it on the line go with it.
 */
const MARKER = new RegExp(
  `[ \\t]*(?:(?:${LEGACY.map(esc).join("|")})(?:[^\\n]*?\\](?=[ \\t]*(?:\\r?\\n|$))|[^\\n\\]]*\\])|<${CONTEXT_TAG}\\b[\\s\\S]*?</${CONTEXT_TAG}\\s*>)`,
  "gi",
);
/** An opener with no end yet: from it to the end of the text. */
const OPEN = new RegExp(`(?:${LEGACY.map(esc).join("|")})|<${CONTEXT_TAG}\\b`, "i");

/**
 * The reply's text without echoed history markers, and `pos` mapping a position in the input (a tool row's `at`)
 * to the output. `streaming`: the text may still grow, so an unfinished marker, or a tail that could be the start
 * of one ("[", "[Chart dr", "<falcon_"), is held back. Once complete, an unfinished marker is still cut (it is never
 * text the member should see), while a tail that is only a possible start ("[") stays.
 */
export function stripHistoryMarkers(text: string, streaming: boolean): { text: string; pos: (i: number) => number } {
  const cuts: [number, number][] = [];
  for (const m of text.matchAll(MARKER)) {
    let end = m.index! + m[0].length;
    // The marker's own line break goes with it when it stood on a line of its own.
    const before = m.index === 0 || text[m.index! - 1] === "\n";
    if (before && text[end] === "\n") end++;
    cuts.push([m.index!, end]);
  }
  // Unfinished: an opener after the last whole marker, else (streaming) a tail that may become one.
  const from = cuts.length ? cuts[cuts.length - 1]![1] : 0;
  const open = OPEN.exec(text.slice(from));
  if (open) {
    // A note with no "]" on its line ends there; an unclosed block (or a note still arriving) runs to the end.
    const at = from + open.index;
    const nl = open[0].startsWith("[") ? text.indexOf("\n", at) : -1;
    cuts.push([at, nl >= 0 ? nl + 1 : text.length]);
  }
  else if (streaming) {
    for (let k = Math.max(from, text.length - 40); k < text.length; k++) {
      const c = text[k];
      if (c !== "[" && c !== "<") continue;
      const tail = text.slice(k).toLowerCase();
      if (OPENERS.some((o) => o.length > tail.length && o.toLowerCase().startsWith(tail))) {
        cuts.push([k, text.length]);
        break;
      }
    }
  }
  if (!cuts.length) return { text, pos: (i) => i };
  let out = "";
  let last = 0;
  for (const [a, b] of cuts) {
    out += text.slice(last, a);
    last = b;
  }
  out += text.slice(last);
  // A marker at the very end leaves no trailing blank lines behind it.
  if (cuts[cuts.length - 1]![1] === text.length) out = out.replace(/\s+$/, "");
  const pos = (i: number) => {
    let removed = 0;
    for (const [a, b] of cuts) {
      if (i <= a) break;
      removed += Math.min(i, b) - a;
    }
    return Math.min(i - removed, out.length);
  };
  return { text: out, pos };
}
