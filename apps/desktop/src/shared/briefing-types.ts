/**
 * Handover briefing contracts — one definition, in the engine.
 *
 * The engine publishes the pure half of itself as
 * `@meridian/research/briefing/contracts` (types, and functions over plain
 * data and a supplied clock; no fs, no network), so the renderer and the main
 * process read the same source instead of a hand-kept mirror that drifts.
 * The Node-only surface stays behind `@meridian/research/briefing` and is
 * never imported from renderer code.
 */

export * from "@meridian/research/briefing/contracts";
