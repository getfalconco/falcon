/** Closes the sheet, then runs `then` (a navigation that follows it). */
export type CloseSheet = (then?: () => void) => void;

/** Room for the grabber at the top of the sheet. */
export const GRABBER_SPACE = 22;
