import type { MessageKey, TFunction } from "@/lib/i18n";
import {
  MARKET_WIDE,
  isUserEventStoreErrorCode,
  type CalendarCategory,
  type UserEventFailure,
  type UserEventValidation,
} from "../../../shared/calendar-events";

/**
 * Sector names as the reader sees them. Events, saved filters and the user
 * events file keep the English GICS name as a stable id (`CalendarSector`),
 * so a filter saved in one language still works in another; only the label
 * goes through `t`.
 */
const SECTOR_KEY: Record<CalendarCategory, MessageKey> = {
  Technology: "calendar.sector.technology",
  "Communication Services": "calendar.sector.communicationServices",
  "Consumer Discretionary": "calendar.sector.consumerDiscretionary",
  "Consumer Staples": "calendar.sector.consumerStaples",
  Energy: "calendar.sector.energy",
  Financials: "calendar.sector.financials",
  Healthcare: "calendar.sector.healthcare",
  Industrials: "calendar.sector.industrials",
  Materials: "calendar.sector.materials",
  "Real Estate": "calendar.sector.realEstate",
  Utilities: "calendar.sector.utilities",
  "Funds & ETFs": "calendar.sector.funds",
  Unclassified: "calendar.sector.unclassified",
  [MARKET_WIDE]: "calendar.sector.marketWide",
};

/** The label for a sector or the market-wide bucket; an id this build does not know is shown as it is. */
export function sectorLabel(t: TFunction, category: CalendarCategory): string {
  const key = SECTOR_KEY[category];
  return key ? t(key) : category;
}

/** Why `validateUserEventInput` refused, in the reader's language. */
export function validationMessage(t: TFunction, result: Extract<UserEventValidation, { ok: false }>): string {
  return t(`calendar.validation.${result.code}`, result.params);
}

/**
 * Why a read, save or delete of the reader's own events failed, in the
 * reader's language: the store's code, or a validation code main sent back,
 * and main's English only for an answer without a code this build knows.
 */
export function failureMessage(t: TFunction, failure: Pick<UserEventFailure, "error" | "code" | "params">): string {
  const { code, params } = failure;
  if (isUserEventStoreErrorCode(code)) return t(`calendar.store.${code}`);
  if (code) {
    const key = `calendar.validation.${code}` as MessageKey;
    const text = t(key, params);
    if (text !== key) return text;
  }
  return failure.error;
}
