import { useState } from "react";
import { useShortcut } from "@/lib/use-shortcuts";
import TrackerPanel from "./TrackerPanel";

/**
 * Global Shift+T toggle for the Tracker panel (rebindable in Settings →
 * Shortcuts). Mounted once at the root so the panel is reachable from any
 * screen — and reachable ONLY by this shortcut; nothing in the product UI
 * links to it.
 */
export default function TrackerHost() {
  const [open, setOpen] = useState(false);

  useShortcut("tracker", () => setOpen((v) => !v));

  if (!open) return null;
  return <TrackerPanel onClose={() => setOpen(false)} />;
}
