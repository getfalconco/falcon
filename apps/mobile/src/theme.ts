import { Platform, type TextStyle } from "react-native";
import { Easing } from "react-native-reanimated";

/** The website's light auth/funnel palette (apps/web login and /welcome). */
export const colors = {
  splash: "#ffffff",
  background: "#fdfdfd",
  ink: "#1d1b1b",
  body: "#4b4b48",
  muted: "#767676",
  faint: "#8a8a8a",
  placeholder: "#9a9a9a",
  hairline: "rgba(0, 0, 0, 0.10)",
  divider: "rgba(0, 0, 0, 0.06)",
  optionBorder: "rgba(0, 0, 0, 0.12)",
  optionBorderOn: "rgba(0, 0, 0, 0.70)",
  optionFillOn: "rgba(0, 0, 0, 0.035)",
  optionFillConfirm: "rgba(0, 0, 0, 0.07)",
  inputFocus: "rgba(0, 0, 0, 0.30)",
  primary: "#1c1917",
  primaryText: "rgb(231, 231, 231)",
  error: "#dc2626",
};

/** Font families registered in app/_layout.tsx (the site's own fonts). */
export const fonts = {
  /** Login headline: the site's `font-serif` (Playfair Display). */
  display: "PlayfairDisplay",
  /** Funnel headlines: Libre Baskerville, as on /welcome. */
  serif: "LibreBaskerville",
  /** The login form's body text: the site's default `font-sans` (Inter). */
  inter: "Inter",
  sans: "Geist",
  sansMedium: "GeistMedium",
  mono: "GeistMono",
};

/** The site's calm ease (cubic-bezier(0.22, 1, 0.36, 1)), no overshoot. */
export const EASE_CALM = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_SOFT = Easing.bezier(0.4, 0, 0.2, 1);

/** Outer page padding on the phone. */
export const GUTTER = 24;

/** Web preview only: inputs show focus with their border, not the browser ring. */
export const NO_FOCUS_RING = (Platform.OS === "web" ? { outlineStyle: "none" } : {}) as unknown as TextStyle;
