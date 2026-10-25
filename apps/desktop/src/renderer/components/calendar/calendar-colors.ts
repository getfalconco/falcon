import { useSyncExternalStore } from "react";
import { getThemeSnapshot, subscribeTheme, type Theme } from "@/lib/theme";
import type { CalendarColor } from "../../../shared/calendar-events";

/**
 * Calendar tab: the shades behind each colour name. Accents are Apple's
 * system colours (systemBlue, systemCyan, systemMint, systemPurple,
 * systemIndigo, systemPink, systemOrange, systemYellow, systemBrown,
 * systemGray); the label shades are those hues taken deep for cream and
 * pale for black.
 *
 * The rest of the app turns dark by `globals.css` rewriting its literal
 * palette classes. Event colours are too many to add to that list one by one,
 * so they are inline styles picked here per theme: on cream a soft tint with
 * a deep label, on black a low-alpha wash with a light one. The stripe down a
 * block's edge is the colour at full strength in both.
 */

export type EventShade = {
  /** The block's fill. */
  bg: string;
  /** Its fill while pointed at or selected. */
  bgActive: string;
  /** The stripe on its leading edge, and the dot in lists. */
  accent: string;
  text: string;
  /** The secondary line (time, tickers). */
  subtext: string;
};

type Base = { accent: string; lightText: string; darkText: string };

const BASE: Record<CalendarColor, Base> = {
  blue: { accent: "#007aff", lightText: "#003166", darkText: "#add4ff" },
  sky: { accent: "#32ade6", lightText: "#14455c", darkText: "#bde5f7" },
  teal: { accent: "#00c7be", lightText: "#00504c", darkText: "#adedea" },
  violet: { accent: "#af52de", lightText: "#462159", darkText: "#e5c8f4" },
  indigo: { accent: "#5856d6", lightText: "#232256", darkText: "#cac9f2" },
  pink: { accent: "#ff2d55", lightText: "#661222", darkText: "#ffbcc9" },
  fuchsia: { accent: "#d83ad6", lightText: "#561756", darkText: "#f3c0f2" },
  orange: { accent: "#ff9500", lightText: "#663c00", darkText: "#ffddad" },
  amber: { accent: "#f5a300", lightText: "#624100", darkText: "#fce2ad" },
  yellow: { accent: "#ffcc00", lightText: "#665200", darkText: "#ffefad" },
  brown: { accent: "#a2845e", lightText: "#413526", darkText: "#e1d8cb" },
  slate: { accent: "#8e8e93", lightText: "#39393b", darkText: "#dbdbdc" },
  stone: { accent: "#6e6a64", lightText: "#2c2a28", darkText: "#d1cfcd" },
};

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const cache = new Map<string, EventShade>();

export function eventShade(color: CalendarColor, theme: Theme): EventShade {
  const key = `${color}:${theme}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const base = BASE[color] ?? BASE.slate;
  const shade: EventShade =
    theme === "dark"
      ? { bg: rgba(base.accent, 0.2), bgActive: rgba(base.accent, 0.32), accent: base.accent, text: base.darkText, subtext: rgba(base.darkText, 0.72) }
      : { bg: rgba(base.accent, 0.13), bgActive: rgba(base.accent, 0.22), accent: base.accent, text: base.lightText, subtext: rgba(base.lightText, 0.72) };
  cache.set(key, shade);
  return shade;
}

/** The accent alone, for a dot in a list or a swatch. */
export function colorAccent(color: CalendarColor): string {
  return (BASE[color] ?? BASE.slate).accent;
}

/** The theme in force, following the switch in Settings live. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => "light" as Theme);
}

/** The current-time line. Red, as every calendar draws it; slightly lifted on black so it does not sink. */
export function nowLineColor(theme: Theme): string {
  return theme === "dark" ? "#ff453a" : "#ff3b30";
}
