import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import preset from "@meridian/tailwind-config";

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
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          4: "var(--surface-4)",
          sunken: "var(--surface-sunken)",
        },
        fill: {
          hover: "var(--fill-hover)",
          press: "var(--fill-press)",
          selected: "var(--fill-selected)",
          strong: "var(--fill-strong)",
        },
        edge: {
          subtle: "var(--border-subtle)",
          DEFAULT: "var(--border-default)",
          strong: "var(--border-strong)",
          focus: "var(--focus-ring)",
        },
        content: {
          primary: "var(--text-primary)",
          body: "var(--text-body)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          disabled: "var(--text-disabled)",
        },
        tone: {
          positive: { DEFAULT: "var(--positive)", muted: "var(--positive-muted)", soft: "var(--positive-soft)", line: "var(--positive-line)" },
          negative: { DEFAULT: "var(--negative)", muted: "var(--negative-muted)", soft: "var(--negative-soft)", line: "var(--negative-line)" },
          warning: { DEFAULT: "var(--warning)", muted: "var(--warning-muted)", soft: "var(--warning-soft)", line: "var(--warning-line)" },
          info: { DEFAULT: "var(--info)", muted: "var(--info-muted)", soft: "var(--info-soft)", line: "var(--info-line)" },
          teal: { DEFAULT: "var(--teal)", muted: "var(--teal-muted)", soft: "var(--teal-soft)", line: "var(--teal-line)" },
          violet: { DEFAULT: "var(--violet)", muted: "var(--violet-muted)", soft: "var(--violet-soft)", line: "var(--violet-line)" },
          pink: { DEFAULT: "var(--pink)", muted: "var(--pink-muted)", soft: "var(--pink-soft)", line: "var(--pink-line)" },
        },
        switch: {
          on: "var(--switch-on)",
          off: "var(--switch-off)",
          "knob-on": "var(--switch-knob-on)",
          "knob-off": "var(--switch-knob-off)",
        },
        ink: {
          DEFAULT: "var(--ink-default)",
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
      borderRadius: {
        DEFAULT: "var(--radius)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 1px)",
        sm: "calc(var(--radius) - 2px)",
        xl: "calc(var(--radius) + 2px)",
        "2xl": "calc(var(--radius) + 4px)",
      },
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
