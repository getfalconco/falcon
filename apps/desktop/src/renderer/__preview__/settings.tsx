import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../globals.css";
import SettingsModal from "../components/settings/SettingsModal";
import { applyTheme, getStoredTheme } from "../lib/theme";

/**
 * Scratch harness: the settings panel over a plain page, so the rail can be
 * looked at and driven without signing into the desktop app.
 */

applyTheme(getStoredTheme());

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <div className="h-screen w-screen p-10" style={{ background: "#f2f0ed", colorScheme: "light" }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-white/60 bg-white/55 px-4 py-2 text-[13px] text-[#1d1b1b]"
      >
        Open settings
      </button>
      <SettingsModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
