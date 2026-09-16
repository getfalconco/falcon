import { useEffect, useState } from "react";
import BasePanel, { type BasePanelView } from "./BasePanel";

/**
 * Global Shift+B / Shift+A toggles for the Base Engine panel. Mounted once at
 * the root, reachable from any screen and ONLY by these shortcuts — like
 * Shift+T for the Tracker, nothing in the product UI links to it. Shift+B
 * opens on the incidents view; Shift+A opens straight on the analyst tab
 * (Analyst spec §9). Either key closes an open panel.
 */
export default function BaseHost() {
  const [open, setOpen] = useState<BasePanelView | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // `code` keeps this on the physical key across keyboard layouts; the `key`
      // fallback covers events that carry no code (synthetic/remote input).
      const key = event.key.toLowerCase();
      const isB = event.code === "KeyB" || key === "b";
      const isA = event.code === "KeyA" || key === "a";
      if (!isB && !isA) return;

      // Never steal the shortcut from a field the user is typing into.
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      event.preventDefault();
      const view: BasePanelView = isA ? "analyst" : "incidents";
      setOpen((current) => (current ? null : view));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;
  return <BasePanel key={open} initialView={open} onClose={() => setOpen(null)} />;
}
