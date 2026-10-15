import type { MessageKey } from "./i18n/messages";
import type { MessageVars } from "./i18n/translate";

/**
 * The engine's event types, as words a reader sees: the news classifier's set
 * (`shared/news-events.ts`) and the classifier spec's set
 * (`shared/classifier-types.ts`). A type neither knows reads as the engine
 * wrote it, underscores turned to spaces, rather than as nothing.
 */
const EVENT_TYPE_KEY: Readonly<Record<string, MessageKey>> = {
  earnings: "dashboard.eventType.earnings",
  guidance: "dashboard.eventType.guidance",
  supply_disruption: "dashboard.eventType.supply_disruption",
  product_launch: "dashboard.eventType.product_launch",
  regulatory: "dashboard.eventType.regulatory",
  partnership: "dashboard.eventType.partnership",
  acquisition: "dashboard.eventType.acquisition",
  litigation: "dashboard.eventType.litigation",
  management_change: "dashboard.eventType.management_change",
  other: "dashboard.eventType.other",
  earnings_results: "dashboard.eventType.earnings_results",
  analyst_action: "dashboard.eventType.analyst_action",
  ma_activity: "dashboard.eventType.ma_activity",
  capital_allocation: "dashboard.eventType.capital_allocation",
  financing_credit: "dashboard.eventType.financing_credit",
  product_clinical: "dashboard.eventType.product_clinical",
  regulatory_decision: "dashboard.eventType.regulatory_decision",
  legal: "dashboard.eventType.legal",
  management_governance: "dashboard.eventType.management_governance",
  contract_partnership: "dashboard.eventType.contract_partnership",
  supply_chain_ops: "dashboard.eventType.supply_chain_ops",
  macro_sector: "dashboard.eventType.macro_sector",
  ownership_flows: "dashboard.eventType.ownership_flows",
};

export function eventTypeLabel(type: string, t: (key: MessageKey, vars?: MessageVars) => string): string {
  const key = Object.prototype.hasOwnProperty.call(EVENT_TYPE_KEY, type) ? EVENT_TYPE_KEY[type] : undefined;
  return key ? t(key) : type.replace(/_/g, " ");
}
