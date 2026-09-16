import type { Config } from "tailwindcss";
import preset from "@meridian/tailwind-config";

const config: Config = {
  presets: [preset],
  content: ["./src/renderer/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)",
        ink: "var(--ink)",
        body: "var(--body)",
        cta: {
          DEFAULT: "var(--cta-bg)",
          foreground: "var(--cta-fg)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", '"Times New Roman"', "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
};

export default config;
