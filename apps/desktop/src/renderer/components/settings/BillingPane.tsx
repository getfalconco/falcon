import { useEffect, useId, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { ArrowUpRight } from "lucide-react";
import PlansModal from "@/components/plans/PlansModal";
import {
  MEMBERSHIP_URL,
  PLANS,
  PLAN_FEATURES,
  currentPlanFromAppMetadata,
  planPrice,
  type CurrentPlan,
} from "../../../shared/plans";
import { currentPlanLabel, featureValueText } from "@/components/plans/plan-names";
import { getMembership } from "@/lib/waitlist-api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BUTTON } from "./pane-kit";

/**
 * Billing: the plan the account is on, then payment and invoices, laid out the
 * way a billing page usually is, and filled only with what is true.
 *
 * There is no billing system anywhere in the repo: no Stripe, no subscription
 * table, no payment methods, no invoices, nothing in the site's API that takes
 * money. What an account does carry is `app_metadata` (approval and an invited
 * role), written only by the site's service role, and shared/plans reads the
 * current plan from it. So the plan header is real, the member date comes from
 * the same membership lookup the plan tickets use, and Payment and Invoices
 * say plainly that there is nothing here. The plan list itself is PlansModal's,
 * opened from "Adjust plan" rather than drawn again.
 */

const TITLE = "text-[15px] font-medium text-content-primary";
const NOTE = "text-[12.5px] font-normal leading-snug text-content-secondary";
const HEAD = "border-b border-black/[0.06] pb-2 text-[12px] font-normal text-content-secondary";

/**
 * The plan's glyph: a line-drawn admission ticket, the shape the membership
 * tickets take, with one pip on the stub per rank (Early Access one, Platinum
 * four) and a ring for an internal role. Drawn in currentColor, so it follows
 * the text colour in both themes.
 */
function PlanGlyph({ current }: { current: CurrentPlan | null }) {
  const rank = current?.kind === "plan" ? PLANS.findIndex((p) => p.key === current.key) + 1 : 0;
  const pips = Array.from({ length: rank }, (_, i) => 20 + (i - (rank - 1) / 2) * 3.2);
  return (
    <svg
      viewBox="0 0 40 40"
      width={44}
      height={44}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-content-primary"
    >
      <g transform="rotate(-8 20 20)">
        <path d="M4 13a3 3 0 0 0 3-3h26a3 3 0 0 0 3 3v14a3 3 0 0 0-3 3H7a3 3 0 0 0-3-3Z" />
        <path d="M27 13.5v13" strokeDasharray="1.4 2" />
        <path d="M9 18h12M9 22.5h8" opacity={0.55} />
        {current?.kind === "staff" ? (
          <circle cx={31.5} cy={20} r={2} />
        ) : (
          pips.map((y) => <circle key={y} cx={31.5} cy={y} r={0.9} fill="currentColor" stroke="none" />)
        )}
      </g>
    </svg>
  );
}

export default function BillingPane({ user = null }: { user?: User | null }) {
  const [plansOpen, setPlansOpen] = useState(false);
  const [grantedAt, setGrantedAt] = useState<string | null>(null);
  const { t, locale } = useI18n();
  const invoicesId = useId();

  // Settings closes on Esc from a window listener too. While the plans sit on
  // top, Esc should close only them, so it is caught first and goes no further.
  useEffect(() => {
    if (!plansOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setPlansOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [plansOpen]);

  // The member date: the same lookup that prints it on the plan tickets. No
  // renewal date exists anywhere (nothing renews), so this is the only date
  // the header can honestly carry, and it is left out until the lookup finds one.
  const email = user?.email ?? "";
  useEffect(() => {
    setGrantedAt(null);
    if (!email) return;
    let live = true;
    void getMembership().then((m) => {
      if (live && m.found) setGrantedAt(m.grantedAt);
    });
    return () => {
      live = false;
    };
  }, [email]);

  const current = user ? currentPlanFromAppMetadata(user.app_metadata) : null;
  const plan = current?.kind === "plan" ? PLANS.find((p) => p.key === current.key) ?? null : null;
  const companies = plan ? PLAN_FEATURES.find((f) => f.key === "trackedCompanies")?.values[plan.key] : undefined;

  const summary = plan
    ? t("plans.billing.summary", {
        companies: companies === undefined ? "" : featureValueText(companies, t),
        price: `$${planPrice(plan)}`,
      })
    : current?.kind === "staff"
      ? t("plans.billing.staffSummary")
      : null;

  const memberSince = (() => {
    if (!grantedAt) return null;
    const d = new Date(grantedAt);
    if (Number.isNaN(d.getTime())) return null;
    const date = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(d);
    return t("plans.billing.memberSince", { date });
  })();

  return (
    <>
      <section
        aria-label={t("plans.billing.planLabel")}
        className="flex items-center gap-4 border-b border-black/[0.06] pb-6"
      >
        <PlanGlyph current={current} />
        <div className="min-w-0 flex-1">
          <div className={cn("text-[15px] font-medium", current ? "text-content-primary" : "text-content-tertiary")}>
            {current ? currentPlanLabel(current, t) : t("settings.account.notSignedIn")}
          </div>
          {summary ? <p className="mt-1 text-[12.5px] font-normal leading-snug text-content-body">{summary}</p> : null}
          {memberSince ? <p className="mt-0.5 text-[12px] font-normal text-content-tertiary">{memberSince}</p> : null}
        </div>
        <button type="button" className={`${BUTTON} shrink-0`} onClick={() => setPlansOpen(true)}>
          {t("plans.billing.adjust")}
        </button>
      </section>

      <section className="flex items-start justify-between gap-6 border-b border-black/[0.06] py-6">
        <div className="min-w-0">
          <h2 className={TITLE}>{t("plans.billing.payment")}</h2>
          <p className={`mt-1 ${NOTE}`}>{t("plans.billing.paymentNote")}</p>
        </div>
        <button
          type="button"
          className={`${BUTTON} flex shrink-0 items-center gap-1.5`}
          onClick={() => void window.meridian?.openExternal(MEMBERSHIP_URL)}
        >
          {t("plans.billing.membershipPage")}
          <ArrowUpRight className="h-3.5 w-3.5 text-content-secondary" strokeWidth={1.75} aria-hidden />
        </button>
      </section>

      <section className="pt-6">
        <h2 id={invoicesId} className={TITLE}>
          {t("plans.billing.invoices")}
        </h2>
        <table aria-labelledby={invoicesId} className="mt-3 w-full table-fixed text-left">
          <thead>
            <tr>
              <th scope="col" className={`${HEAD} w-[34%]`}>
                {t("plans.billing.date")}
              </th>
              <th scope="col" className={`${HEAD} w-[22%]`}>
                {t("plans.billing.total")}
              </th>
              <th scope="col" className={`${HEAD} w-[22%]`}>
                {t("plans.billing.status")}
              </th>
              <th scope="col" className={`${HEAD} text-right`}>
                {t("plans.billing.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={4} className="py-6 text-center text-[12.5px] font-normal text-content-tertiary">
                {t("plans.billing.noInvoices")}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <PlansModal open={plansOpen} onClose={() => setPlansOpen(false)} user={user} />
    </>
  );
}
