import type { LanguageCode } from "./languages";
import { MESSAGES, en, type MessageKey } from "./messages";

/**
 * Turning a key into the words on screen. Pure, so the rules (fallback and
 * interpolation) are tested without React or a DOM.
 */

/** Values a message can carry, by placeholder name: `{name}` takes `vars.name`. */
export type MessageVars = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fills `{name}` placeholders. A placeholder with no value is left as
 * written, so a missing variable shows up in the UI instead of vanishing.
 */
export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * The same, for values that are not text (a key cap, a bold symbol): the
 * template comes back as its pieces, strings and values in reading order,
 * ready to render as children. Each language keeps its own word order.
 */
export function interpolateParts<T>(template: string, vars: Readonly<Record<string, T>>): Array<string | T> {
  const parts: Array<string | T> = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const [whole, name] = match;
    const at = match.index ?? 0;
    if (!Object.prototype.hasOwnProperty.call(vars, name!)) continue;
    if (at > last) parts.push(template.slice(last, at));
    parts.push(vars[name!]!);
    last = at + whole.length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return parts;
}

/**
 * The template for a key in a language: that language's own wording, then
 * English, then the key itself, so an untranslated string reads in English
 * and a mistyped key is visible rather than blank.
 */
export function messageFor(language: LanguageCode, key: MessageKey): string {
  return MESSAGES[language]?.[key] ?? en[key] ?? key;
}

export function translate(language: LanguageCode, key: MessageKey, vars?: MessageVars): string {
  return interpolate(messageFor(language, key), vars);
}
