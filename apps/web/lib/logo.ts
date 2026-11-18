/**
 * Company, fund and coin logos for the Portfolio Overview card and Settings >
 * Portfolio, always through Falcon's own route (/api/logo/[symbol]) so the
 * browser never hands a member's tickers or IP address to a third party.
 *
 * Two styles, each with its sources tried in order by the server:
 *   color (default)
 *     stocks, ETFs  Financial Modeling Prep's public logo images
 *                   (financialmodelingprep.com/image-stock/<TICKER>.png): brand colours on
 *                   transparent backgrounds for most US listings, fund issuers' logos for ETFs
 *                   (SPDR, Invesco, iShares, Vanguard, Schwab). Free, no key; covered by FMP's
 *                   Terms of Service, no separate licence; the logos are their owners' trademarks.
 *     crypto        spothq cryptocurrency-icons (CC0-1.0, 128/color/<symbol>.png), then FMP (<SYMBOL>USD).
 *   mono (?style=mono): the fallback when no colour logo exists or it has a background
 *     stocks, ETFs  NVSTly icons (github.com/nvstly/icons, ticker_icons/<TICKER>.png): mostly white
 *                   marks on transparent backgrounds, drawn as silhouettes. The repo states no licence.
 *     crypto        NVSTly icons (crypto_icons/<SYMBOL>.png).
 * Review both before public launch. A miss is a 404 and the UI falls back
 * (colour, then mono, then letters: PositionLogo.tsx). Pure; safe on both sides.
 */

export type LogoStyle = "color" | "mono";

const STOCK = /^[A-Z][A-Z0-9.-]{0,9}$/;
const COIN = /^[A-Z0-9]{1,12}$/;

/** The symbol a logo is looked up by (crypto without its "-USD"), or null when it is not a plain symbol. */
export function logoSymbol(raw: string, crypto: boolean): string | null {
  const s = decodeURIComponent(raw).trim().toUpperCase();
  if (crypto) {
    const base = s.split("-")[0] ?? "";
    return COIN.test(base) ? base : null;
  }
  return STOCK.test(s) ? s : null;
}

/** Where the server looks, in order. */
export function logoSources(symbol: string, crypto: boolean, style: LogoStyle = "color"): string[] {
  const nv = "https://raw.githubusercontent.com/nvstly/icons/main";
  const fmp = "https://financialmodelingprep.com/image-stock";
  const dashed = symbol.includes(".") ? [symbol.replace(".", "-")] : [];
  if (crypto) {
    return style === "color"
      ? [`https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol.toLowerCase()}.png`, `${fmp}/${symbol}USD.png`]
      : [`${nv}/crypto_icons/${symbol}.png`];
  }
  return style === "color" ? [symbol, ...dashed].map((s) => `${fmp}/${s}.png`) : [symbol, ...dashed].map((s) => `${nv}/ticker_icons/${s}.png`);
}

/** The app's own URL for a row's logo: options use their underlying, crypto its coin; null for others. */
export function logoUrl(row: { kind: string; ticker: string | null; symbol: string }, style: LogoStyle = "color"): string | null {
  // The style is always named, so a browser never reuses an image cached before colour logos (the bare URL was mono).
  if (row.kind === "crypto") {
    const base = logoSymbol(row.symbol, true);
    return base ? `/api/logo/${encodeURIComponent(base)}?kind=crypto&style=${style}` : null;
  }
  const t = row.ticker ? logoSymbol(row.ticker, false) : null;
  return t ? `/api/logo/${encodeURIComponent(t)}?style=${style}` : null;
}

export type LogoLook = {
  /** The image sits on its own opaque box (three or four corners opaque and alike): not a free-standing mark. */
  background: boolean;
  /** Very dark marks (near black): lifted with a faint glow in the dark theme. */
  dark: boolean;
  /** Very light marks (near white): drawn as a silhouette in the light theme, where they would vanish. */
  light: boolean;
};

/** Pure: how a decoded logo (RGBA, row by row) looks: whether it has a background, and whether it is very dark or very light. */
export function logoLook(rgba: ArrayLike<number>, width: number, height: number): LogoLook {
  const px = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!] as const;
  };
  const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)].filter((c) => c[3] > 200);
  const alike = corners.every((c) => Math.abs(c[0] - corners[0]![0]) + Math.abs(c[1] - corners[0]![1]) + Math.abs(c[2] - corners[0]![2]) < 48);
  const background = corners.length >= 3 && alike;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    sum += (0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!) / 255;
    n++;
  }
  const lum = n ? sum / n : 0.5;
  return { background, dark: n > 0 && lum < 0.16, light: n > 0 && lum > 0.88 };
}
