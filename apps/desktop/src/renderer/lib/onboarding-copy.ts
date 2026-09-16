import type {
  ExperienceLevel,
  SectorId,
  SignalFormat,
} from "../../shared/user-preferences";
import type {
  InvestorRole,
  ResearchFocus,
  UpdateFrequency,
} from "../../shared/onboarding-survey";

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

export const EXPERIENCE_OPTIONS: {
  id: ExperienceLevel;
  label: string;
  acknowledgment: string;
  depthLabel: string;
}[] = [
  {
    id: "new",
    label: "New to investing",
    acknowledgment: "We'll explain the terms as they come up. No noise, no assumptions.",
    depthLabel: "We'll explain as we go",
  },
  {
    id: "one_to_three_years",
    label: "1-3 years",
    acknowledgment: "We'll keep it sharp. Context when it matters, not when it doesn't.",
    depthLabel: "Sharp, context when it matters",
  },
  {
    id: "three_to_ten_years",
    label: "3-10 years",
    acknowledgment: "No hand-holding. Straight to the signal.",
    depthLabel: "Straight to the signal",
  },
  {
    id: "ten_plus_pro",
    label: "10+ years / professional",
    acknowledgment: "Full precision, no simplification. You'll see the reasoning we see.",
    depthLabel: "Full precision, no simplification",
  },
];

export const INVESTOR_ROLE_OPTIONS: { id: InvestorRole; label: string; subtitle?: string }[] = [
  { id: "active_trader", label: "Active trader", subtitle: "I trade weekly, sometimes daily" },
  { id: "long_term_investor", label: "Long-term investor", subtitle: "I build positions and hold" },
  { id: "market_researcher", label: "Market researcher", subtitle: "I analyze more than I trade" },
  { id: "getting_serious", label: "Getting serious", subtitle: "I'm leveling up from casual investing" },
  {
    id: "finance_professional",
    label: "Finance professional",
    subtitle: "I work in or around the industry",
  },
  { id: "other", label: "Other" },
];

export const RESEARCH_FOCUS_OPTIONS: { id: ResearchFocus; label: string }[] = [
  { id: "individual_stocks", label: "Individual stocks" },
  { id: "sectors_industries", label: "Sectors/industries" },
  { id: "macro_trends", label: "Macro trends" },
  { id: "companies_i_hold", label: "Specific companies I already hold" },
];

export const UPDATE_FREQUENCY_OPTIONS: { id: UpdateFrequency; label: string }[] = [
  { id: "daily_brief", label: "Daily brief" },
  { id: "real_time", label: "Real-time on major events" },
  { id: "weekly_summary", label: "Weekly summary only" },
];

export const FORMAT_OPTIONS: {
  id: SignalFormat;
  label: string;
  acknowledgment: string;
}[] = [
  {
    id: "takeaway",
    label: "Just the takeaway",
    acknowledgment:
      "Short and direct. The move, the mechanism, whether it's priced in. Nothing more.",
  },
  {
    id: "full",
    label: "The full reasoning",
    acknowledgment: "The full trace. Every step from the event to the companies it touches.",
  },
];

/** Mechanism-only previews: no tickers, prices, or figures. */
export const SECTOR_PREVIEWS: Record<SectorId, string> = {
  technology:
    "Last quarter, a quiet shift in one platform's API terms rippled into three adjacent software stacks before headlines caught up. This is the kind of move Falcon traces for you.",
  semiconductors:
    "Last month, a delay in one fab's output moved three suppliers before the market connected them. This is the kind of move Falcon traces for you.",
  energy:
    "A midstream bottleneck can reprice downstream producers days before the spot market reacts. This is the kind of move Falcon traces for you.",
  healthcare:
    "A reimbursement tweak rarely hits the headline company first. It lands on the suppliers and service layers around it. This is the kind of move Falcon traces for you.",
  financials:
    "A capital-rule change can compress one segment's margins while opening another before most desks reprice the chain. This is the kind of move Falcon traces for you.",
  consumer:
    "A quiet shift in channel inventory can move manufacturers before retailers report. This is the kind of move Falcon traces for you.",
  industrials:
    "A capacity constraint at one node often shows up in peer utilization and supplier lead times first. This is the kind of move Falcon traces for you.",
  crypto:
    "A custody or settlement change can reprice adjacent infrastructure names before the token narrative catches up. This is the kind of move Falcon traces for you.",
};
