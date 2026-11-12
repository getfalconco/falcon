/**
 * Sheet heights as a fraction of the screen: the iOS form sheet detents
 * (sheetAllowedDetents in app/_layout.tsx) and the web preview's sheet.
 */
export const SHEET_DETENTS = {
  signIn: [0.4],
  language: [0.6, 1.0],
  addTicker: [0.92],
} as const;

/** iOS form sheet corner radius, also drawn by the web preview's sheet. */
export const SHEET_CORNER_RADIUS = 24;
