import type { Tone } from "../../../shared/briefing-view";

/**
 * The few class strings every briefing section repeats. They are the
 * dashboard's own (the card label from the modal mastheads, the table head and
 * the hairline from the Positions card), held once here so the panel cannot
 * drift away from the cards it sits over one section at a time.
 */

/** The card label: "STOCK", "INSIGHT", and here "HANDOVER" and the section names. */
export const LABEL_CLASS = "select-none font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary";

/** The Positions card's table head. */
export const HEAD_CLASS = "font-['Geist_Mono'] text-[9.5px] uppercase tracking-[0.06em] text-content-tertiary";

export const MONO_CLASS = "font-['Geist_Mono'] tabular-nums";

export const PILL_CLASS = "rounded-full bg-ink/[0.05] px-1.5 py-px font-['Geist_Mono'] text-[9.5px] text-content-body";

/**
 * A story's figure beside its sentence: label and move in one mono chip. The
 * move takes the tone of its sign; the chip itself stays grey so a row of
 * them reads as evidence under a sentence, not as a scoreboard.
 */
export const CHIP_CLASS =
  "inline-flex items-baseline gap-1 rounded-md bg-ink/[0.04] px-1.5 py-px font-['Geist_Mono'] text-[11px] tabular-nums text-content-secondary";

/** One quiet line: what a section says when it has nothing, or less than usual, to show. */
export const QUIET_NOTE_CLASS = "text-[12px] leading-[1.5] text-content-tertiary";

/** Green and red mean "up" and "down" and nothing else anywhere in the panel. */
export const TONE_TEXT: Record<Tone, string> = {
  up: "text-tone-positive",
  down: "text-tone-negative",
  flat: "text-content-secondary",
  none: "text-content-secondary",
};
