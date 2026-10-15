import { useSyncExternalStore } from "react";
import { getThemeSnapshot, subscribeTheme, type Theme } from "@/lib/theme";
import type { CalendarColor } from "../../../shared/calendar-events";

/**
 * Calendar tab: the shades behind each colour name.
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
  blue: { accent: "#3b82f6", lightText: "#1e3a8a", darkText: "#bfd4fe" },
  sky: { accent: "#0ea5e9", lightText: "#0c4a6e", darkText: "#b5e3fb" },
  teal: { accent: "#14b8a6", lightText: "#134e4a", darkText: "#a7ece2" },
  violet: { accent: "#8b5cf6", lightText: "#4c1d95", darkText: "#d8cafd" },
  indigo: { accent: "#6366f1", lightText: "#312e81", darkText: "#c9cafc" },
  pink: { accent: "#ec4899", lightText: "#831843", darkText: "#f8c4dd" },
  fuchsia: { accent: "#d946ef", lightText: "#701a75", darkText: "#f1c7f8" },
  orange: { accent: "#f97316", lightText: "#7c2d12", darkText: "#fdcfae" },
  amber: { accent: "#d97706", lightText: "#78350f", darkText: "#f9d79a" },
  yellow: { accent: "#ca8a04", lightText: "#713f12", darkText: "#f3e29b" },
  brown: { accent: "#a16207", lightText: "#5b3a12", darkText: "#e6cfa8" },
  slate: { accent: "#64748b", lightText: "#1e293b", darkText: "#d0d7e2" },
  stone: { accent: "#78716c", lightText: "#292524", darkText: "#dcd8d4" },
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
  return theme === "dark" ? "#f05252" : "#e5484d";
}
