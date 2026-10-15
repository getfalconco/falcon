import { useEffect, useState } from "react";
import { useShortcut } from "@/lib/use-shortcuts";
import RipplePanel from "./RipplePanel";

/**
 * Global Shift+P toggle for the Propagation ripple view (spec §8). Mounted
 * once at the root, reachable from any screen and ONLY by this shortcut —
 * same wiring as Shift+T / Shift+B / Shift+A, a different visual grade: this
 * is the first surface where Falcon's thesis is visible, so it is finished as
 * product, not as an instrument panel. Esc or Shift+P closes it. Shift+P can
 * be moved in Settings → Shortcuts.
 */
/** Fire on `window` to open the ripple panel from anywhere. */
export const PROPAGATION_OPEN_EVENT = "falcon:propagation-open";

/** Which run — and optionally which target's drawer — the panel should land on. */
export type PropagationFocus = { runId: string; targetKey?: string };

export function openPropagationPanel(focus?: PropagationFocus): void {
  window.dispatchEvent(new CustomEvent(PROPAGATION_OPEN_EVENT, { detail: focus }));
}

export default function PropagationHost() {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<PropagationFocus | null>(null);

  useShortcut("propagation", () => {
    setFocus(null);
    setOpen((v) => !v);
  });

  useEffect(() => {
    // Anything in the app can ask for the panel without knowing the shortcut
    // (the Opportunities card's button does).
    const onOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent<PropagationFocus | undefined>).detail;
      setFocus(detail?.runId ? detail : null);
      setOpen(true);
    };

    window.addEventListener(PROPAGATION_OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(PROPAGATION_OPEN_EVENT, onOpenRequest);
  }, []);

  if (!open) return null;
  return <RipplePanel focus={focus} onClose={() => setOpen(false)} />;
}
