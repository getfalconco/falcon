/**
 * Calendar tab: the class strings its pieces share. They are the app's own
 * vocabulary (the settings panes' buttons and fields, the briefing's labels),
 * written as the same literals so `globals.css` turns them dark with the rest.
 */

/** The settings panes' secondary button. */
export const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[12.5px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-50";

/** The settings panes' text field. */
export const FIELD =
  "app-no-drag rounded-xl border border-white/60 bg-white/55 px-3 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-[#9CA3AF] focus:bg-white/75 disabled:opacity-60";

/** A small square icon button: the arrows, the options. */
export const ICON_BUTTON =
  "app-no-drag flex h-7 w-7 items-center justify-center rounded-lg text-[#4b5563] transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] disabled:pointer-events-none disabled:opacity-30";

/** The card label: "FILTERS", "EVENT TYPES". */
export const SECTION_LABEL = "select-none font-sans text-[11px] font-medium tracking-[0.04em] text-[#9CA3AF]";

/** The small head: weekday names, hour labels, the week number. In the app's sans, like everything on the calendar. */
export const MONO_HEAD = "font-sans text-[10px] uppercase tracking-[0.06em] text-[#9CA3AF]";

/** The dashboard card frame. */
export const CARD =
  "rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150";

/** The grid's hairlines. */
export const HAIRLINE = "border-black/[0.06]";
