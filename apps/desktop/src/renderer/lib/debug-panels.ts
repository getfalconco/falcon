import { getBinding, parseCombo, type ShortcutId } from "./shortcuts";

/**
 * Open one of the instrument panels (Tracker, Base, Diagnostics…) from a
 * button, through the same door as its keyboard shortcut.
 *
 * Each panel's host owns its open state and listens for its shortcut on the
 * window; none of them takes an "open" call. Rather than give every host a
 * second entry point, this presses the shortcut for it: the binding is read
 * at the moment of the click, so a key moved in Settings → Shortcuts still
 * opens the right panel. The event is dispatched on the window itself, so no
 * host mistakes it for typing in a field.
 *
 * The panels sit above the settings panel (z-200 over z-90), so they open in
 * front of it; Esc then closes both, as it would any stack of dialogs here.
 */
export function pressShortcut(id: ShortcutId): boolean {
  if (typeof window === "undefined" || typeof KeyboardEvent === "undefined") return false;
  const combo = parseCombo(getBinding(id));
  if (!combo) return false;
  const code = /^[A-Z]$/.test(combo.key)
    ? `Key${combo.key}`
    : /^[0-9]$/.test(combo.key)
      ? `Digit${combo.key}`
      : "";
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: combo.key.length === 1 ? combo.key.toLowerCase() : combo.key,
      code,
      shiftKey: combo.shift,
      altKey: combo.alt,
      ctrlKey: combo.mod,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
