/**
 * The reader's country from the machine's locale list, instead of a question:
 * the first locale that names a region ("tr-TR", "pt-BR", "en-GB") and whose
 * region is one the app knows. A bare language ("de", "ja") names no country
 * and is skipped rather than guessed.
 */
export function countryFromLocales(locales: readonly string[], known: readonly string[]): string | null {
  const allowed = new Set(known.map((c) => c.toUpperCase()));
  for (const tag of locales) {
    if (typeof tag !== "string" || !tag.trim()) continue;
    let region: string | undefined;
    try {
      region = new Intl.Locale(tag.replace(/_/g, "-")).region;
    } catch {
      region = undefined;
    }
    if (region && allowed.has(region.toUpperCase())) return region.toUpperCase();
  }
  return null;
}
