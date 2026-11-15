import { withoutOptions, type RippleCard } from "@falcon/ripple";

/**
 * Who may see the options block on Sightings cards (RippleCard.options,
 * RippleHit.options): numbers derived from OPRA data via Databento.
 * Displaying OPRA-derived data to outside users may need exchange and vendor
 * display licensing (OPRA's vendor agreement, Databento's redistribution
 * terms). Until the founder confirms it, the default shows it to the founder
 * admin only.
 *
 *   OPTIONS_DISPLAY=admin  (default) founder admin session only
 *   OPTIONS_DISPLAY=all    everyone
 *   OPTIONS_DISPLAY=off    nobody
 *
 * Server-side only: /api/sightings strips the blocks for anyone else, so the
 * public API, the CDN and the iPhone app never carry them.
 */
export type OptionsDisplay = "admin" | "all" | "off";

export function optionsDisplayMode(value: string | undefined = process.env.OPTIONS_DISPLAY): OptionsDisplay {
  const v = (value ?? "").trim().toLowerCase();
  return v === "all" || v === "off" ? v : "admin";
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
