import type { Config } from "tailwindcss";

/**
 * Apple-like corner radii (desktop app). Each step reads a CSS variable the
 * app defines once (apps/desktop/src/renderer/globals.css, `--radius-*`),
 * with the same value as a fallback so a surface without the variables still
 * gets the scale:
 *   sm 4 (a tick, a bar end) · DEFAULT/md 6 (a small control) · lg 8 (an
 *   input, a compact button) · xl 10 (a button) · 2xl 12 (a popover, a menu,
 *   a tile in a card) · 3xl 16 (a card, a panel, a sheet) · full (a pill).
 * Exported rather than set on the preset so the marketing site keeps its own.
 */
export const appleRadius = {
  none: "0px",
  sm: "var(--radius-sm, 4px)",
  DEFAULT: "var(--radius-md, 6px)",
  md: "var(--radius-md, 6px)",
  lg: "var(--radius-lg, 8px)",
  xl: "var(--radius-xl, 10px)",
  "2xl": "var(--radius-2xl, 12px)",
  "3xl": "var(--radius-3xl, 16px)",
  full: "9999px",
} as const;

/**
 * A colour utility value that reads a CSS variable and still takes
 * Tailwind's opacity modifier (`bg-tone-positive/10`): the variable is mixed
 * toward transparent by the modifier's amount.
 */
export function cssVarColor(name: string): string {
  return `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`;
}

/**
 * Shared Meridian design tokens. Every app extends this preset so colors,
 * typography, shadows and motion stay identical across the marketing site
 * and the desktop app.
 */
const preset: Omit<Config, "content"> = {
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#242424",
          soft: "#1A1A1A",
        },
        accent: {
          DEFAULT: "#2563EB",
          bright: "#3B82F6",
          soft: "#EFF4FF",
        },
        fg: {
          DEFAULT: "#1C1C20",
          muted: "#5B5B63",
          faint: "#9097A1",
        },
        gain: {
          DEFAULT: "var(--market-gain)",
          soft: "var(--market-gain-soft)",
          muted: "var(--market-gain-muted)",
          bright: "var(--market-gain-bright)",
          deep: "var(--market-gain-deep)",
        },
        loss: {
          DEFAULT: "var(--market-loss)",
          soft: "var(--market-loss-soft)",
          muted: "var(--market-loss-muted)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        tightest: "-0.045em",
      },
      maxWidth: {
        container: "1180px",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
      },
      animation: {
        float: "float 7s ease-in-out infinite",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(10,10,11,0.04), 0 8px 24px -12px rgba(10,10,11,0.12)",
        card: "0 1px 3px rgba(10,10,11,0.05), 0 16px 40px -24px rgba(10,10,11,0.18)",
      },
    },
  },
  plugins: [],
};

export default preset;
