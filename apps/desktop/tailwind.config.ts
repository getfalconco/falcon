import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import preset, { appleRadius, cssVarColor as v } from "@meridian/tailwind-config";

const tone = (name: string) => ({
  DEFAULT: v(`--${name}`),
  muted: v(`--${name}-muted`),
  soft: v(`--${name}-soft`),
  line: v(`--${name}-line`),
  fill: v(`--${name}-fill`),
  solid: v(`--${name}-solid`),
});

const config: Config = {
  presets: [preset],
  content: ["./src/renderer/**/*.{js,ts,jsx,tsx}", "../../packages/ui/src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /*
         * The semantic tokens from globals.css, right in either theme with no
         * dark-mode rule of their own: `bg-surface-2`, `text-content-secondary`,
         * `border-edge-subtle`, `text-tone-positive`, `bg-tone-negative-soft`.
         */
        surface: {
          0: v("--surface-0"),
          1: v("--surface-1"),
          2: v("--surface-2"),
          3: v("--surface-3"),
          4: v("--surface-4"),
          sunken: v("--surface-sunken"),
        },
        fill: {
          hover: v("--fill-hover"),
          press: v("--fill-press"),
          selected: v("--fill-selected"),
          strong: v("--fill-strong"),
        },
        edge: {
          subtle: v("--border-subtle"),
          DEFAULT: v("--border-default"),
          strong: v("--border-strong"),
          focus: v("--focus-ring"),
        },
        content: {
          primary: v("--text-primary"),
          body: v("--text-body"),
          secondary: v("--text-secondary"),
          tertiary: v("--text-tertiary"),
          disabled: v("--text-disabled"),
          quaternary: v("--text-quaternary"),
        },
        /*
         * Apple's system hues by role. DEFAULT is the hue as text (the
         * Increase Contrast variant in light, AA on a card); `fill` is the
         * base system colour for a chart line, a bar, a dot or a gauge;
         * `solid` is the hue deep enough to carry white type (a badge, a
         * destructive button).
         */
        tone: {
          positive: tone("positive"),
          negative: tone("negative"),
          warning: tone("warning"),
          info: tone("info"),
          teal: tone("teal"),
          violet: tone("violet"),
          pink: tone("pink"),
          indigo: { DEFAULT: v("--indigo"), fill: v("--indigo-fill") },
          yellow: { DEFAULT: v("--yellow"), fill: v("--yellow-fill") },
        },
        /* The accent: systemBlue. `text-tint` is its AA text variant. */
        tint: { DEFAULT: v("--tint"), text: v("--tint-text") },
        switch: {
          on: "var(--switch-on)",
          off: "var(--switch-off)",
          "knob-on": "var(--switch-knob-on)",
          "knob-off": "var(--switch-knob-off)",
        },
        ink: {
          /* `bg-ink`: the solid near-black (the ink button, a tile, a mark). */
          DEFAULT: v("--ink"),
          soft: "var(--ink-soft)",
        },
        fg: {
          DEFAULT: "var(--fg-default)",
          muted: "var(--fg-muted)",
          faint: "var(--fg-faint)",
          body: "var(--fg-body)",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        gray: {
          100: "var(--ds-gray-100)",
          200: "var(--ds-gray-200)",
          500: "var(--ds-gray-500)",
          600: "var(--ds-gray-600)",
          700: "var(--ds-gray-700)",
          1000: "var(--ds-gray-1000)",
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
        "background-100": "var(--ds-background-100)",
        chart: {
          background: "var(--chart-background)",
          foreground: "var(--chart-foreground)",
          "foreground-muted": "var(--chart-foreground-muted)",
          label: "var(--chart-label)",
          grid: "var(--chart-grid)",
          crosshair: "var(--chart-crosshair)",
          "line-primary": "var(--chart-line-primary)",
          "line-secondary": "var(--chart-line-secondary)",
          "tooltip-background": "var(--chart-tooltip-background)",
          "tooltip-foreground": "var(--chart-tooltip-foreground)",
          "tooltip-muted": "var(--chart-tooltip-muted)",
        },
        popover: {
          DEFAULT: "hsl(var(--background))",
          foreground: "hsl(var(--foreground))",
        },
      },
      borderRadius: appleRadius,
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ['"Libre Baskerville"', "Georgia", '"Times New Roman"', "serif"],
        baskerville: ['"Libre Baskerville"', "Georgia", '"Times New Roman"', "serif"],
      },
      keyframes: {
        "select-in": {
          from: { opacity: "0", transform: "scale(0.96) translateY(-6px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "select-out": {
          from: { opacity: "1", transform: "scale(1) translateY(0)" },
          to: { opacity: "0", transform: "scale(0.96) translateY(-6px)" },
        },
      },
      animation: {
        "select-in": "select-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "select-out": "select-out 120ms ease-in",
      },
    },
  },
  // `font-normal`, `font-medium`... carry the weight as written (--fw-l) and
  // add the sans boost from globals.css (--fw-boost), so Urbanist reads a
  // step heavier while Geist Mono and the serifs keep their own weights.
  corePlugins: { fontWeight: false },
  plugins: [
    plugin(({ matchUtilities, theme }) => {
      matchUtilities(
        {
          font: (value: string) => ({
            "--fw-l": value,
            "font-weight": "calc(var(--fw-l) + var(--fw-boost, 0))",
          }),
        },
        { values: theme("fontWeight"), type: ["number"] },
      );
    }),
  ],
};

export default config;
