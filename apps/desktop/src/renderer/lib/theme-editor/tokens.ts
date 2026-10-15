import { isHslChannels, isRgbChannels, parseColor } from "./color";

/**
 * The dark theme's colour tokens, read out of globals.css itself.
 *
 * The editor imports the stylesheet's source (`globals.css?raw`) and hands it
 * here, so the list is whatever the file defines today: a token added to the
 * dark block shows up in the editor the next time it opens, and nothing here
 * keeps a second copy of a value. Every rule whose selector list names
 * `[data-theme="dark"]` on its own counts (the semantic block, the older
 * shadcn block it shares with `:root`, the tone derivations), later rules
 * winning as they do in the cascade. Rules that only reach INTO dark
 * (`[data-theme="dark"] .bg-white`, the generated palette) are not tokens and
 * are skipped, as is anything inside an at-rule other than @layer.
 *
 * Grouped the way the token list at the top of the dark layer is written.
 * Pure (no DOM): runs under `node --test` against the real file.
 */

/** How a token's value is written, which decides how the editor edits it. */
export type TokenKind =
  /** A colour literal: hex, rgb(), rgba(), hsl(), transparent. */
  | "color"
  /** Built from other tokens (`color-mix(...)`, `var(--x)`); a picked colour replaces it with a literal. */
  | "derived"
  /** `60 5% 4%`, read inside `hsl()` by its users. */
  | "hsl-channels"
  /** `232 231 227`, read inside `rgb()` by its users. */
  | "rgb-channels"
  /** A box-shadow; edited as text. */
  | "shadow";

export type TokenGroupId =
  | "surfaces"
  | "fills"
  | "edges"
  | "text"
  | "tones"
  | "cta"
  | "primary"
  | "switch"
  | "backdrop"
  | "shadows"
  | "chart"
  | "legacy";

export const GROUP_ORDER: readonly TokenGroupId[] = [
  "surfaces",
  "fills",
  "edges",
  "text",
  "tones",
  "cta",
  "primary",
  "switch",
  "backdrop",
  "shadows",
  "chart",
  "legacy",
];

export type DarkToken = {
  /** `--surface-1`. */
  name: string;
  /** The value globals.css gives it under dark, as written. */
  value: string;
  kind: TokenKind;
  group: TokenGroupId;
};

const DARK_SELECTOR = /^\[data-theme=(["']?)dark\1\]$/;

/** Strips comments, keeping string contents intact enough for custom property values. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

type Rule = { selector: string; body: string };

/**
 * The style rules of a stylesheet, flattened through @layer blocks. Other
 * at-rules (@media, @supports, @keyframes, @font-face) are skipped: a token
 * defined only under a media query is not the theme's default.
 */
export function styleRules(css: string): Rule[] {
  const text = stripComments(css);
  const out: Rule[] = [];
  const walk = (src: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open === -1) return;
      // A statement at-rule (`@tailwind base;`, `@import ...;`) before the block ends at its semicolon.
      let prelude = src.slice(i, open);
      const semi = prelude.lastIndexOf(";");
      if (semi !== -1) prelude = prelude.slice(semi + 1);
      prelude = prelude.trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        j += 1;
      }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) {
        if (/^@layer\b/i.test(prelude)) walk(body);
      } else if (!body.includes("{")) {
        out.push({ selector: prelude, body });
      }
      i = j;
    }
  };
  walk(text);
  return out;
}

/** `--name: value;` pairs of a declaration block, in order. */
export function customProperties(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]*?)\s*(?:;|$)/g;
  for (const m of body.matchAll(re)) {
    const value = m[2]!.replace(/\s+/g, " ").trim();
    if (value) out.push([m[1]!, value]);
  }
  return out;
}

export function isDarkSelector(selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.trim())
    .some((s) => DARK_SELECTOR.test(s));
}

/** Null when the value is not something the editor edits (a font, a radius, a size). */
export function classifyValue(value: string): TokenKind | null {
  const v = value.trim();
  if (/^(color-mix|var)\(/i.test(v)) return "derived";
  if (parseColor(v)) return "color";
  if (isHslChannels(v)) return "hsl-channels";
  if (isRgbChannels(v)) return "rgb-channels";
  if (/\d(px|rem|em)\b/.test(v) && /(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\()/i.test(v)) return "shadow";
  return null;
}

const TONES = ["positive", "negative", "warning", "info", "teal", "violet", "pink"] as const;
export type ToneName = (typeof TONES)[number];

/**
 * The order the documented tokens appear in within their group. A token the
 * list does not know keeps the stylesheet's order after these.
 */
const SEMANTIC_ORDER: readonly string[] = [
  "--surface-0",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--surface-4",
  "--surface-sunken",
  "--fill-hover",
  "--fill-press",
  "--fill-selected",
  "--fill-strong",
  "--border-subtle",
  "--border-default",
  "--border-strong",
  "--highlight",
  "--focus-ring",
  "--text-primary",
  "--text-body",
  "--text-secondary",
  "--text-tertiary",
  "--text-disabled",
  "--ink-rgb",
  ...TONES.flatMap((t) => [`--${t}`, `--${t}-muted`, `--${t}-soft`, `--${t}-line`]),
  "--cta-bg",
  "--cta-bg-hover",
  "--cta-bg-press",
  "--cta-fg",
  "--cta-border",
  "--primary-bg",
  "--primary-bg-hover",
  "--primary-fg",
  "--switch-on",
  "--switch-off",
  "--switch-knob-on",
  "--switch-knob-off",
  "--backdrop",
  "--shadow-card",
  "--shadow-popover",
  "--shadow-modal",
  "--chart-ink",
];

export function groupOf(name: string): TokenGroupId {
  if (/^--surface-(\d|sunken)$/.test(name)) return "surfaces";
  if (/^--fill-(hover|press|selected|strong)$/.test(name)) return "fills";
  if (/^--border-(subtle|default|strong)$/.test(name) || name === "--highlight" || name === "--focus-ring") return "edges";
  if (/^--text-/.test(name) || name === "--ink-rgb") return "text";
  if (new RegExp(`^--(${TONES.join("|")})(-(muted|soft|line))?$`).test(name)) return "tones";
  if (/^--cta-(bg|bg-hover|bg-press|fg|border)$/.test(name)) return "cta";
  if (/^--primary-(bg|bg-hover|fg)$/.test(name)) return "primary";
  if (/^--switch-/.test(name)) return "switch";
  if (name === "--backdrop") return "backdrop";
  if (/^--shadow-/.test(name)) return "shadows";
  if (/^--chart-/.test(name)) return "chart";
  return "legacy";
}

/** For a derived tone token, its tone and role; null for anything else. */
export function toneParts(name: string): { tone: ToneName; role: "muted" | "soft" | "line" | null } | null {
  const m = new RegExp(`^--(${TONES.join("|")})(?:-(muted|soft|line))?$`).exec(name);
  if (!m) return null;
  return { tone: m[1] as ToneName, role: (m[2] as "muted" | "soft" | "line" | undefined) ?? null };
}

/** Every colour token the stylesheet defines for dark, in editor order. */
export function parseDarkTokens(css: string): DarkToken[] {
  const values = new Map<string, string>();
  for (const rule of styleRules(css)) {
    if (!isDarkSelector(rule.selector)) continue;
    for (const [name, value] of customProperties(rule.body)) {
      // Later rules win, as in the cascade; re-inserting keeps the first position for order.
      values.set(name, value);
    }
  }
  // `var(--x)` alone is a colour only when --x is one (`--font-geist-sans: var(--font-sans)` is not).
  const kindOf = (name: string, seen: Set<string>): TokenKind | null => {
    const value = values.get(name);
    if (value === undefined || seen.has(name)) return null;
    const kind = classifyValue(value);
    const alias = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value.trim());
    if (kind === "derived" && alias) {
      seen.add(name);
      return kindOf(alias[1]!, seen) ? "derived" : null;
    }
    return kind;
  };
  const tokens: DarkToken[] = [];
  for (const [name, value] of values) {
    const kind = kindOf(name, new Set());
    if (!kind) continue;
    tokens.push({ name, value, kind, group: groupOf(name) });
  }
  const rank = (name: string) => {
    const i = SEMANTIC_ORDER.indexOf(name);
    return i === -1 ? SEMANTIC_ORDER.length : i;
  };
  const sourceIndex = new Map(tokens.map((t, i) => [t.name, i]));
  return tokens.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g !== 0) return g;
    const r = rank(a.name) - rank(b.name);
    if (r !== 0) return r;
    return sourceIndex.get(a.name)! - sourceIndex.get(b.name)!;
  });
}

/** Tokens per group, in GROUP_ORDER, empty groups left out. */
export function groupTokens(tokens: readonly DarkToken[]): Array<{ group: TokenGroupId; tokens: DarkToken[] }> {
  return GROUP_ORDER.map((group) => ({ group, tokens: tokens.filter((t) => t.group === group) })).filter(
    (g) => g.tokens.length > 0,
  );
}
