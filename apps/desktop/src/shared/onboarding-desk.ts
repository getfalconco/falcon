/**
 * Which answer turns on which part of the desk.
 *
 * Onboarding asks how long the reader usually holds, and that answer picks
 * the dashboard cards the desk opens with. The spec names the parts of a desk
 * in its own words (Positions, Tape, Earnings, Calendar, Risk, Earnings track
 * record); the dashboard has cards with ids of its own. Both live here, with
 * the map between them, so the flow, the dashboard and the tests read one
 * table.
 *
 * Pure on purpose: no React, no storage, no window. The renderer writes the
 * result through lib/card-order.ts, the same store Add Module and the canvas
 * use, so the dashboard opens exactly as the reader left the desk screen.
 */

/** Every dashboard card kind, in the order a fresh dashboard lays them out. HomePage reads this list. */
export const DASHBOARD_CARD_ORDER = ["portfolio", "assets", "calendar", "news", "insight", "risk", "agents", "earnings", "exposure", "readthrough", "insiders", "filings"] as const;
export type DashboardCard = (typeof DASHBOARD_CARD_ORDER)[number];

export function isDashboardCard(value: unknown): value is DashboardCard {
  return typeof value === "string" && (DASHBOARD_CARD_ORDER as readonly string[]).includes(value);
}

/** "How long do you usually hold?" Stored as these ids. */
export const HOLDING_PERIODS = ["days", "weeks_months", "years"] as const;
export type HoldingPeriod = (typeof HOLDING_PERIODS)[number];

export function isHoldingPeriod(value: unknown): value is HoldingPeriod {
  return typeof value === "string" && (HOLDING_PERIODS as readonly string[]).includes(value);
}

/** How the reader answered "What do you hold?". Stored as these ids. */
export const POSITIONS_MODES = ["brokerage", "tickers", "watch", "none"] as const;
export type PositionsMode = (typeof POSITIONS_MODES)[number];

export function isPositionsMode(value: unknown): value is PositionsMode {
  return typeof value === "string" && (POSITIONS_MODES as readonly string[]).includes(value);
}

/** The parts of a desk, as the spec names them. */
export const DESK_MODULES = [
  "positions",
  "tape",
  "earnings_upcoming",
  "calendar",
  "earnings",
  "risk",
  "earnings_track_record",
] as const;
export type DeskModule = (typeof DESK_MODULES)[number];

/**
 * The cards each part is drawn by.
 *
 * - Positions: the Net Worth card and the Positions list.
 * - Tape: the News card (id "news"), the feed of stories on the reader's names.
 * - Earnings, upcoming or not: the Earnings card, the next reports of held
 *   and watched names with a countdown to each.
 * - Risk: the Risk Score card.
 * - Earnings track record: no card shows a name's record of past reports.
 *   The closest is Agents, whose earnings agents write up how each report
 *   came in against the guide.
 */
export const MODULE_CARDS: Readonly<Record<DeskModule, readonly DashboardCard[]>> = {
  positions: ["portfolio", "assets"],
  tape: ["news"],
  earnings_upcoming: ["earnings"],
  calendar: ["calendar"],
  earnings: ["earnings"],
  risk: ["risk"],
  earnings_track_record: ["agents"],
};

/** The default desk for each holding period, in the spec's words. */
export const DESK_BY_HOLDING: Readonly<Record<HoldingPeriod, readonly DeskModule[]>> = {
  days: ["positions", "tape", "earnings_upcoming", "calendar"],
  weeks_months: ["positions", "tape", "earnings", "risk"],
  years: ["positions", "earnings_track_record", "risk"],
};

/** Puts cards in the dashboard's own order and drops repeats and unknown ids. */
export function inCardOrder(cards: Iterable<string>): DashboardCard[] {
  const wanted = new Set(cards);
  return DASHBOARD_CARD_ORDER.filter((card) => wanted.has(card));
}

/** The cards a holding period turns on, in the dashboard's order. */
export function defaultDeskCards(holding: HoldingPeriod): DashboardCard[] {
  return inCardOrder(DESK_BY_HOLDING[holding].flatMap((module) => MODULE_CARDS[module]));
}

/**
 * The saved card order for a chosen desk: the chosen cards in the dashboard's
 * order. A card the build hides (dashboard-config `hiddenCards`) keeps its
 * place, as it does in a fresh dashboard: it is not drawn either way, and if
 * a later build brings it back it returns as it would for anyone else.
 */
export function deskCardOrder(chosen: Iterable<string>, hidden: readonly string[] = []): DashboardCard[] {
  const wanted = new Set(chosen);
  return DASHBOARD_CARD_ORDER.filter((card) => wanted.has(card) || hidden.includes(card));
}

/** The desk read back from storage: known card ids only, in order. */
export function parseDeskCards(raw: unknown): DashboardCard[] {
  return Array.isArray(raw) ? inCardOrder(raw.filter((v): v is string => typeof v === "string")) : [];
}
