/**
 * Design tokens. Onboarding still mirrors the marketing site (COLORS / TYPE).
 * The signed-in product surface (PRODUCT / PTYPE) is a pocket language and is
 * allowed to diverge from the desktop instrument panel — see
 * docs/PLATFORM_PARITY.md.
 */

export const COLORS = {
  /**
   * Page background on every light surface (home, early-access, login).
   * Same canvas as the desktop window — Electron's `backgroundColor` and
   * globals.css `--background` (60 10% 91%) both resolve to #eaeae6.
   */
  bg: "#eaeae6",
  /** Primary text. */
  ink: "rgb(29, 27, 27)",
  /** Body copy on light surfaces. */
  body: "rgb(70, 66, 66)",
  /** Secondary/supporting copy. */
  muted: "#767676",
  /** Tertiary — captions, placeholders, disabled text. */
  faint: "#9a9a9a",
  /** Even quieter, used for mono eyebrow labels. */
  mutedMono: "#a1a1a1",
  /** Dark surface (buttons). */
  inkButton: "#1c1917",
  inkButtonHover: "#0f0d0b",
  /** Text on dark buttons. */
  onInk: "rgb(231, 231, 231)",
  /** Disabled button surface + label. The surface has to sit clearly darker
   *  than the #eaeae6 canvas — the site's #eceae7 is within a hair of it and
   *  the button dissolves into the page on a phone. */
  disabledBg: "#d5d3ce",
  disabledText: "#7c7b78",
  /** Hairline borders. */
  border: "rgba(0, 0, 0, 0.10)",
  borderStrong: "rgba(0, 0, 0, 0.30)",
  /** Dashed rules used across the site's grid sections. */
  dash: "rgba(0, 0, 0, 0.14)",
  /** Rust accent — feature numbering, ticket highlights. Used sparingly. */
  accent: "rgb(168, 100, 72)",
  error: "#dc2626",
} as const;

/**
 * Ticket palette — early-access tier from apps/web WaitlistTicket / TIERS.
 */
export const TICKET = {
  back: "#05262f",
  front: "#0f7d92",
  highlight: "#4fd8e6",
  ink: "#c2eff5",
  watermark: "#0d4a58",
  label: "#5aa3b2",
} as const;

/** Font families — names must match the keys passed to useFonts(). */
export const FONTS = {
  /** Libre Baskerville — every headline. */
  serif: "LibreBaskerville_400Regular",
  serifItalic: "LibreBaskerville_400Regular_Italic",
  serifBold: "LibreBaskerville_700Bold",
  /** Geist Sans — body copy. */
  sans: "Geist-Regular",
  sansMedium: "Geist-Medium",
  /** Geist Mono — small uppercase labels and ticket metadata. */
  mono: "GeistMono-Regular",
  monoMedium: "GeistMono-Medium",
} as const;

/**
 * Type scale taken from the web pages. Headline sizes are scaled down for
 * phone widths — the web hero is 48px at 1440px wide, which is too large on a
 * 390pt screen.
 */
export const TYPE = {
  hero: { fontFamily: FONTS.serif, fontSize: 34, lineHeight: 40, color: COLORS.ink },
  title: { fontFamily: FONTS.serif, fontSize: 28, lineHeight: 34, color: COLORS.ink },
  sectionTitle: { fontFamily: FONTS.serif, fontSize: 22, lineHeight: 28, color: COLORS.ink },
  body: { fontFamily: FONTS.sans, fontSize: 16, lineHeight: 24, color: COLORS.body },
  bodySmall: { fontFamily: FONTS.sans, fontSize: 14, lineHeight: 21, color: COLORS.muted },
  /** Uppercase mono eyebrow, e.g. "CLICK ON THE TICKET TO CONTINUE". */
  eyebrow: {
    fontFamily: FONTS.mono,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.6,
    color: COLORS.mutedMono,
  },
  label: { fontFamily: FONTS.sans, fontSize: 13, lineHeight: 18, color: COLORS.muted },
  button: { fontFamily: FONTS.sans, fontSize: 15, lineHeight: 20 },
} as const;

export const SPACING = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

/**
 * The site's shared motion curve (packages/ui/src/tokens.ts EASE) and the
 * ease-out used for the waitlist reveal choreography (WaitlistView EASE_OUT).
 */
export const EASE_BEZIER = [0.21, 0.47, 0.32, 0.98] as const;
export const EASE_OUT_BEZIER = [0.16, 1, 0.3, 1] as const;

/**
 * Ticket interaction — keep in lockstep with packages/ui/src/tokens.ts.
 * Hover 1.05×; click flies 400→460 (1.15×) into the focus stage.
 */
export const TICKET_HOVER_SCALE = 1.05;
export const TICKET_HOVER_MS = 300;
export const TICKET_HOVER_EASE = [0.22, 1, 0.36, 1] as const;
export const TICKET_STAGE_SCALE = 460 / 400;
export const TICKET_FLIGHT_MS = 450;
export const TICKET_EASE_SOFT = [0.4, 0, 0.2, 1] as const;

/* -------------------------------------------------------------------------
 * Product surface (post-login)
 *
 * Onboarding stays light because it mirrors the marketing site. Once signed
 * in, mobile uses a pocket language (warm grey, black pills, giant numerals)
 * rather than cloning the desktop instrument panel. See PLATFORM_PARITY.md.
 * ---------------------------------------------------------------------- */

export const PRODUCT = {
  /** Canvas — deliberately the same #eaeae6 the desktop window paints. */
  bg: "#eaeae6",
  /** Tab bar / rail — unused once the floating nav is in. */
  bar: "#ffffff",
  /** Card + panel surface. */
  card: "#ffffff",
  /** Raised surface for sheets and prompts. */
  elevated: "#ffffff",
  /** Quiet fill for inline chips. */
  fill: "#f3f1ec",

  fg: "#111111",
  fgBody: "#2a2a2a",
  fgMuted: "#5a5a5a",
  fgFaint: "#7a7a7a",
  fgSubtle: "#9a9a9a",

  border: "rgba(0, 0, 0, 0.06)",
  borderStrong: "rgba(0, 0, 0, 0.12)",

  brand: "#111111",
  brandSoft: "rgba(17, 17, 17, 0.08)",
  /** Actionable / opportunity — not P&L. Gain stays for signed returns. */
  accent: "#189E9A",

  gain: "#0f8a63",
  gainSoft: "#e7f6f0",
  loss: "#d02b33",
  lossSoft: "#fdecec",
  neutral: "#a3a3a3",

  chart: {
    value: "#1d1b1b",
    growth: "#8f8f8f",
    sp500: "#c0bdb6",
    axis: "#9a9a9a",
  },

  ctaBg: "#111111",
  ctaFg: "#f6f6f4",

  pill: "#111111",
  pillFg: "#ffffff",
  shadow: "rgba(17, 17, 17, 0.12)",
} as const;

/**
 * Type scale for the phone. Hero numerals are oversized on purpose — the desk
 * product stays dense; this surface is for triggering and skimming.
 */
export const PTYPE = {
  greeting: {
    fontFamily: FONTS.sansMedium,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.4,
    color: PRODUCT.fg,
  },
  greetingTime: {
    fontFamily: FONTS.serif,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.3,
    color: PRODUCT.fg,
  },
  heroNumeral: {
    fontFamily: FONTS.sansMedium,
    fontSize: 52,
    lineHeight: 56,
    letterSpacing: -1.6,
    color: PRODUCT.fg,
  },
  microLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: PRODUCT.fgFaint,
  },
  heroMetric: {
    fontFamily: FONTS.sansMedium,
    fontSize: 56,
    lineHeight: 58,
    letterSpacing: -1.8,
    color: PRODUCT.fg,
  },
  metric: {
    fontFamily: FONTS.sansMedium,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.6,
    color: PRODUCT.fg,
  },
  signalLine: {
    fontFamily: FONTS.sansMedium,
    fontSize: 18,
    lineHeight: 24,
    color: PRODUCT.fg,
  },
  row: {
    fontFamily: FONTS.sans,
    fontSize: 16,
    lineHeight: 22,
    color: PRODUCT.fgBody,
  },
  body: {
    fontFamily: FONTS.sans,
    fontSize: 15,
    lineHeight: 22,
    color: PRODUCT.fgBody,
  },
  small: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 18,
    color: PRODUCT.fgSubtle,
  },
  tag: {
    fontFamily: FONTS.sansMedium,
    fontSize: 11,
    lineHeight: 14,
    color: PRODUCT.fgFaint,
  },
  ticker: {
    fontFamily: FONTS.sansMedium,
    fontSize: 16,
    color: PRODUCT.fg,
  },
  num: {
    fontFamily: FONTS.mono,
    fontSize: 12,
    color: PRODUCT.fgSubtle,
  },
} as const;

export const RADIUS = {
  panel: 24,
  row: 16,
  control: 12,
  pill: 999,
} as const;

export const SHADOW = {
  shadowColor: "#111111",
  shadowOpacity: 0.08,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6,
} as const;

/**
 * Panel chrome. The desktop uses a 0.5px border on a card surface —
 * `rounded-xl` for dashboard panels, `rounded-md` for list rows.
 */
export const CARD = {
  backgroundColor: PRODUCT.card,
  borderRadius: RADIUS.panel,
  /** iOS's continuous corner — the squircle, not a circular arc. */
  borderCurve: "continuous" as const,
  ...SHADOW,
} as const;

export const ROW_CARD = {
  backgroundColor: PRODUCT.card,
  borderRadius: RADIUS.row,
  borderCurve: "continuous" as const,
  ...SHADOW,
} as const;

export function directionColor(direction?: string | null): string {
  if (direction === "positive") return PRODUCT.gain;
  if (direction === "negative") return PRODUCT.loss;
  return PRODUCT.neutral;
}
