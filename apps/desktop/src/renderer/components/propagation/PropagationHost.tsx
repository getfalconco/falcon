import { useEffect, useState } from "react";
import RipplePanel from "./RipplePanel";

/**
 * Global Shift+P toggle for the Propagation ripple view (spec §8). Mounted
 * once at the root, reachable from any screen and ONLY by this shortcut —
 * same wiring as Shift+T / Shift+B / Shift+A, a different visual grade: this
 * is the first surface where Falcon's thesis is visible, so it is finished as
 * product, not as an instrument panel. Esc or Shift+P closes it.
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // `code` keeps this on the physical P across keyboard layouts; the `key`
      // fallback covers events that carry no code (synthetic/remote input).
      const isP = event.code === "KeyP" || event.key.toLowerCase() === "p";
      if (!isP) return;

      // Never steal the shortcut from a field the user is typing into.
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      event.preventDefault();
      setFocus(null);
      setOpen((v) => !v);
    };

    // Anything in the app can ask for the panel without knowing the shortcut
    // (the Opportunities card's button does).
    const onOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent<PropagationFocus | undefined>).detail;
      setFocus(detail?.runId ? detail : null);
      setOpen(true);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(PROPAGATION_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(PROPAGATION_OPEN_EVENT, onOpenRequest);
    };
  }, []);

  if (!open) return null;
  return <RipplePanel focus={focus} onClose={() => setOpen(false)} />;
}
