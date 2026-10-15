import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
import "../globals.css";
import { applyTheme, getStoredTheme, getThemeSnapshot, subscribeTheme, writeThemeChoice } from "../lib/theme";
import { installThemeOverrides } from "../lib/theme-editor/live";

/**
 * Scratch harness: stands in for the app window next to the dark theme
 * editor. Open /theme-editor.html in another tab of the same origin; edits
 * there arrive here through the same `storage` event the Electron windows use
 * (lib/theme-editor/live.ts), and `#theme-overrides` holds what was applied.
 *
 *   ?theme=light   start in light, to see the editor's "Switch app to dark" note
 */
const themeParam = new URLSearchParams(location.search).get("theme");
if (themeParam === "light" || themeParam === "dark") writeThemeChoice(themeParam);
applyTheme(getStoredTheme());
installThemeOverrides();

function Target() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot);
  return (
    <div className="min-h-full bg-surface-0 p-6 text-content-primary">
      <div className="mb-4 flex items-center gap-3 text-[12px] text-content-secondary">
        <span data-testid="theme">theme: {theme}</span>
        <button
          type="button"
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1 text-content-primary"
          onClick={() => writeThemeChoice(theme === "dark" ? "light" : "dark")}
        >
          toggle
        </button>
      </div>
      <div className="max-w-md rounded-2xl border border-edge bg-surface-1 p-5 shadow-[var(--shadow-card)]" data-testid="card">
        <h2 className="text-[15px] font-medium text-content-primary">Card on surface-1</h2>
        <p className="mt-1 text-[13px] text-content-body">Body text sits here, with secondary and tertiary below.</p>
        <p className="mt-1 text-[12px] text-content-secondary">Secondary text</p>
        <p className="text-[12px] text-content-tertiary">Tertiary text</p>
        <div className="mt-3 flex gap-2">
          <span className="rounded-full border border-tone-positive-line bg-tone-positive-soft px-2 py-0.5 text-[12px] text-tone-positive">+2.4%</span>
          <span className="rounded-full border border-tone-negative-line bg-tone-negative-soft px-2 py-0.5 text-[12px] text-tone-negative">-1.1%</span>
          <span className="rounded-full border border-tone-info-line bg-tone-info-soft px-2 py-0.5 text-[12px] text-tone-info-muted">info</span>
        </div>
        <div className="mt-3 rounded-xl bg-surface-2 p-3 text-[12px] text-content-body">Raised inside the card (surface-2)</div>
        <button type="button" className="mt-3 rounded-xl bg-[var(--cta-bg)] px-3 py-1.5 text-[13px] text-[var(--cta-fg)]">
          Call to action
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Target />);
