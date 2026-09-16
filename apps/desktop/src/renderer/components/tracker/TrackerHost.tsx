import { useEffect, useState } from "react";
import TrackerPanel from "./TrackerPanel";

/**
 * Global Shift+T toggle for the Tracker panel. Mounted once at the root so the
 * panel is reachable from any screen — and reachable ONLY by this shortcut;
 * nothing in the product UI links to it.
 */
export default function TrackerHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // `code` keeps this on the physical T across keyboard layouts; the `key`
      // fallback covers events that carry no code (synthetic/remote input).
      const isT = event.code === "KeyT" || event.key.toLowerCase() === "t";
      if (!isT) return;

      // Never steal the shortcut from a field the user is typing into.
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      event.preventDefault();
      setOpen((v) => !v);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;
  return <TrackerPanel onClose={() => setOpen(false)} />;
}
