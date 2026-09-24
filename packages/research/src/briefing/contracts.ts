/**
 * Renderer-safe contracts for the handover briefing.
 *
 * Everything re-exported here is pure: types, and functions over plain data
 * and a caller-supplied clock. No fs, no network, no model client, so a
 * browser bundle can import it. That is what lets the desktop renderer decide
 * "is this the pre-open window" with the engine's own rule instead of a copy
 * of it, the way `propagation/engine/contracts.ts` shares the priced-in
 * arithmetic.
 *
 * The Node-only surface (assembly, narrative, replay) stays behind
 * `@meridian/research/briefing`.
 */

export * from "./types.js";

// `window.ts` reaches only into `tracker/calendar.ts`, which imports nothing
// and leans on `Intl` alone, so the session rule runs unchanged in a browser.
export { resolveBriefingWindow } from "./window.js";

// Both import types and nothing else. They are here so the dashboard card and
// the demo book use the engine's own lead rows and book arithmetic; a second
// copy of either in the renderer is a list that drifts.
export * from "./markets.js";
export * from "./book.js";

// The conclusions the report leads with. Its import graph is the session
// calendar (Intl only), the expiry rules over it and the types; the demo book
// draws its conclusions with this function, so the demo and a real report can
// never word the same figures two ways.
export { MAX_IMPLICATIONS, deriveImplications, type ImplicationInput, type ImplicationPosition } from "./implications.js";

// The stories the report leads with. Types only in its import graph, so the
// demo book tells its night the way a real report does, in the same words.
export { MAX_STORIES, deriveStories, type StoryInput } from "./stories.js";
