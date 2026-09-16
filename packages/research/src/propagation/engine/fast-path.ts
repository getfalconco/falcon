/**
 * Which Tracker messages are worth a propagation run the instant they land.
 * Pure predicate — see `progress.ts` on why it lives beside the engine.
 */

import type { TrackerMessageType } from "../../tracker/types.js";

/**
 * Only the two fields the predicate reads. Deliberately loose: callers pass
 * whole Tracker messages, replayed rows and test fixtures, and none of them
 * should have to build a full payload union to ask this one question.
 */
export type FastPathInput = { type: TrackerMessageType | string; payload?: unknown };

/**
 * Which Tracker messages are worth a propagation run the instant they land.
 *
 * The 15-minute replay cycle is the safety net; this is the lane that decides
 * whether a second-order move is still catchable. It is deliberately narrow:
 * only triggers Base can route without a Classifier verdict, so the fast path
 * needs no LLM, no budget and no waiting — the same two rows the routing table
 * sends to `destination: propagation` (`base/routing.ts`).
 *
 * A news_item is NOT a fast trigger: it only reaches propagation through a
 * Classifier verdict, which has its own cycle. Adding it here would fire a run
 * for every headline and produce nothing.
 */
export type FastPathTrigger = { kind: "filing"; itemCodes: string[] } | { kind: "gap" };

export function fastPathTrigger(
  message: FastPathInput,
  mapped8kItemCodes: readonly string[],
): FastPathTrigger | null {
  if (message.type === "filing_item") {
    const p = (message.payload ?? {}) as { item_codes?: unknown };
    const codes = Array.isArray(p.item_codes) ? p.item_codes.filter((c): c is string => typeof c === "string") : [];
    const hit = codes.filter((c) => mapped8kItemCodes.includes(c));
    return hit.length > 0 ? { kind: "filing", itemCodes: hit } : null;
  }
  // A gap is the market's own read of an event; whether it counts is decided
  // by Base's `event_gap` composite in the replay the handler runs.
  if (message.type === "gap_event") return { kind: "gap" };
  return null;
}

/** True when this message should wake the propagation host immediately. */
export function isFastPathTrigger(
  message: FastPathInput,
  mapped8kItemCodes: readonly string[],
): boolean {
  return fastPathTrigger(message, mapped8kItemCodes) !== null;
}
