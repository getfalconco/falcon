import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../globals.css";
import ChangelogModal from "../components/changelog/ChangelogModal";
import ProfilePill from "../components/dashboard/ProfilePill";
import { applyTheme, getStoredTheme } from "../lib/theme";

/**
 * Scratch harness: the What's new panel over a plain page, opened from a real
 * account pill, so the panel and the menu row's unseen dot can be looked at
 * without signing into the desktop app.
 *
 *   ?theme=dark|light   force a theme (default: the kept choice)
 *   ?closed=1           start with the panel shut, to see the dot on the row
 */

const params = new URLSearchParams(location.search);
const forced = params.get("theme");
applyTheme(forced === "dark" || forced === "light" ? forced : getStoredTheme());

function Harness() {
  const [open, setOpen] = useState(params.get("closed") !== "1");
  const dark = document.documentElement.dataset.theme === "dark";
  return (
    <div className="relative h-screen w-screen p-10" style={{ background: dark ? "#000" : "#f2f0ed" }}>
      <ProfilePill
        name="Kuzey"
        email="reader@example.com"
        onSelect={(key) => {
          if (key === "changelog") setOpen(true);
        }}
      />
      <ChangelogModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
