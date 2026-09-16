import { createRoot } from "react-dom/client";
import "../globals.css";
import { applyTheme } from "../lib/theme";
import UpdatePill from "../components/UpdatePill";
import type { UpdateStatus } from "../../shared/update-types";

/**
 * Scratch harness for the bottom-left update card.
 *
 * `?kind=ready` (Windows, click to restart), `?kind=unsigned` (macOS, nothing
 * to click), or `?kind=both` (default) to see them together. Shapes sit behind
 * the cards so the backdrop blur is actually visible. Clicks are counted on
 * window.__installs instead of restarting anything.
 */
const asked = new URLSearchParams(location.search).get("kind") ?? "both";

applyTheme();
(window as any).__installs = 0;

function bridgeFor(kind: UpdateStatus["kind"]) {
  const status: UpdateStatus =
    kind === "unsigned"
      ? { kind: "unsigned", version: "0.1.0" }
      : { kind: "ready", version: "0.1.0" };
  return {
    getUpdateStatus: async () => status,
    onUpdateStatus: () => () => {},
    installUpdate: async () => {
      (window as any).__installs += 1;
      // eslint-disable-next-line no-console
      console.log("installUpdate called", (window as any).__installs);
      return { ok: true };
    },
  };
}

/** Each card needs its own bridge, so swap it around the render. */
function Card({ kind, label }: { kind: UpdateStatus["kind"]; label: string }) {
  (window as any).meridian = bridgeFor(kind);
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#9CA3AF]">
        {label}
      </span>
      <UpdatePill />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="relative h-screen w-screen overflow-hidden bg-[#EAEAE6]">
    {/* Colour behind the glass, so the blur has something to do. */}
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute left-10 top-40 h-56 w-56 rounded-full bg-[#189E9A]/35 blur-2xl" />
      <div className="absolute left-56 top-72 h-48 w-72 rounded-full bg-[#a86448]/30 blur-2xl" />
      <div className="absolute left-24 top-96 h-40 w-40 rounded-full bg-[#2563EB]/25 blur-2xl" />
    </div>

    <div className="absolute left-12 top-16 flex flex-col gap-10">
      {(asked === "both" || asked === "ready") && <Card kind="ready" label="windows" />}
      {(asked === "both" || asked === "unsigned") && <Card kind="unsigned" label="macos · unsigned" />}
    </div>

    <p className="absolute bottom-6 left-12 max-w-md text-[11px] leading-relaxed text-[#6b7280]">
      Live preview. Hover the top card, click it — the click is counted, nothing restarts.
    </p>
  </div>,
);
