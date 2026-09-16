// Shared motion tokens, kept in one place so every surface animates identically.
export const EASE = [0.21, 0.47, 0.32, 0.98] as const;
export const EASE_CSS = "cubic-bezier(0.21, 0.47, 0.32, 0.98)";

/**
 * Early-access ticket interaction. Hover grow + grid→stage flight must match
 * on web, desktop, and mobile so the card feels like the same object.
 *
 * Grid ticket is 400px; the focus stage preview is 460px → 1.15×.
 * Hover is a 1.05× inner-layer scale (TierTickets / WaitlistTicket CSS).
 */
export const TICKET_HOVER_SCALE = 1.05;
export const TICKET_HOVER_MS = 300;
export const TICKET_HOVER_EASE = [0.22, 1, 0.36, 1] as const;
export const TICKET_HOVER_EASE_CSS = "cubic-bezier(0.22, 1, 0.36, 1)";

export const TICKET_GRID_WIDTH = 400;
export const TICKET_STAGE_WIDTH = 460;
export const TICKET_STAGE_SCALE = TICKET_STAGE_WIDTH / TICKET_GRID_WIDTH;
export const TICKET_FLIGHT_MS = 450;
export const TICKET_EASE_SOFT = [0.4, 0, 0.2, 1] as const;
export const TICKET_TILT_SCALE = 1.02;
