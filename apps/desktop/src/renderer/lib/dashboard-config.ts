/**
 * Dashboard-level switches. One place, so turning a surface off is a decision
 * rather than a sweep through the cards.
 */

export const DASHBOARD_CONFIG = {
  /**
   * The card CTAs that open a detail view — Insight's "View Details" and its
   * step arrow, the band card's "View Details", Assets' "See all". Off means
   * the buttons still draw, but dimmed and inert.
   *
   * This closes the doors from the dashboard only. Every view they lead to is
   * still reachable by its own shortcut (Shift+P, Shift+S, and the rest), and
   * account actions like "Connect an asset" are not CTAs in this sense — they
   * are unaffected.
   */
  dashboardCtasEnabled: false,

  /**
   * Cards the dashboard does not draw. Hidden, not deleted: the components,
   * their engines and their IPC stay wired, so bringing one back is this
   * line and nothing else.
   *
   * The saved card order is filtered through this on read rather than
   * rewritten, so a reader who had dragged the cards around keeps their
   * arrangement of whatever is left — and gets it back intact if a card
   * returns.
   */
  hiddenCards: ["insight", "risk"] as readonly string[],

  /**
   * The handover briefing: the panel a reader meets before the US open.
   *
   * Two switches because they fail differently. `enabled` off removes the
   * whole surface: no host, no Shift+M, no request to the main process.
   * `autoOpen` off keeps all of that and only stops the panel from laying
   * itself over the dashboard on arrival. A panel that opens uninvited is the
   * part most likely to be unwelcome, and turning that off must not cost the
   * reader the briefing itself.
   *
   * The calendar card draws the same report, so `enabled` off takes it off
   * the dashboard too: left on its own it would keep the requests going
   * that this switch exists to stop.
   */
  briefing: { enabled: true, autoOpen: true },
};

/** Is this card drawn on the dashboard at all? */
export function isCardHidden(id: string): boolean {
  return DASHBOARD_CONFIG.hiddenCards.includes(id);
}

export function dashboardCtasEnabled(): boolean {
  return DASHBOARD_CONFIG.dashboardCtasEnabled;
}

export function briefingEnabled(): boolean {
  return DASHBOARD_CONFIG.briefing.enabled;
}

/** Whether the briefing opens by itself before the open. Never true while the feature is off. */
export function briefingAutoOpen(): boolean {
  return DASHBOARD_CONFIG.briefing.enabled && DASHBOARD_CONFIG.briefing.autoOpen;
}
