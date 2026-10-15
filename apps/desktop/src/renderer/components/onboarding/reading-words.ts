import type { ReadingFact, RelationCategory } from "../../../shared/first-reading";
import type { MessageKey, TFunction } from "@/lib/i18n";

/** The first reading's facts in the reader's language. */

const RELATION_KEYS: Record<RelationCategory, MessageKey> = {
  supplier: "auth.onboarding.reading.supplier",
  customer: "auth.onboarding.reading.customer",
  partner: "auth.onboarding.reading.partner",
  competitor: "auth.onboarding.reading.competitor",
  dependency: "auth.onboarding.reading.dependency",
};

/** A filing date (YYYY-MM-DD) in the reader's locale, read as a calendar date rather than an instant. */
export function formatFilingDate(date: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${date}T00:00:00Z`),
    );
  } catch {
    return date;
  }
}

/** "PLTR and SOFI", in the reader's language. */
export function listNames(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

export function wordFact(t: TFunction, fact: ReadingFact, locale: string): string {
  if (fact.kind === "relation") {
    const form = fact.form ?? t("auth.onboarding.reading.annualReport");
    const source = fact.filingDate
      ? t("auth.onboarding.reading.source", { root: fact.root, form, date: formatFilingDate(fact.filingDate, locale) })
      : t("auth.onboarding.reading.sourceUndated", { root: fact.root, form });
    return t(RELATION_KEYS[fact.category], { counterparty: fact.counterparty, root: fact.root, source });
  }
  const vars = { ticker: fact.ticker, days: fact.days };
  if (fact.days === 0) {
    return t(fact.estimated ? "auth.onboarding.reading.earningsTodayEstimated" : "auth.onboarding.reading.earningsToday", vars);
  }
  if (fact.days === 1) {
    return t(
      fact.estimated ? "auth.onboarding.reading.earningsTomorrowEstimated" : "auth.onboarding.reading.earningsTomorrow",
      vars,
    );
  }
  return t(fact.estimated ? "auth.onboarding.reading.earningsInDaysEstimated" : "auth.onboarding.reading.earningsInDays", vars);
}
