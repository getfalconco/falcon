/**
 * Where the legal documents live. The full text is on the website only (the
 * app links to it and never carries a copy), so every surface that mentions
 * the policies opens these same addresses: the "Learn more" menu, Settings,
 * Privacy, and the sign-in screen.
 *
 * The usage policy is the Terms' "Acceptable use" section; its anchor is
 * stable on the site (apps/web/app/terms/content.tsx).
 */

export const SITE = "https://getfalcon.co";

export const LEGAL_URLS = {
  privacy: `${SITE}/privacy`,
  terms: `${SITE}/terms`,
  usagePolicy: `${SITE}/terms#acceptable-use`,
} as const;

export type LegalDoc = keyof typeof LEGAL_URLS;

/** Opens a legal page in the reader's own browser, through the main process. */
export function openLegal(doc: LegalDoc): void {
  void window.meridian?.openExternal?.(LEGAL_URLS[doc]);
}
