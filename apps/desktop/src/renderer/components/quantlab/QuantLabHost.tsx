import { useEffect, useState } from "react";
import QuantLabPanel from "./QuantLabPanel";

/**
 * Global Shift+Q toggle for the Quant Lab panel (§10). Mounted once at the
 * root, reachable from any screen and ONLY by this shortcut — like Shift+T
 * (Tracker), Shift+B/A (Base/Analyst), Shift+P (Propagation), Shift+R (Risk),
 * Shift+S (Screen) and Shift+F (Gauge). Nothing in the product UI links to it
 * and nothing here touches the dashboard: this is a developer surface.
 */
/** Fire on `window` to open Quant Lab from anywhere. */
export const QUANTLAB_OPEN_EVENT = "falcon:quantlab-open";

export function openQuantLabPanel(): void {
  window.dispatchEvent(new CustomEvent(QUANTLAB_OPEN_EVENT));
}

export default function QuantLabHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // `code` survives keyboard layouts; `key` covers synthetic input.
      const isQ = event.code === "KeyQ" || event.key.toLowerCase() === "q";
      if (!isQ) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      setOpen((v) => !v);
    };
    const onOpenRequest = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(QUANTLAB_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(QUANTLAB_OPEN_EVENT, onOpenRequest);
    };
  }, []);

  if (!open) return null;
  return <QuantLabPanel onClose={() => setOpen(false)} />;
}
