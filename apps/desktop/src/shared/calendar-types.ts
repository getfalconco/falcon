/**
 * Session calendar contracts: one definition, in the engine.
 *
 * The engine publishes the pure half of itself as
 * `@meridian/research/calendar/contracts` (types, the session rules over a
 * supplied clock, the curated calendar and the row builder over it; no fs, no
 * network), so the renderer and the main process
 * read the same source instead of a hand-kept mirror that drifts. The
 * Node-only surface stays behind `@meridian/research/calendar` and is never
 * imported from renderer code.
 */

export * from "@meridian/research/calendar/contracts";
