/**
 * Desktop-side mirror of the gloss contract (`@meridian/research/gloss`), so
 * the renderer never imports the Node-only research package.
 */

export type GlossKind = "term" | "passage";

export type Gloss = {
  kind: GlossKind;
  /** The selection, tidied — the card's heading. */
  term: string;
  /** The financial meaning, or what the passage is claiming. */
  english: string;
  /** What it means in this particular sentence; empty for a passage. */
  in_context: string;
  /** True when the everyday meaning differs from the market one. */
  finance_specific: boolean;
};
