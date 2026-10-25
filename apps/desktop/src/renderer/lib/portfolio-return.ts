/**
 * The Portfolio return card's arithmetic and colour, kept pure so node tests
 * can run it: no React, no storage, no network.
 *
 * Return over a window is Modified Dietz: the gain less any money moved in
 * or out, over the starting value plus each flow weighted by how long it was
 * in the book. With no flows that is the plain change, end over start less
 * one. The paper account never moves money once it is opened (a reset wipes
 * its history), so its figure is a true return. A linked brokerage can take
 * deposits the app cannot see; there the card says "change" instead.
 */

import { isEtfTicker } from "./etf-tickers";

export const RETURN_PERIODS = ["1M", "3M", "YTD", "1Y", "3Y", "All"] as const;
export type ReturnPeriod = (typeof RETURN_PERIODS)[number];

export function isReturnPeriod(value: unknown): value is ReturnPeriod {
  return typeof value === "string" && (RETURN_PERIODS as readonly string[]).includes(value);
}

/** Calendar arithmetic in local time, so "3 months ago" lands on the same day of the month. */
function monthsBack(now: number, months: number): number {
  const d = new Date(now);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

/**
 * Where a window opens. "All" opens at the first recorded value; every other
 * window is calendar based and may open before the account existed, which
 * `valueAt` resolves to the first record.
 */
export function periodStart(period: ReturnPeriod, now: number, firstAt: number | null): number {
  switch (period) {
    case "1M":
      return monthsBack(now, 1);
    case "3M":
      return monthsBack(now, 3);
    case "YTD":
      return new Date(new Date(now).getFullYear(), 0, 1).getTime();
    case "1Y":
      return monthsBack(now, 12);
    case "3Y":
      return monthsBack(now, 36);
    case "All":
      return firstAt ?? now;
  }
}

/**
 * The window a reader meets first: three years when the record is that long,
 * otherwise all of it, which is then the longest there is.
 */
export function defaultPeriod(firstAt: number | null, now: number): ReturnPeriod {
  if (firstAt != null && firstAt <= monthsBack(now, 36)) return "3Y";
  return "All";
}

export type ValuePoint = { t: number; value: number };

/**
 * The book's value at `t`: the last record at or before it, or, when the
 * record starts later, the first one after. `null` with no records at all.
 */
export function valueAt(points: readonly ValuePoint[], t: number): ValuePoint | null {
  let before: ValuePoint | null = null;
  let after: ValuePoint | null = null;
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.value)) continue;
    if (p.t <= t) {
      if (!before || p.t > before.t) before = p;
    } else if (!after || p.t < after.t) {
      after = p;
    }
  }
  return before ?? after;
}

/** Money moved into (positive) or out of (negative) the book at `t`. */
export type CashFlow = { t: number; amount: number };

export type PeriodReturn = {
  /** Dollars made: the end value less the start value less net flows. */
  gain: number;
  /** As a fraction, 0.1 is ten percent. `null` when the base is not positive. */
  ratio: number | null;
};

/**
 * Modified Dietz over [startAt, endAt]. Flows outside the window are ignored.
 * With no flows this is exactly (end - start) / start.
 */
export function periodReturn(input: {
  startValue: number;
  endValue: number;
  startAt: number;
  endAt: number;
  flows?: readonly CashFlow[];
}): PeriodReturn {
  const { startValue, endValue, startAt, endAt } = input;
  const span = Math.max(0, endAt - startAt);
  let net = 0;
  let weighted = 0;
  for (const f of input.flows ?? []) {
    if (!Number.isFinite(f.amount) || f.t < startAt || f.t > endAt) continue;
    net += f.amount;
    weighted += span > 0 ? f.amount * ((endAt - f.t) / span) : 0;
  }
  const gain = endValue - startValue - net;
  const base = startValue + weighted;
  return { gain, ratio: base > 1e-9 ? gain / base : null };
}

// ---------------------------------------------------------------------------
// What the book holds, for the scope line.

export type HeldClass = "stocks" | "funds" | "crypto" | "cash" | "brokerage";

const CRYPTO = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "DOT", "LINK", "LTC",
  "BCH", "MATIC", "POL", "SHIB", "TRX", "XLM", "ATOM", "UNI", "TON", "SUI",
]);

/** `BTC`, `BTC-USD`, `X:BTCUSD`, `BTCUSD`. */
export function isCryptoSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase().trim();
  if (s.startsWith("X:")) return true;
  const bare = s.replace(/-USDT?$|USDT?$/, "");
  return CRYPTO.has(s) || (bare !== s && CRYPTO.has(bare));
}

/**
 * The classes the book holds, in a fixed order. Cash is named only when it is
 * a real share of the book (5% or more); a sliver left over from trading is
 * not what the reader thinks of as holding cash.
 */
export function heldClasses(input: {
  cash: number;
  positions: ReadonlyArray<{ symbol: string; value: number }>;
  brokerage: boolean;
}): HeldClass[] {
  const out = new Set<HeldClass>();
  let invested = 0;
  for (const p of input.positions) {
    invested += Math.abs(p.value);
    if (isCryptoSymbol(p.symbol)) out.add("crypto");
    else if (isEtfTicker(p.symbol)) out.add("funds");
    else out.add("stocks");
  }
  const total = invested + Math.max(0, input.cash);
  if (input.cash > 0 && (invested === 0 || input.cash / total >= 0.05)) out.add("cash");
  if (input.brokerage) out.add("brokerage");
  const order: HeldClass[] = ["stocks", "funds", "crypto", "cash", "brokerage"];
  return order.filter((c) => out.has(c));
}

/** "stocks + crypto" with the first letter raised in the reader's language. */
export function joinClasses(words: readonly string[], locale: string): string {
  const line = words.join(" + ");
  return line.slice(0, 1).toLocaleUpperCase(locale) + line.slice(1);
}

// ---------------------------------------------------------------------------
// Numbers.

/** "+$28K" / "-$1.2M" / "+28 B $": compact, signed, in the reader's locale. */
export function compactSignedUsd(value: number, locale: string): string {
  const abs = Math.abs(value);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: abs < 1000 ? 0 : abs < 10_000 ? 1 : abs < 1_000_000 ? 0 : 1,
    signDisplay: "exceptZero",
  }).format(value);
}

/** "142.4%" / "%142,4": unsigned, the arrow carries the direction. */
export function returnPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(ratio));
}

/** Up, down, or flat once rounded to the one decimal the card prints. */
export function returnDirection(ratio: number): "up" | "down" | "flat" {
  const tenths = Math.round(ratio * 1000);
  return tenths > 0 ? "up" : tenths < 0 ? "down" : "flat";
}

// ---------------------------------------------------------------------------
// Colour. The card is lit from outside: a bright glow comes in over every
// edge, strongest at the top-left and bottom-right corners, and a soft dark
// oval sits in the middle behind the figure. That structure is the same for
// every return; only the hue moves, along these stops, interpolated in OKLab
// so a blend between two hues does not go muddy in the middle.
//
// Each stop is the glow, the edge (the card's own colour under the glow), and
// the core (the dark oval).

type Rgb = [number, number, number];
type Stop = { at: number; glow: Rgb; edge: Rgb; core: Rgb };

function hex(h: string): Rgb {
  const n = Number.parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Gains to the right, losses to the left; the ends hold beyond ±50%. The
 *  anchors are Apple's systemRed, systemOrange, systemGray and systemGreen,
 *  each taken down to an edge and a core of the same hue. */
export const RETURN_STOPS: readonly Stop[] = [
  { at: -0.5, glow: hex("#D44740"), edge: hex("#732623"), core: hex("#250C0B") },
  { at: -0.2, glow: hex("#D46431"), edge: hex("#73361A"), core: hex("#251108") },
  { at: -0.06, glow: hex("#D4871D"), edge: hex("#734A10"), core: hex("#251805") },
  { at: 0, glow: hex("#838387"), edge: hex("#47474A"), core: hex("#171718") },
  { at: 0.06, glow: hex("#669575"), edge: hex("#385140"), core: hex("#121A14") },
  { at: 0.2, glow: hex("#50A267"), edge: hex("#2C5838"), core: hex("#0E1C12") },
  { at: 0.5, glow: hex("#42AB5E"), edge: hex("#245D33"), core: hex("#0C1E10") },
];

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

function rgbToOklab([r8, g8, b8]: Rgb): [number, number, number] {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, A, B]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function mixLab(a: Rgb, b: Rgb, k: number, lightness = 1): Rgb {
  const x = rgbToOklab(a);
  const y = rgbToOklab(b);
  return oklabToRgb([
    (x[0] + (y[0] - x[0]) * k) * lightness,
    x[1] + (y[1] - x[1]) * k,
    x[2] + (y[2] - x[2]) * k,
  ]);
}

/** sRGB mix, for laying a translucent colour over another as the browser does. */
function over(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i]! * alpha + bottom[i]! * (1 - alpha))) as Rgb;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;
const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;

/**
 * What the small text near the edges sits on: the edge with about half the
 * glow over it (the glow's centres are outside the card, so the masthead and
 * the scope line never sit at full strength).
 */
export const EDGE_TEXT_GLOW = 0.5;
/** What the figure sits on: the edge with most of the oval over it. */
export const CORE_TEXT_ALPHA = 0.75;
/** How strong the small text is against the figure's near-white. */
export const MUTED_ALPHA = 0.86;

const LIGHT_TEXT: Rgb = [250, 251, 244];

export type ReturnTone = {
  glow: Rgb;
  edge: Rgb;
  core: Rgb;
  /** What the masthead and the scope line sit on. */
  edgeSurface: Rgb;
  /** What the figure sits on. */
  coreSurface: Rgb;
  text: Rgb;
  muted: Rgb;
  /** Ready-made CSS: the layered background, and the inner rim of light. */
  background: string;
  rim: string;
  textCss: string;
  mutedCss: string;
};

/**
 * The card's colours for a return. Continuous: every tenth of a percent
 * moves it. Dark theme takes the same hues a little deeper so the card does
 * not glare against a dark page. Text is near-white on every hue.
 */
export function returnTone(ratio: number | null, theme: "light" | "dark" = "light"): ReturnTone {
  const stops = RETURN_STOPS;
  const r = ratio == null || !Number.isFinite(ratio) ? 0 : Math.min(stops[stops.length - 1]!.at, Math.max(stops[0]!.at, ratio));
  let i = 0;
  while (i < stops.length - 2 && r > stops[i + 1]!.at) i++;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const k = b.at === a.at ? 0 : (r - a.at) / (b.at - a.at);
  const dark = theme === "dark";
  const glow = mixLab(a.glow, b.glow, k, dark ? 0.9 : 1);
  const edge = mixLab(a.edge, b.edge, k, dark ? 0.86 : 1);
  const core = mixLab(a.core, b.core, k, dark ? 0.8 : 1);
  const edgeSurface = over(glow, edge, EDGE_TEXT_GLOW);
  const coreSurface = over(core, edge, CORE_TEXT_ALPHA);
  const text = LIGHT_TEXT;
  const muted = over(text, edgeSurface, MUTED_ALPHA);
  const background = [
    // The dark oval, a large soft ellipse behind the figure.
    `radial-gradient(ellipse 68% 56% at 54% 58%, ${rgba(core, 0.9)} 0%, ${rgba(core, 0.68)} 38%, ${rgba(core, 0.28)} 72%, ${rgba(core, 0)} 100%)`,
    // Light coming in from outside: strongest over the top-left and bottom-right corners.
    `radial-gradient(ellipse 70% 80% at -6% -10%, ${rgba(glow, 1)} 0%, ${rgba(glow, 0.6)} 38%, ${rgba(glow, 0)} 72%)`,
    `radial-gradient(ellipse 70% 80% at 106% 110%, ${rgba(glow, 1)} 0%, ${rgba(glow, 0.6)} 38%, ${rgba(glow, 0)} 72%)`,
    `radial-gradient(ellipse 55% 65% at 104% -8%, ${rgba(glow, 0.7)} 0%, ${rgba(glow, 0)} 70%)`,
    `radial-gradient(ellipse 55% 65% at -4% 108%, ${rgba(glow, 0.7)} 0%, ${rgba(glow, 0)} 70%)`,
    css(edge),
  ].join(", ");
  const rim = `inset 0 0 28px ${rgba(glow, 0.55)}, inset 0 1px 0 ${rgba(glow, 0.6)}`;
  return { glow, edge, core, edgeSurface, coreSurface, text, muted, background, rim, textCss: css(text), mutedCss: css(muted) };
}
