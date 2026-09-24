/**
 * Renderer-safe contracts for the session calendar.
 *
 * Everything re-exported here is pure: types, and functions over plain data
 * and a caller-supplied clock. No fs, no network, so a browser bundle can
 * import it. That is what lets the desktop renderer decide which session the
 * clock is on with the engine's own rule instead of a copy of it.
 *
 * The Node-only surface (assembly over the ports) stays behind
 * `@meridian/research/calendar`.
 */

export * from "./types.js";

// `window.ts` reaches only into `tracker/calendar.ts`, which imports nothing
// and leans on `Intl` alone, so the session rule runs unchanged in a browser.
export { resolveSessionWindow } from "./window.js";
