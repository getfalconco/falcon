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
};

export function dashboardCtasEnabled(): boolean {
  return DASHBOARD_CONFIG.dashboardCtasEnabled;
}
