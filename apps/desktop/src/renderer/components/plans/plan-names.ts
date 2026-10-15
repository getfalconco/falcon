import type { MessageKey, TFunction } from "@/lib/i18n";
import { PLANS, STAFF_TICKETS, type CurrentPlan, type PlanKey, type StaffRole } from "../../../shared/plans";

/**
 * The words for plans, in the reader's language, shared by the account pill,
 * Settings → Billing and View All Plans so the three never disagree.
 *
 * Plan names (Early Access, Silver, Gold, Platinum) are names, the same in
 * every language, as on the tickets and on getfalcon.co. Internal roles are
 * ordinary words ("Staff", "Leader") and are translated, except on the ticket
 * art itself, which keeps the site's English like its "Admit one".
 */

const ROLE_KEYS: Readonly<Record<StaffRole, MessageKey>> = {
  staff: "plans.role.staff",
  deputy: "plans.role.deputy",
  leader: "plans.role.leader",
  talent_manager: "plans.role.talentManager",
};

export function planLabel(key: PlanKey): string {
  return PLANS.find((p) => p.key === key)?.label ?? key;
}

export function roleLabel(role: StaffRole, t: TFunction): string {
  return t(ROLE_KEYS[role]);
}

/** What the account is on, as the reader should read it. */
export function currentPlanLabel(current: CurrentPlan, t: TFunction): string {
  return current.kind === "staff" ? roleLabel(current.role, t) : planLabel(current.key);
}

/** The role's name as printed on its ticket (the site's own English). */
export function roleTicketName(role: StaffRole): string {
  return STAFF_TICKETS[role].label;
}

/**
 * A comparison value in words: included, not included, a count as written,
 * or one of the site's tier words translated. A value with no translation
 * here is shown as the site wrote it.
 */
const VALUE_KEYS: Readonly<Record<string, MessageKey>> = {
  Unlimited: "plans.value.unlimited",
  Standard: "plans.value.standard",
  Deep: "plans.value.deep",
  Institutional: "plans.value.institutional",
  Core: "plans.value.core",
  Full: "plans.value.full",
  "Full + history": "plans.value.fullHistory",
};

export function featureValueText(value: string | boolean, t: TFunction): string {
  if (value === true) return t("plans.included");
  if (value === false) return t("plans.notIncluded");
  const key = VALUE_KEYS[value];
  return key ? t(key) : value;
}

const FEATURE_KEYS: Readonly<Record<string, MessageKey>> = {
  trackedCompanies: "plans.feature.trackedCompanies",
  dailySignal: "plans.feature.dailySignal",
  secondOrder: "plans.feature.secondOrder",
  reports: "plans.feature.reports",
  graph: "plans.feature.graph",
  newsMonitoring: "plans.feature.newsMonitoring",
  agents: "plans.feature.agents",
  support: "plans.feature.support",
};

/** A comparison row's label, by the feature's key; the site's English when it has none here. */
export function featureLabel(feature: { key: string; label: string }, t: TFunction): string {
  const key = FEATURE_KEYS[feature.key];
  return key ? t(key) : feature.label;
}
