import { createRoot } from "react-dom/client";
import "../globals.css";
import HomePage from "../pages/HomePage";
import { toggleDemoMode } from "../lib/demo-mode";
import { applyTheme, getStoredTheme } from "../lib/theme";

/**
 * Scratch harness: the real dashboard canvas with nothing behind it, so the
 * resize rules (edge snap, size match, the gutter limit, the seam between two
 * cards) can be driven and measured without the desktop app's window.
 *
 * A hidden preview pane never fires requestAnimationFrame, and the page ends
 * a resize inside one; without this the canvas believes the resize is still
 * going and never draws a seam.
 */
window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  window.setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame;

// Every IPC call answers "not here": the layout is what is being looked at.
// A subscription (`onRiskSnapshot`, `onTrackerMessage`, ...) hands back its
// unsubscribe function, as the real preload does; an async stand-in there
// returns a promise, and the card that calls it on unmount takes the page down.
(window as unknown as { meridian: unknown }).meridian = new Proxy(
  {},
  {
    get: (_target, key) =>
      typeof key === "string" && /^on[A-Z]/.test(key)
        ? () => () => {}
        : async () => ({ ok: false, error: "preview" }),
  },
);

// Two cards side by side, further apart than a gutter, so an edge has
// somewhere to travel before it meets the limit.
if (new URLSearchParams(location.search).get("seed") !== "keep") {
  localStorage.setItem(
    "falcon.ui.canvas.v1",
    JSON.stringify({
      boxes: {
        assets: { x: 0, y: 0, w: 0.3, h: 500 },
        portfolio: { x: 0.4, y: 0, w: 0.5, h: 500 },
      },
      order: ["portfolio", "assets"],
    }),
  );
}

applyTheme(getStoredTheme());
toggleDemoMode();

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh" }}>
    <HomePage userName="Kuzey" onSignOut={() => {}} />
  </div>,
);
