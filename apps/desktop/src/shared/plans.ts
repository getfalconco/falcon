/**
 * Falcon's membership plans, as the desktop shows them in "View All Plans".
 *
 * Copied from the website — keep in sync with
 *   apps/web/app/components/TierTickets.tsx  (TIERS, FEATURES, ANNUAL_DISCOUNT)
 *   apps/web/app/membership/page.tsx         (which tiers the page lists)
 *   apps/web/app/membership/[tier]/page.tsx  (the per-plan page a CTA lands on)
 * The renderer and the main process both read this file: the renderer for the
 * cards, the main process for the only URLs a plan button may open.
 */

/** The public plans, cheapest first. Order is rank: later means higher. */
export type PlanKey = "early" | "silver" | "gold" | "platinum";

/** Internal roles the site grants through invites (`app_metadata.role`). */
export type StaffRole = "staff" | "deputy" | "leader" | "talent_manager";

export type Billing = "monthly" | "annual";

/** The colours of a plan's generative ticket, as the site paints it. */
export type TicketColors = {
  colorBack: string;
  colorFront: string;
  colorHighlight: string;
  inkColor: string;
  watermarkColor: string;
  /** Faded mono labels (top block + member line). */
  labelColor: string;
  /** Big centre text. */
  nameColor: string;
};

export type Plan = {
  key: PlanKey;
  label: string;
  /** Monthly list price in USD; annual billing applies ANNUAL_DISCOUNT. */
  priceMonthly: number;
  ticket: TicketColors;
};

export const PLANS: readonly Plan[] = [
  {
    key: "early",
    label: "Early Access",
    priceMonthly: 9,
    ticket: {
      colorBack: "#05262f",
      colorFront: "#0f7d92",
      colorHighlight: "#4fd8e6",
      inkColor: "#c2eff5",
      watermarkColor: "#0d4a58",
      labelColor: "#5aa3b2",
      nameColor: "#c2eff5",
    },
  },
  {
    key: "silver",
    label: "Silver",
    priceMonthly: 19,
    ticket: {
      colorBack: "#c6ccd4",
      colorFront: "#eef1f5",
      colorHighlight: "#9aa3ae",
      inkColor: "#4a5560",
      watermarkColor: "#aeb6bf",
      labelColor: "#7a8593",
      nameColor: "#3d4650",
    },
  },
  {
    key: "gold",
    label: "Gold",
    priceMonthly: 49,
    ticket: {
      colorBack: "#d19b16",
      colorFront: "#f6d878",
      colorHighlight: "#ffe9a8",
      inkColor: "#6b4e08",
      watermarkColor: "#e8c95f",
      labelColor: "#a87e14",
      nameColor: "#5f4506",
    },
  },
  {
    key: "platinum",
    label: "Platinum",
    priceMonthly: 99,
    ticket: {
      colorBack: "#1a1d21",
      colorFront: "#3d424a",
      colorHighlight: "#e8ebf0",
      inkColor: "#eef1f5",
      watermarkColor: "#31353c",
      labelColor: "#7d848e",
      nameColor: "#f2f4f7",
    },
  },
];

/** The internal roles' tickets — shown in place of a plan for staff accounts. */
export const STAFF_TICKETS: Readonly<Record<StaffRole, { label: string; ticket: TicketColors }>> = {
  staff: {
    label: "Staff",
    ticket: {
      colorBack: "#0d2e1c",
      colorFront: "#2f7d4f",
      colorHighlight: "#8ee6a8",
      inkColor: "#dcf7e4",
      watermarkColor: "#164a2c",
      labelColor: "#71a888",
      nameColor: "#e8fff0",
    },
  },
  deputy: {
    label: "Deputy",
    ticket: {
      colorBack: "#5c2a06",
      colorFront: "#c26a15",
      colorHighlight: "#ffc987",
      inkColor: "#ffe6cc",
      watermarkColor: "#7d3d0c",
      labelColor: "#c99163",
      nameColor: "#fff1e2",
    },
  },
  leader: {
    label: "Leader",
    ticket: {
      colorBack: "#4d0f14",
      colorFront: "#b02f33",
      colorHighlight: "#ffa8a0",
      inkColor: "#ffdedb",
      watermarkColor: "#6e191d",
      labelColor: "#c88079",
      nameColor: "#ffeceb",
    },
  },
  talent_manager: {
    label: "Talent Manager",
    ticket: {
      colorBack: "#1a2438",
      colorFront: "#3d5a8a",
      colorHighlight: "#9ec0ff",
      inkColor: "#e4edff",
      watermarkColor: "#243456",
      labelColor: "#7a93b8",
      nameColor: "#eef4ff",
    },
  },
};

/**
 * The site's comparison matrix. `true` → included, `false` → not included,
 * a string → the plan's own value.
 */
export const PLAN_FEATURES: ReadonlyArray<{
  /** Stable id, for the renderer's translation of the label. */
  key: string;
  label: string;
  values: Readonly<Record<PlanKey, string | boolean>>;
}> = [
  { key: "trackedCompanies", label: "Tracked companies", values: { early: "3", silver: "5", gold: "25", platinum: "Unlimited" } },
  { key: "dailySignal", label: "Daily top signal", values: { early: true, silver: true, gold: true, platinum: true } },
  { key: "secondOrder", label: "Second-order signals", values: { early: false, silver: false, gold: true, platinum: true } },
  {
    key: "reports",
    label: "Company reports",
    values: { early: "Standard", silver: "Standard", gold: "Deep", platinum: "Institutional" },
  },
  { key: "graph", label: "Relationship graph", values: { early: false, silver: "Core", gold: "Full", platinum: "Full + history" } },
  { key: "newsMonitoring", label: "24/7 news monitoring", values: { early: false, silver: false, gold: true, platinum: true } },
  { key: "agents", label: "Tracking agents", values: { early: false, silver: false, gold: "3", platinum: "Unlimited" } },
  { key: "support", label: "Priority support", values: { early: false, silver: false, gold: false, platinum: true } },
];

/** Annual billing takes 20% off the monthly rate. */
export const ANNUAL_DISCOUNT = 0.2;

/** Monthly-equivalent price in whole dollars for the chosen billing period. */
export function planPrice(plan: Plan, billing: Billing = "monthly"): number {
  return billing === "annual" ? Math.round(plan.priceMonthly * (1 - ANNUAL_DISCOUNT)) : plan.priceMonthly;
}

/**
 * Where a plan's button leads. The site has no checkout or billing portal
 * yet: each plan has its own page (which remembers the choice for sign-up),
 * and Early Access has its application page. Fixed https URLs on purpose —
 * the main process opens nothing else for a plan.
 */
export const MEMBERSHIP_URL = "https://getfalcon.co/membership";
export const PLAN_URLS: Readonly<Record<PlanKey, string>> = {
  early: "https://getfalcon.co/early-access",
  silver: "https://getfalcon.co/membership/silver",
  gold: "https://getfalcon.co/membership/gold",
  platinum: "https://getfalcon.co/membership/platinum",
};

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && PLANS.some((p) => p.key === value);
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STAFF_TICKETS, value);
}

/** What the signed-in account is on. */
export type CurrentPlan = { kind: "plan"; key: PlanKey } | { kind: "staff"; role: StaffRole };

/**
 * There are no paid subscriptions anywhere yet (no Stripe, no subscriptions
 * table). What an account does carry is `app_metadata` — written only by the
 * site's service role, so it cannot be self-assigned: an invited internal
 * role, or `approved`, which is how every member got in through the early
 * access programme. So: a role reads as that role, anyone else as Early
 * Access. Once a real plan is recorded, read it here.
 */
export function currentPlanFromAppMetadata(appMetadata: Record<string, unknown> | null | undefined): CurrentPlan {
  const role = typeof appMetadata?.role === "string" ? appMetadata.role.trim().toLowerCase() : null;
  if (isStaffRole(role)) return { kind: "staff", role };
  return { kind: "plan", key: "early" };
}

/** How a plan stands against the current one. */
export function planChange(current: PlanKey, target: PlanKey): "current" | "upgrade" | "downgrade" {
  const rank = (key: PlanKey) => PLANS.findIndex((p) => p.key === key);
  const diff = rank(target) - rank(current);
  return diff === 0 ? "current" : diff > 0 ? "upgrade" : "downgrade";
}
