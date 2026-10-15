/**
 * The facts the Privacy Policy and Terms of Service depend on, in one place.
 *
 * Every value that starts with "[TODO" is a placeholder: the legal pages render
 * it highlighted, and show a draft notice at the top, so an unfinished document
 * cannot ship looking finished. Replace each one with the real value (and have
 * counsel review the documents) before relying on either page.
 *
 * Nothing here is guessed. Where the code does not say (the company behind
 * Falcon, where it is registered, which law governs), the value is a TODO.
 */

export const TODO_PREFIX = "[TODO";

export function isPlaceholder(value: string): boolean {
  return value.trim().startsWith(TODO_PREFIX);
}

export const LEGAL_CONFIG = {
  /** The product name used throughout both documents. */
  productName: "Falcon",
  /** The public website the documents live on. */
  siteUrl: "https://getfalcon.co",

  /** The legal entity that operates Falcon and acts as data controller. */
  entityName: "[TODO: legal entity name, e.g. Example Technologies Ltd.]",
  /** Company registration number, if the entity has one. */
  registrationNumber: "[TODO: company registration number]",
  /** Registered office address. */
  address: "[TODO: registered office address]",
  /** Country where the entity is established. */
  country: "[TODO: country of incorporation]",

  /** The law that governs the Terms, e.g. "the laws of England and Wales". */
  governingLaw: "[TODO: governing law, e.g. the laws of England and Wales]",
  /** Courts with jurisdiction over disputes, e.g. "the courts of London, England". */
  venue: "[TODO: courts or arbitral seat for disputes]",

  /** General and legal contact. */
  contactEmail: "[TODO: legal contact email, e.g. legal@getfalcon.co]",
  /** Privacy requests (access, deletion, objections). */
  privacyEmail: "[TODO: privacy contact email, e.g. privacy@getfalcon.co]",
  /** Data protection officer, if one is appointed; "none appointed" otherwise. */
  dpo: "[TODO: data protection officer contact, or state that none is appointed]",
  /** Representative in the EU (GDPR Art. 27), needed if the entity is outside the EU and serves EU users. */
  euRepresentative: "[TODO: EU representative under GDPR Art. 27, or remove if not required]",
  /** Representative in the UK (UK GDPR Art. 27), needed if the entity is outside the UK and serves UK users. */
  ukRepresentative: "[TODO: UK representative under UK GDPR Art. 27, or remove if not required]",
  /** Turkish data controller registration (VERBIS) and representative, if applicable under KVKK. */
  kvkkRegistration: "[TODO: VERBIS registration and KVKK data controller representative, if applicable]",

  /**
   * How long applications from people who are not admitted, and careers
   * applications with their CVs, are kept. The code has no automatic purge
   * today, so this is a policy decision to make (and then implement).
   */
  applicantRetention: "[TODO: retention period for applications not taken forward, e.g. 12 months]",

  /** How long error reports posted to the team's Discord channel are kept. Nothing deletes them today. */
  errorReportRetention: "[TODO: retention period for error reports in the team Discord channel, e.g. 90 days]",

  /**
   * The research worker forwards model requests to its own ANTHROPIC_BASE_URL,
   * which the repo does not pin (commit 051c1c5 mentions a gateway, "Moodly").
   * Name the gateway, or say requests go straight to Anthropic.
   */
  modelGateway: "[TODO: name the model gateway the research worker forwards to, or state that requests go directly to Anthropic]",
  modelGatewayLocation: "[TODO: model gateway location]",

  /** Region of the Railway services (engine.getfalcon.co, worker.getfalcon.co). */
  railwayRegion: "[TODO: Railway region for the engine and research worker]",

  /** Where SnapTrade processes data (check SnapTrade's own privacy policy). */
  snaptradeLocation: "[TODO: SnapTrade processing location, from SnapTrade's privacy policy]",

  /** The date each document takes effect, written out, e.g. "1 November 2026". */
  effectiveDate: "[TODO: effective date]",
  /** The date the text was last changed. Kept apart from the effective date on purpose. */
  lastUpdated: "15 October 2026",

  /**
   * Flip to true only once qualified counsel has reviewed both documents and
   * every placeholder above is filled. While false, both pages say they are a
   * draft pending legal review.
   */
  reviewedByCounsel: false,
} as const;

export type LegalConfigKey = keyof typeof LEGAL_CONFIG;

/** Every placeholder still left in the config, by key; empty once the documents are ready. */
export function unresolvedPlaceholders(): LegalConfigKey[] {
  return (Object.keys(LEGAL_CONFIG) as LegalConfigKey[]).filter((key) => {
    const value = LEGAL_CONFIG[key];
    return typeof value === "string" && isPlaceholder(value);
  });
}
