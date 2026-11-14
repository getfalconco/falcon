import type { Config } from "tailwindcss";
import preset from "@meridian/tailwind-config";
import tailwindcssAnimate from "tailwindcss-animate";

/** Workspace (/app) color tokens: RGB channels in CSS variables (app/globals.css), light by default, dark under html.dark. */
const tok = (name: string) => `rgb(var(--f-${name}) / <alpha-value>)`;

/** Workspace type scale: px sizes times the Appearance text size (--f-fs). `text-fs-13` is 13px at Medium. */
const scaled = (sizes: number[]) => Object.fromEntries(sizes.map((n) => [`fs-${n}`, `calc(${n}px * var(--f-fs, 1))`]));

const config: Config = {
  presets: [preset],
  darkMode: ["class"],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['var(--font-serif)', "Georgia", '"Times New Roman"', "serif"],
      },
      fontSize: scaled([9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 15.5, 16, 17, 18, 19, 20, 22, 24, 26, 28]),
      lineHeight: scaled([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 28, 32, 34, 35, 36]),
      colors: {
        page: tok("page"),
        canvas: tok("canvas"),
        surface: { DEFAULT: tok("surface"), 2: tok("surface-2"), 3: tok("surface-3"), hover: tok("surface-hover") },
        raised: tok("raised"),
        well: tok("well"),
        fore: { DEFAULT: tok("fore"), 2: tok("fore-2"), 3: tok("fore-3"), 4: tok("fore-4") },
        quiet: { DEFAULT: tok("quiet"), 2: tok("quiet-2") },
        faint: { DEFAULT: tok("faint"), 2: tok("faint-2"), 3: tok("faint-3") },
        line: tok("line"),
        paper: tok("paper"),
        solid: { DEFAULT: tok("solid"), hover: tok("solid-hover"), ink: tok("solid-ink") },
        iris: tok("iris"),
        up: tok("up"),
        down: tok("down"),
        warn: tok("warn"),
        caution: tok("caution"),
        flat: tok("flat"),
        avatar: { DEFAULT: tok("avatar"), hover: tok("avatar-hover") },
        chart: {
          customer: tok("chart-customer"),
          competitor: tok("chart-competitor"),
          peer: tok("chart-peer"),
          spy: tok("chart-spy"),
          ew: tok("chart-ew"),
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
