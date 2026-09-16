import type { Config } from "tailwindcss";

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
