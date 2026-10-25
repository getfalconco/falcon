import type {
  ExperienceLevel,
  SectorId,
} from "../../shared/user-preferences";
import type { UpdateFrequency } from "../../shared/onboarding-survey";
import type { DashboardCard, HoldingPeriod } from "../../shared/onboarding-desk";
import type { HeardAboutSource } from "../../shared/onboarding-followup";
import type { MessageKey } from "@/lib/i18n";

/**
 * Onboarding's options. The ids are what gets stored (user_metadata and the
 * survey row), so they stay stable English ids whatever language the
 * questions were read in; what the reader sees comes from the `*Key` message
 * keys (lib/i18n/messages/areas/auth.ts). The plain English labels left here
 * (SECTOR_LABELS) are the summaries
 * lib/user-preferences.ts builds.
 */

export const SECTOR_LABELS: Record<SectorId, string> = {
  technology: "Technology",
  semiconductors: "Semiconductors",
  energy: "Energy",
  healthcare: "Healthcare",
  financials: "Financials",
  consumer: "Consumer",
  industrials: "Industrials",
  crypto: "Crypto",
};

/** What each sector chip reads, in the reader's language. */
export const SECTOR_LABEL_KEYS: Record<SectorId, MessageKey> = {
  technology: "auth.onboarding.sector.technology",
  semiconductors: "auth.onboarding.sector.semiconductors",
  energy: "auth.onboarding.sector.energy",
  healthcare: "auth.onboarding.sector.healthcare",
  financials: "auth.onboarding.sector.financials",
  consumer: "auth.onboarding.sector.consumer",
  industrials: "auth.onboarding.sector.industrials",
  crypto: "auth.onboarding.sector.crypto",
};

export const EXPERIENCE_OPTIONS: {
  id: ExperienceLevel;
  labelKey: MessageKey;
}[] = [
  {
    id: "new",
    labelKey: "auth.onboarding.tenure.new",
  },
  {
    id: "one_to_three_years",
    labelKey: "auth.onboarding.tenure.oneToThree",
  },
  {
    id: "three_to_ten_years",
    labelKey: "auth.onboarding.tenure.threeToTen",
  },
  {
    id: "ten_plus_pro",
    labelKey: "auth.onboarding.tenure.tenPlus",
  },
];

/** "How long do you usually hold?" */
export const HOLDING_OPTIONS: { id: HoldingPeriod; labelKey: MessageKey }[] = [
  { id: "days", labelKey: "auth.onboarding.holding.days" },
  { id: "weeks_months", labelKey: "auth.onboarding.holding.weeksMonths" },
  { id: "years", labelKey: "auth.onboarding.holding.years" },
];

/** What each card is called on the desk screen: the Add Module menu's own names. */
export const DESK_CARD_LABEL_KEYS: Record<DashboardCard, MessageKey> = {
  portfolio: "modules.portfolio",
  assets: "modules.assets",
  calendar: "modules.calendar",
  news: "modules.news",
  insight: "modules.insight",
  risk: "modules.risk",
  agents: "modules.agents",
  earnings: "modules.earnings",
  exposure: "modules.exposure",
  readthrough: "modules.readthrough",
  insiders: "modules.insiders",
  filings: "modules.filings",
  allocation: "modules.allocation",
};

/** The one-tap answers to "How did you hear about Falcon?". */
export const HEARD_ABOUT_LABEL_KEYS: Record<HeardAboutSource, MessageKey> = {
  friend: "auth.heard.friend",
  x: "auth.heard.x",
  reddit: "auth.heard.reddit",
  youtube: "auth.heard.youtube",
  search: "auth.heard.search",
  other: "auth.heard.other",
};

export const UPDATE_FREQUENCY_OPTIONS: { id: UpdateFrequency; label: string }[] = [
  { id: "daily_brief", label: "Daily brief" },
  { id: "real_time", label: "Real-time on major events" },
  { id: "weekly_summary", label: "Weekly summary only" },
];
