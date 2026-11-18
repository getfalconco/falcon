import localFont from "next/font/local";

/**
 * The site's web fonts, self-hosted from the @fontsource packages instead of
 * next/font/google. Same families and weights as before; the build no longer
 * has to reach Google Fonts (which is unreachable from some networks), and
 * visitors' browsers never call Google either.
 *
 * Import this module from app/layout.tsx only. The root layout puts every
 * font's `.variable` class on <html>, so nested layouts and pages already
 * inherit the CSS variables. If a nested layout imports it too, Next 14 on
 * Windows can assign the @font-face CSS to that nested layout instead of the
 * root one (its CSS dedupe sorts by "/" depth, and Windows paths use "\"),
 * and app/layout.css then ships without these fonts.
 */

export const inter = localFont({
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
});

export const playfair = localFont({
  src: "../node_modules/@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2",
  weight: "400 900",
  style: "normal",
  variable: "--font-serif",
  display: "swap",
});

export const libreBaskerville = localFont({
  src: [
    { path: "../node_modules/@fontsource/libre-baskerville/files/libre-baskerville-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/libre-baskerville/files/libre-baskerville-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-libre-baskerville",
  display: "swap",
});
