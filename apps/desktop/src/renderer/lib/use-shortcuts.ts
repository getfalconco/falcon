import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getBindings,
  isTypingTarget,
  matchesCombo,
  subscribeBindings,
  yieldsToTyping,
  type ShortcutId,
} from "./shortcuts";

/**
 * The React side of `shortcuts.ts`: listen for a shortcut by its id, and read
 * a shortcut's current keys so a hint on screen follows a rebinding.
 */

/**
 * Calls `handler` when the shortcut's current keys are pressed anywhere in
 * the window. The keys are read at the press, so a rebinding in Settings
 * takes effect at once. A binding that would type a character (Shift+T)
 * stands down while a field has focus; Ctrl/⌘ and Alt bindings do not.
 */
export function useShortcut(id: ShortcutId, handler: (event: KeyboardEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keys = getBindings()[id];
      if (!matchesCombo(keys, event)) return;
      if (yieldsToTyping(keys) && isTypingTarget(event.target)) return;
      event.preventDefault();
      ref.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [id]);
}

/** Every shortcut's current keys, re-rendering when any changes. */
export function useBindings(): Readonly<Record<ShortcutId, string>> {
  return useSyncExternalStore(subscribeBindings, getBindings, getBindings);
}

/** One shortcut's current keys ("Mod+K"), re-rendering when they change. */
export function useBinding(id: ShortcutId): string {
  return useBindings()[id];
}
