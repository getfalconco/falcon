import { useMemo } from "react";
import { withClock } from "@/lib/clock";
import { useI18n } from "@/lib/i18n";
import type { BriefingText } from "../../../shared/briefing-text";

/**
 * The reader's language in the shape the pure briefing and calendar views
 * take (`shared/briefing-text.ts`): the live `t`, the Intl locale for month
 * and weekday names, and the reader's 12 or 24 hour choice for times of day.
 * A new object only when the language changes, so a view memoised on it is
 * rebuilt exactly then.
 */
export function useBriefingText(): BriefingText {
  const { t, locale } = useI18n();
  return useMemo<BriefingText>(() => ({ t, locale, clock: (options) => withClock(options) }), [t, locale]);
}
