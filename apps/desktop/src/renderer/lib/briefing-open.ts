/**
 * "Open the handover briefing": the one door the dashboard card and the
 * keyboard shortcut both go through, so the host that owns the panel state
 * hears a single event instead of being handed a setter through the tree.
 * The automatic pre-open showing does not come through here: it is the host's
 * own decision (see `briefing-seen.ts`), and keeping it out lets `source` mean
 * "a person asked for this" without exception.
 */
export const BRIEFING_OPEN_EVENT = "falcon:briefing-open";

export type BriefingOpenDetail = { source: "card" | "shortcut" };

export function openBriefing(source: BriefingOpenDetail["source"]): void {
  // Helpers in this folder are imported by node-side tests, where neither
  // global exists; a bare `window.dispatchEvent` would throw at the call site
  // of a test that only meant to exercise the caller.
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent<BriefingOpenDetail>(BRIEFING_OPEN_EVENT, { detail: { source } }));
}
