import { useEffect, useState } from "react";
import { useShortcut } from "@/lib/use-shortcuts";
import QuantLabPanel from "./QuantLabPanel";

/**
 * Global Shift+Q toggle for the Quant Lab panel (§10). Mounted once at the
 * root, reachable from any screen and ONLY by this shortcut — like Shift+T
 * (Tracker), Shift+B/A (Base/Analyst), Shift+P (Propagation), Shift+R (Risk),
 * Shift+S (Screen) and Shift+F (Gauge). Nothing in the product UI links to it
 * and nothing here touches the dashboard: this is a developer surface. The
 * key can be moved in Settings → Shortcuts.
 */
/** Fire on `window` to open Quant Lab from anywhere. */
export const QUANTLAB_OPEN_EVENT = "falcon:quantlab-open";

export function openQuantLabPanel(): void {
  window.dispatchEvent(new CustomEvent(QUANTLAB_OPEN_EVENT));
}

export default function QuantLabHost() {
  const [open, setOpen] = useState(false);

  useShortcut("quantlab", () => setOpen((v) => !v));

  useEffect(() => {
    const onOpenRequest = () => setOpen(true);
    window.addEventListener(QUANTLAB_OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(QUANTLAB_OPEN_EVENT, onOpenRequest);
  }, []);

  if (!open) return null;
  return <QuantLabPanel onClose={() => setOpen(false)} />;
}
