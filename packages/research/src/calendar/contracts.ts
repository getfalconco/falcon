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
export { resolveSessionWindow, sessionWindowFor } from "./window.js";

// The rest of what a day's rows are built from in the renderer. Every one of these
// reaches only the session calendar (Intl), the date rules beside it and the
// curated data file, so a browser can list any covered day with the engine's
// own rows instead of a copy of them.
export { MACRO_CALENDAR } from "./data/macro-calendar.js";
export { coverageStatus, loadMacroCalendar } from "./macro-calendar.js";
export { expiryEventsBetween } from "./expiry.js";
export { rebalanceEventsBetween } from "./rebalance.js";
export { EARNINGS_HORIZON_SESSIONS, REBALANCE_HORIZON_SESSIONS, calendarToday } from "./today.js";
export { addTradingDays } from "../tracker/calendar.js";
