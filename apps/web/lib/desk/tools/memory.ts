/**
 * `remember` and `forget`: Falcon AI's memory across sessions (lib/desk/memory.ts).
 * Nothing is stored here: the result carries a MemoryEvent that the route sends
 * on the tool's "done" line (`memory`) and the client applies to the member's
 * list. `items` is the list the client sent with this request; it is updated
 * in place so a remember then forget in one reply agree.
 */

import { MEMORY_MAX_ITEMS, findMemory, memoryId, memoryText, type MemoryEvent, type MemoryItem } from "../memory";

export const REMEMBER_TOOL = {
  name: "remember",
  description:
    "Saves a short preference or fact about the member that should apply in all their future sessions, e.g. \"Answer in Turkish, briefly\" or \"Focuses on semiconductor stocks\". " +
    "Call it only when the member asks you to remember something, or states a lasting preference about how you should answer (language, length, format, focus). Never for one-off requests, and never for passwords, account numbers or other sensitive personal data. " +
    "Write one plain sentence in the member's language (Turkish stays Turkish), under 200 characters. Then confirm in one short line, in the same language.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 200, description: "The preference or fact, one sentence." } },
    required: ["text"],
    additionalProperties: false,
  },
} as const;

export const FORGET_TOOL = {
  name: "forget",
  description: "Removes one saved memory item, when the member asks you to forget or stop applying it. Give the item's id from the Memory block (or its text). To change an item, forget it and remember the new version.",
  input_schema: {
    type: "object",
    properties: { id: { type: "string", description: "The item's id, e.g. m3k9x2a." }, text: { type: "string", description: "The item's text, when the id is not known." } },
    additionalProperties: false,
  },
} as const;

export const MEMORY_TOOL_NAMES: readonly string[] = [REMEMBER_TOOL.name, FORGET_TOOL.name];

export type MemoryToolResult = { name: string; ok: boolean; content: string; label: string; ms: number; event?: MemoryEvent };

/** Label for the tool row while it runs. */
export function memoryLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as { text?: unknown };
  if (name === REMEMBER_TOOL.name) return `Remembering: ${memoryText(i.text) || "a preference"}`;
  return "Forgetting a saved item";
}

export function runMemoryTool(name: string, input: unknown, items: MemoryItem[]): MemoryToolResult {
  const i = (input && typeof input === "object" ? input : {}) as { id?: unknown; text?: unknown };
  const fail = (error: string, label: string): MemoryToolResult => ({ name, ok: false, content: JSON.stringify({ error }), label, ms: 0 });
  if (name === REMEMBER_TOOL.name) {
    const text = memoryText(i.text);
    if (!text) return fail("Give the preference as text.", "Nothing to remember");
    const same = items.find((m) => m.text.toLowerCase() === text.toLowerCase());
    if (same) return { name, ok: true, content: JSON.stringify({ saved: true, id: same.id, note: "Already saved." }), label: `Remembered: ${text}`, ms: 0 };
    if (items.length >= MEMORY_MAX_ITEMS) return fail(`Memory is full (${MEMORY_MAX_ITEMS} items). Ask the member which item to forget first.`, "Memory is full");
    const id = memoryId();
    items.push({ id, text, at: Date.now() });
    return { name, ok: true, content: JSON.stringify({ saved: true, id, text }), label: `Remembered: ${text}`, ms: 0, event: { op: "remember", id, text } };
  }
  const m = findMemory(items, i);
  if (!m) return fail("No saved item matches. The Memory block lists the ids.", "No saved item matched");
  items.splice(items.indexOf(m), 1);
  return { name, ok: true, content: JSON.stringify({ forgotten: true, id: m.id, text: m.text }), label: `Forgot: ${m.text}`, ms: 0, event: { op: "forget", id: m.id } };
}
