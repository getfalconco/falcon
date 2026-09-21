/**
 * The currencies a holding or a cash balance can be denominated in.
 *
 * One record per currency: the ISO 4217 code, the name a reader would say, the
 * symbol, and how the flag is drawn beside it.
 *
 * The flag is a spec rather than an image on two counts. Emoji is out because
 * Windows ships no glyphs for regional-indicator pairs — there, `🇹🇷` renders as
 * the letters "TR" in two boxes, and Windows is the platform this app runs on.
 * Bitmaps are out because every flag would be another asset to ship and to
 * scale. So the geometric ones are described here and drawn by `CurrencyFlag`.
 *
 * Flags whose emblem cannot survive a 20px circle — a maple leaf, a coat of
 * arms, Arabic script — carry no spec and render as the code on a neutral
 * badge instead. A legible "AED" beats an unrecognisable smudge that claims to
 * be a flag.
 */

/** How a flag is painted inside the badge circle. */
export type FlagSpec =
  /** Equal-width bands. `dir: "h"` stacks them, `"v"` sets them side by side. */
  | { kind: "bands"; dir: "h" | "v"; colors: string[] }
  /** Bands with explicit weights, for flags whose stripes are uneven. */
  | { kind: "bands"; dir: "h" | "v"; colors: string[]; weights: number[] }
  /** A Nordic cross: off-centre, extending to every edge. */
  | { kind: "nordic"; field: string; cross: string }
  /** A centred disc, as on Japan's. */
  | { kind: "disc"; field: string; disc: string; r: number }
  /** A centred equal cross, as on Switzerland's. */
  | { kind: "swiss"; field: string; cross: string }
  /** Named drawings that are geometric but not parametric. */
  | { kind: "custom"; id: "us" | "uk" | "tr" | "cn" | "eu" };

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  flag?: FlagSpec;
};

/**
 * Ordered so the ones a reader is most likely to hold come first; the picker
 * and any list render in this order rather than alphabetically, which would
 * bury USD under AED.
 */
export const CURRENCIES: readonly Currency[] = [
  { code: "USD", name: "US dollar", symbol: "$", flag: { kind: "custom", id: "us" } },
  { code: "EUR", name: "Euro", symbol: "€", flag: { kind: "custom", id: "eu" } },
  { code: "GBP", name: "Pound sterling", symbol: "£", flag: { kind: "custom", id: "uk" } },
  { code: "TRY", name: "Turkish lira", symbol: "₺", flag: { kind: "custom", id: "tr" } },
  { code: "JPY", name: "Japanese yen", symbol: "¥", flag: { kind: "disc", field: "#FFFFFF", disc: "#BC002D", r: 5.4 } },
  { code: "CHF", name: "Swiss franc", symbol: "CHF", flag: { kind: "swiss", field: "#D52B1E", cross: "#FFFFFF" } },
  { code: "CNY", name: "Chinese yuan", symbol: "¥", flag: { kind: "custom", id: "cn" } },

  // Europe
  { code: "SEK", name: "Swedish krona", symbol: "kr", flag: { kind: "nordic", field: "#006AA7", cross: "#FECC00" } },
  { code: "NOK", name: "Norwegian krone", symbol: "kr", flag: { kind: "nordic", field: "#BA0C2F", cross: "#FFFFFF" } },
  { code: "DKK", name: "Danish krone", symbol: "kr", flag: { kind: "nordic", field: "#C8102E", cross: "#FFFFFF" } },
  { code: "ISK", name: "Icelandic króna", symbol: "kr", flag: { kind: "nordic", field: "#02529C", cross: "#FFFFFF" } },
  { code: "PLN", name: "Polish złoty", symbol: "zł", flag: { kind: "bands", dir: "h", colors: ["#FFFFFF", "#DC143C"] } },
  { code: "CZK", name: "Czech koruna", symbol: "Kč" },
  { code: "HUF", name: "Hungarian forint", symbol: "Ft", flag: { kind: "bands", dir: "h", colors: ["#CE2939", "#FFFFFF", "#477050"] } },
  { code: "RON", name: "Romanian leu", symbol: "lei", flag: { kind: "bands", dir: "v", colors: ["#002B7F", "#FCD116", "#CE1126"] } },
  { code: "BGN", name: "Bulgarian lev", symbol: "лв", flag: { kind: "bands", dir: "h", colors: ["#FFFFFF", "#00966E", "#D62612"] } },
  { code: "RUB", name: "Russian ruble", symbol: "₽", flag: { kind: "bands", dir: "h", colors: ["#FFFFFF", "#0039A6", "#D52B1E"] } },
  { code: "UAH", name: "Ukrainian hryvnia", symbol: "₴", flag: { kind: "bands", dir: "h", colors: ["#0057B7", "#FFD700"] } },

  // Americas
  { code: "CAD", name: "Canadian dollar", symbol: "$" },
  { code: "MXN", name: "Mexican peso", symbol: "$" },
  { code: "BRL", name: "Brazilian real", symbol: "R$" },
  { code: "ARS", name: "Argentine peso", symbol: "$" },
  { code: "CLP", name: "Chilean peso", symbol: "$" },
  { code: "COP", name: "Colombian peso", symbol: "$", flag: { kind: "bands", dir: "h", colors: ["#FCD116", "#003893", "#CE1126"], weights: [2, 1, 1] } },
  { code: "PEN", name: "Peruvian sol", symbol: "S/", flag: { kind: "bands", dir: "v", colors: ["#D91023", "#FFFFFF", "#D91023"] } },

  // Asia-Pacific
  { code: "AUD", name: "Australian dollar", symbol: "$" },
  { code: "NZD", name: "New Zealand dollar", symbol: "$" },
  { code: "HKD", name: "Hong Kong dollar", symbol: "$" },
  { code: "SGD", name: "Singapore dollar", symbol: "$" },
  { code: "KRW", name: "South Korean won", symbol: "₩" },
  { code: "INR", name: "Indian rupee", symbol: "₹" },
  { code: "IDR", name: "Indonesian rupiah", symbol: "Rp", flag: { kind: "bands", dir: "h", colors: ["#CE1126", "#FFFFFF"] } },
  { code: "THB", name: "Thai baht", symbol: "฿", flag: { kind: "bands", dir: "h", colors: ["#A51931", "#F4F5F8", "#2D2A4A", "#F4F5F8", "#A51931"], weights: [1, 1, 2, 1, 1] } },
  { code: "PHP", name: "Philippine peso", symbol: "₱" },
  { code: "VND", name: "Vietnamese dong", symbol: "₫" },
  { code: "TWD", name: "New Taiwan dollar", symbol: "NT$" },
  { code: "PKR", name: "Pakistani rupee", symbol: "₨" },
  { code: "BDT", name: "Bangladeshi taka", symbol: "৳", flag: { kind: "disc", field: "#006A4E", disc: "#F42A41", r: 5.2 } },

  // Middle East + Africa
  { code: "AED", name: "UAE dirham", symbol: "د.إ" },
  { code: "SAR", name: "Saudi riyal", symbol: "﷼" },
  { code: "QAR", name: "Qatari riyal", symbol: "﷼" },
  { code: "ILS", name: "Israeli shekel", symbol: "₪" },
  { code: "EGP", name: "Egyptian pound", symbol: "£" },
  { code: "ZAR", name: "South African rand", symbol: "R" },
  { code: "NGN", name: "Nigerian naira", symbol: "₦", flag: { kind: "bands", dir: "v", colors: ["#008751", "#FFFFFF", "#008751"] } },
  { code: "KES", name: "Kenyan shilling", symbol: "KSh" },
  { code: "MAD", name: "Moroccan dirham", symbol: "د.م." },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

/** The record for a code, or `null` when it is not one we carry. */
export function currency(code: string): Currency | null {
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

/** The record for a code, falling back to USD — the account default. */
export function currencyOr(code: string | null | undefined): Currency {
  return (code ? currency(code) : null) ?? BY_CODE.get("USD")!;
}

export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code.trim().toUpperCase());
}
