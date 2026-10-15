/**
 * Mojibake repair for provider text (headlines, summaries, source names).
 *
 * Some providers hand over UTF-8 that was decoded as Latin-1 or Windows-1252
 * somewhere upstream: "weekâ€™s" for "week's", "Ã©" for "é", "Â£" for "£",
 * "â" followed by invisible C1 control characters. This undoes that, and only
 * that, conservatively:
 *
 *   1. Each run of characters that, read back as Windows-1252 / Latin-1
 *      bytes, forms one valid UTF-8 sequence is decoded, but only for the
 *      shapes mojibake actually takes in English news: a two-byte sequence
 *      led by "Â", "Ã", "Ä" or "Å" that lands on U+00A0..U+017F (accented
 *      Latin letters, £, ©, NBSP), and a three-byte sequence led by "â" that
 *      lands on punctuation, currency or letterlike symbols (’ “ ” – — … € ™).
 *      A legitimate "café", "Zürich" or "Société Générale" never forms such a
 *      sequence: the accented letter is not a lead byte of that shape, or what
 *      follows it is not a continuation byte. Run twice, for text that was
 *      mangled twice.
 *   2. A short table for remnants the byte pass cannot reach because a byte
 *      was lost on the way: "â€" whose closing quote byte (0x9D) was dropped,
 *      and English contractions whose C1 bytes were stripped ("weekâs",
 *      "donât"), plus a stray byte order mark.
 *
 * Text with none of the lead characters is returned as is, untouched.
 *
 * Pure (no fs, no network), and published on its own as
 * `@meridian/research/news/mojibake` so the desktop renderer can repair rows
 * it reads with this same implementation. Keep it free of Node-only imports.
 */

/** Windows-1252's printable characters in 0x80..0x9F, back to their byte. */
const CP1252_BYTE: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Cheap gate: every shape repaired below starts with one of these. */
const LEADS = /[Â-Åâï]/;

/** The byte a character stands for when read as Windows-1252 (Latin-1 for C1), or -1. */
function byteOf(code: number): number {
  if (code < 0x100) return code;
  return CP1252_BYTE[code] ?? -1;
}

/** The continuation byte a character stands for, or -1. */
function continuation(code: number): number {
  const b = byteOf(code);
  return b >= 0x80 && b <= 0xbf ? b : -1;
}

/** What a three-byte "â" sequence may decode to: punctuation, currency, letterlike (™). */
function plausibleThreeByte(cp: number): boolean {
  return (cp >= 0x2010 && cp <= 0x205f) || (cp >= 0x20a0 && cp <= 0x20bf) || (cp >= 0x2100 && cp <= 0x214f);
}

function bytePass(text: string): string {
  let out = "";
  let changed = false;
  let i = 0;
  while (i < text.length) {
    const lead = text.charCodeAt(i);
    // Â Ã Ä Å + one continuation: U+0080..U+017F; C1 controls and below are refused.
    if (lead >= 0xc2 && lead <= 0xc5 && i + 1 < text.length) {
      const b1 = continuation(text.charCodeAt(i + 1));
      if (b1 >= 0) {
        const cp = ((lead & 0x1f) << 6) | (b1 & 0x3f);
        if (cp >= 0xa0) {
          out += String.fromCharCode(cp);
          i += 2;
          changed = true;
          continue;
        }
      }
    }
    // â + two continuations: U+2000..U+2FFF, kept only for punctuation-like results.
    if (lead === 0xe2 && i + 2 < text.length) {
      const b1 = continuation(text.charCodeAt(i + 1));
      const b2 = continuation(text.charCodeAt(i + 2));
      if (b1 >= 0 && b2 >= 0) {
        const cp = ((lead & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        if (plausibleThreeByte(cp)) {
          out += String.fromCharCode(cp);
          i += 3;
          changed = true;
          continue;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return changed ? out : text;
}

/** Characters that would have continued "â€" had a byte not been lost. */
const CONTINUES = "\u0080-¿€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** Remnants the byte pass cannot decode because a byte went missing upstream. */
const REMNANTS: ReadonlyArray<readonly [RegExp, string]> = [
  // A UTF-8 byte order mark read as Windows-1252, or kept as the character.
  [/ï»¿|﻿/g, ""],
  // ” is E2 80 9D; 0x9D is undefined in Windows-1252 and often dropped.
  [new RegExp(`â€(?![${CONTINUES}])`, "g"), "”"],
  // ’ in an English contraction whose two C1 bytes were stripped: "weekâs", "donât".
  [/(?<=[A-Za-z])â(?=(?:s|re|ll|ve|d|m)\b)/g, "’"],
  [/(?<=[A-Za-z]n)â(?=t\b)/g, "’"],
];

export function repairMojibake(text: string): string {
  if (typeof text !== "string" || !LEADS.test(text)) return text;
  let out = bytePass(bytePass(text));
  if (LEADS.test(out)) for (const [re, replacement] of REMNANTS) out = out.replace(re, replacement);
  return out;
}

/** A provider article's text fields, repaired; everything else as it came. */
export function repairArticleText<T extends { headline?: unknown; summary?: unknown; source?: unknown }>(article: T): T {
  if (!article || typeof article !== "object") return article;
  const fix = (v: unknown) => (typeof v === "string" ? repairMojibake(v) : v);
  const headline = fix(article.headline);
  const summary = fix(article.summary);
  const source = fix(article.source);
  if (headline === article.headline && summary === article.summary && source === article.source) return article;
  return { ...article, headline, summary, source };
}
