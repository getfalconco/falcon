/**
 * Suggested follow-up questions at the end of a Falcon AI reply. The model
 * ends a reply with a hidden block, `<followups>q1|q2|q3</followups>`
 * (lib/desk/system.ts); the chat strips it from the text the member sees,
 * also while the reply streams (a half-written tag is never shown), keeps the
 * questions on the message and shows them as Follow-ups
 * (components/ui/streaming-text.tsx). A reply without the block has none.
 * Echoed history markers (lib/desk/history-context.ts) are removed here too.
 * Pure and client-safe.
 */

import { stripHistoryMarkers } from "./history-context";

const OPEN = "<followups>";
const BLOCK = /\s*<followups>([\s\S]*?)<\/followups>\s*/gi;
const OPEN_RE = /<followups>/i;

export const MAX_FOLLOWUPS = 3;
const MAX_CHARS = 160;

/** The questions in a block's body: split on "|" or new lines, list marks dropped, at most three. */
export function parseFollowups(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of body.split(/[|\n]/)) {
    const q = part
      .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (q.length < 2 || q.length > MAX_CHARS || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length >= MAX_FOLLOWUPS) break;
  }
  return out;
}

/**
 * The visible text and the follow-ups. `streaming`: the text may still grow,
 * so an unclosed block, or a tail that could be the start of its tag ("<",
 * "<follo"), is held back. Once the reply is complete only whole blocks are
 * removed (a lone "<" at the end is just text then).
 */
export function splitFollowups(text: string, streaming: boolean): { text: string; followups: string[] } {
  let followups: string[] = [];
  const unmarked = stripHistoryMarkers(text, streaming).text;
  let out = unmarked.replace(BLOCK, (_m, body: string) => {
    if (!followups.length) followups = parseFollowups(body);
    return "\n";
  });
  const open = OPEN_RE.exec(out);
  if (open) out = out.slice(0, open.index);
  else if (streaming) {
    const lt = out.lastIndexOf("<");
    if (lt >= 0 && out.length - lt <= OPEN.length && OPEN.startsWith(out.slice(lt).toLowerCase())) out = out.slice(0, lt);
  }
  // The block's own line breaks go with it; the reply's text is otherwise unchanged.
  if (out !== unmarked) out = out.replace(/\s+$/, "");
  return { text: out, followups };
}

/** Stored follow-ups checked (anything malformed dropped). */
export function cleanFollowups(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = parseFollowups(v.filter((x): x is string => typeof x === "string").join("\n"));
  return list.length ? list : undefined;
}
