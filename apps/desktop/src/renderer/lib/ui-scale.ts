/**
 * Interface size: how large the whole app draws. Settings, Appearance.
 *
 * The app sets its type and spacing in pixel literals throughout, so a root
 * font size would move almost nothing. Instead this is Chromium's own page
 * zoom, set through Electron's `webFrame` in the preload: every CSS pixel
 * scales together, pointer coordinates included, so the dashboard's drag and
 * resize arithmetic is untouched. The window itself keeps its size, so a
 * larger interface shows less at once.
 *
 * Chromium does not keep the factor across launches reliably, so it is kept
 * here and put back on every start (main.tsx).
 */
export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type UiScale = (typeof UI_SCALES)[number];

const KEY = "falcon.ui.scale";

export function readUiScale(): UiScale {
  try {
    const raw = Number(localStorage.getItem(KEY));
    const match = UI_SCALES.find((s) => s === raw);
    if (match !== undefined) return match;
  } catch {
    /* storage is not always there */
  }
  return 1;
}

/** Whether this window can be zoomed at all: the desktop bridge is present. */
export function canScaleUi(): boolean {
  return typeof window !== "undefined" && typeof window.meridian?.setZoomFactor === "function";
}

export function applyUiScale(scale: UiScale = readUiScale()): void {
  try {
    window.meridian?.setZoomFactor?.(scale);
  } catch {
    /* outside the desktop app there is nothing to zoom */
  }
}

export function writeUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(KEY, String(scale));
  } catch {
    /* applied for this run even if it cannot be kept */
  }
  applyUiScale(scale);
}
