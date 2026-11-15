import { withoutOptions, type RippleCard } from "@falcon/ripple";

/**
 * Who may see the options block on Sightings cards (RippleCard.options,
 * RippleHit.options): numbers derived from OPRA data via Databento.
 * Shown to all users from 2026-11-15 by founder decision. Display licensing
 * (OPRA fees, Databento redistribution terms) must be resolved before public
 * launch. Set OPTIONS_DISPLAY=admin or off in Netlify to restrict.
 *
 *   OPTIONS_DISPLAY=all    (default) everyone
 *   OPTIONS_DISPLAY=admin  founder admin session only
 *   OPTIONS_DISPLAY=off    nobody
 *
 * Server-side only: /api/sightings strips the blocks for anyone the mode
 * does not allow.
 */
export type OptionsDisplay = "admin" | "all" | "off";

export function optionsDisplayMode(value: string | undefined = process.env.OPTIONS_DISPLAY): OptionsDisplay {
  const v = (value ?? "").trim().toLowerCase();
  return v === "admin" || v === "off" ? v : "all";
}

/** Whether this viewer gets the options blocks. Pure. */
export function canSeeOptions(mode: OptionsDisplay, isAdmin: boolean): boolean {
  return mode === "all" || (mode === "admin" && isAdmin);
}

/** A feed-like payload with every card list stripped of options blocks (cards, portfolio, opportunities). Pure. */
export function stripOptions<T extends { cards: RippleCard[]; portfolio?: RippleCard[]; opportunities?: RippleCard[] }>(payload: T): T {
  const out: T = { ...payload, cards: payload.cards.map(withoutOptions) };
  if (payload.portfolio) out.portfolio = payload.portfolio.map(withoutOptions);
  if (payload.opportunities) out.opportunities = payload.opportunities.map(withoutOptions);
  return out;
}

/** The payload as this viewer may see it. Pure. */
export function optionsForViewer<T extends { cards: RippleCard[]; portfolio?: RippleCard[]; opportunities?: RippleCard[] }>(
  payload: T,
  mode: OptionsDisplay,
  isAdmin: boolean,
): T {
  return canSeeOptions(mode, isAdmin) ? payload : stripOptions(payload);
}
