import {
  formatColor,
  formatHslChannels,
  formatRgbChannels,
  isHslChannels,
  isRgbChannels,
  parseColor,
  type Rgba,
} from "./color";
import { isSafeValue } from "./overrides";
import type { TokenKind } from "./tokens";

/**
 * What one row of the theme editor writes back for its token, from the text
 * field, the colour picker or the opacity slider. Pure; the browser's own
 * `CSS.supports` is passed in, so a test can stand in for it.
 */

export type Supports = (property: string, value: string) => boolean;

export const cssSupports: Supports = (property, value) => {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(property, value);
  } catch {
    return false;
  }
};

/**
 * The value to keep for what was typed into a row, or null when it is not
 * one. A colour stays as typed (hex, rgb(), hsl()...); the channel tokens
 * also take any colour and turn it into their own `H S% L%` or `R G B` form,
 * since that is how their users read them.
 */
export function acceptTyped(kind: TokenKind, typed: string, supports: Supports = cssSupports): string | null {
  const text = typed.trim().replace(/\s+/g, " ");
  if (!text || !isSafeValue(text)) return null;
  switch (kind) {
    case "color":
    case "derived":
      return parseColor(text) || supports("color", text) ? text : null;
    case "hsl-channels": {
      if (isHslChannels(text)) return text;
      const c = parseColor(text);
      return c ? formatHslChannels(c) : null;
    }
    case "rgb-channels": {
      if (isRgbChannels(text)) return text;
      const c = parseColor(text);
      return c ? formatRgbChannels(c) : null;
    }
    case "shadow":
      return supports("box-shadow", text) ? text : null;
  }
}

/** The value a picked colour (and the row's alpha) comes to, in the token's own form. */
export function fromPicked(kind: TokenKind, color: Rgba): string | null {
  switch (kind) {
    case "color":
    case "derived":
      return formatColor(color);
    case "hsl-channels":
      return formatHslChannels(color);
    case "rgb-channels":
      return formatRgbChannels(color);
    case "shadow":
      return null;
  }
}

/** How the page reads the token as a colour, for getComputedStyle; null for a shadow. */
export function colorExpression(name: string, kind: TokenKind): string | null {
  switch (kind) {
    case "color":
    case "derived":
      return `var(${name})`;
    case "hsl-channels":
      return `hsl(var(${name}))`;
    case "rgb-channels":
      return `rgb(var(${name}))`;
    case "shadow":
      return null;
  }
}
