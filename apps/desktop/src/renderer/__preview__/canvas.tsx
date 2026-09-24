import { createRoot } from "react-dom/client";
import "../globals.css";
import HomePage from "../pages/HomePage";
import { isDemoMode, toggleDemoMode } from "../lib/demo-mode";
import { applyTheme, getStoredTheme } from "../lib/theme";

/**
 * Scratch harness: the real dashboard canvas with nothing behind it, so the
 * cards' placement and the resize rules (edge snap, size match, the gutter
 * limit, the seam between two cards) can be driven and measured without the
 * desktop app's window. Presentation mode is switched on, so every card draws
 * its demo data and no provider, key or main process is involved.
 *
 *   ?seed=keep   keep whatever canvas this origin already has, instead of the two-card seed
 *
 * A hidden preview pane never fires requestAnimationFrame, and the page ends
 * a resize inside one; without this the canvas believes the resize is still
 * going and never draws a seam.
 */
window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  window.setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame;

// Every IPC call answers "not here": the layout is what is being looked at.
(window as unknown as { meridian: unknown }).meridian = new Proxy(
  {},
  { get: () => async () => ({ ok: false, error: "preview" }) },
);

// Two cards side by side, further apart than a gutter, so an edge has
// somewhere to travel before it meets the limit. Every other card the page
// shows is laid out underneath by the page's own reconciliation.
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
  localStorage.removeItem("falcon.ui.cardOrder.v4");
}

applyTheme(getStoredTheme());
if (!isDemoMode()) toggleDemoMode();

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh" }}>
    <HomePage userName="Kuzey" userEmail="kuzey@example.com" onSignOut={() => {}} />
  </div>,
);
