/**
 * Colour reading and writing for the dark theme editor (Settings, Developer,
 * Testing, "Dark theme colors").
 *
 * Pure on purpose (no DOM), so the editor, the main window and `node --test`
 * all read a colour the same way. The editor accepts what globals.css is
 * written in (hex, rgb(), rgba(), hsl(), hsla(), `transparent`) plus what
 * Chromium hands back from getComputedStyle (`color(srgb r g b / a)` for a
 * color-mix), and writes back hex when the colour is opaque and rgba() when it
 * is not, so an exported block reads like the file it goes back into.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hexToRgba(hex: string): Rgba | null {
  const h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : round(a / 255, 3) };
  }
  if (h.length === 6 || h.length === 8) {
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255, 3) : 1 };
  }
  return null;
}

function round(n: number, places = 0): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** "50%" -> 0.5 of `scale`, "0.4" -> 0.4 (alpha) or 0.4 of nothing (channel). */
function channel(raw: string, scale: number): number | null {
  const s = raw.trim();
  if (s === "none") return 0;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * scale : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function alphaOf(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const s = raw.trim();
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? clamp(n / 100, 0, 1) : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

/** The arguments of `fn(...)`, comma or space separated, with an optional `/ alpha`. */
function args(body: string): { parts: string[]; alpha?: string } | null {
  const [main, alpha, extra] = body.split("/");
  if (extra !== undefined || main === undefined) return null;
  const parts = main.includes(",") ? main.split(",") : main.trim().split(/\s+/);
  const trimmed = parts.map((p) => p.trim()).filter((p) => p !== "");
  // Legacy comma syntax carries alpha as a fourth argument.
  if (alpha === undefined && trimmed.length === 4) return { parts: trimmed.slice(0, 3), alpha: trimmed[3] };
  return { parts: trimmed, alpha: alpha?.trim() };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hueOf(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const m = /^(-?[\d.]+)(deg|turn|rad)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "turn") return n * 360;
  if (m[2] === "rad") return (n * 180) / Math.PI;
  return n;
}

/**
 * A CSS colour as channels, or null when it is not one this editor reads.
 * `var()`, `color-mix()` and named colours other than the few below are not
 * colours here: the editor resolves those through the page instead.
 */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (s.startsWith("#")) return hexToRgba(s);
  const fn = /^(rgba?|hsla?|color)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const name = fn[1]!;
  let body = fn[2]!;
  if (name === "color") {
    const space = /^\s*srgb\s+(.*)$/.exec(body);
    if (!space) return null;
    body = space[1]!;
  }
  const parsed = args(body);
  if (!parsed || parsed.parts.length !== 3) return null;
  const a = alphaOf(parsed.alpha);
  if (a === null) return null;
  if (name === "color") {
    const vals = parsed.parts.map((p) => channel(p, 1));
    if (vals.some((v) => v === null)) return null;
    const [r, g, b] = vals.map((v) => Math.round(clamp(v!, 0, 1) * 255));
    return { r: r!, g: g!, b: b!, a: round(a, 3) };
  }
  if (name.startsWith("rgb")) {
    const vals = parsed.parts.map((p) => channel(p, 255));
    if (vals.some((v) => v === null)) return null;
    const [r, g, b] = vals.map((v) => Math.round(clamp(v!, 0, 255)));
    return { r: r!, g: g!, b: b!, a: round(a, 3) };
  }
  const h = hueOf(parsed.parts[0]!);
  const sat = channel(parsed.parts[1]!, 1);
  const lig = channel(parsed.parts[2]!, 1);
  if (h === null || sat === null || lig === null) return null;
  // hsl() wants percentages; a bare number reads as one (Chromium accepts it in the space syntax).
  const sv = parsed.parts[1]!.trim().endsWith("%") ? sat : sat / 100;
  const lv = parsed.parts[2]!.trim().endsWith("%") ? lig : lig / 100;
  return { ...hslToRgb(h, sv, lv), a: round(a, 3) };
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");

/** `#rrggbb`, what `<input type="color">` takes and gives. Alpha is dropped. */
export function toPickerHex(c: Rgba): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** Alpha written the short way: 0.055, not 0.05500000001. */
export function formatAlpha(a: number): string {
  return String(round(clamp(a, 0, 1), 3));
}

/** Hex when opaque, rgba() otherwise: the two forms globals.css is written in. */
export function formatColor(c: Rgba): string {
  if (c.a >= 1) return toPickerHex(c);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${formatAlpha(c.a)})`;
}

/** The picker's `#rrggbb` with an alpha kept from elsewhere (the row's slider). */
export function withPicker(pickerHex: string, alpha: number): Rgba | null {
  const c = hexToRgba(pickerHex);
  return c ? { ...c, a: clamp(alpha, 0, 1) } : null;
}

/* --- Channel triplets: the older shadcn tokens (`--background: 60 5% 4%`)
 *     and `--ink-rgb: 232 231 227`, read inside hsl() and rgb() by their users. */

const HSL_CHANNELS = /^\s*(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\s*$/i;
const RGB_CHANNELS = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/;

export function isHslChannels(value: string): boolean {
  return HSL_CHANNELS.test(value);
}

export function isRgbChannels(value: string): boolean {
  return RGB_CHANNELS.test(value);
}

export function parseHslChannels(value: string): Rgba | null {
  const m = HSL_CHANNELS.exec(value);
  if (!m) return null;
  return { ...hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100), a: 1 };
}

export function formatHslChannels(c: Rgba): string {
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  return `${round(h, 1)} ${round(s * 100, 1)}% ${round(l * 100, 1)}%`;
}

export function parseRgbChannels(value: string): Rgba | null {
  const m = RGB_CHANNELS.exec(value);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((n) => Number(n));
  if ([r, g, b].some((n) => n! > 255)) return null;
  return { r: r!, g: g!, b: b!, a: 1 };
}

export function formatRgbChannels(c: Rgba): string {
  return `${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}`;
}

/* --- Contrast (WCAG 2.x) ------------------------------------------------ */

function linear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/** `top` laid over an opaque `bottom`, the way the screen shows it. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = clamp(top.a, 0, 1);
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG contrast ratio of a (possibly translucent) foreground on an opaque background, 1 to 21. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const solidBg = { ...bg, a: 1 };
  const solidFg = composite(fg, solidBg);
  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(solidBg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return round((hi + 0.05) / (lo + 0.05), 2);
}
