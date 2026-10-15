import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Minus, X } from "lucide-react";
import type { User as AuthUser } from "@supabase/supabase-js";
import { cn } from "@/lib/utils";
import { displayNameFromUser } from "@/lib/greeting";
import { getMembership } from "@/lib/waitlist-api";
import AdmitOneTicket, { TICKET_LAYOUT, TICKET_TEXTURE } from "@/components/ui/admit-one-ticket";
import { grantedLabel, memberLabel } from "@/components/WaitlistTicket";
import { useI18n, useT } from "@/lib/i18n";
import { currentPlanLabel, featureLabel, featureValueText, roleLabel, roleTicketName } from "./plan-names";
import {
  ANNUAL_DISCOUNT,
  PLAN_FEATURES,
  PLANS,
  PLAN_URLS,
  STAFF_TICKETS,
  currentPlanFromAppMetadata,
  planChange,
  planPrice,
  type Billing,
  type CurrentPlan,
  type Plan,
  type PlanKey,
  type TicketColors,
} from "../../../shared/plans";

/**
 * "View All Plans", opened from the account pill (and, later, Settings →
 * Billing). The same tickets the website's membership page sells, side by
 * side, with the reader's own plan marked and every other one offering the
 * way there: up is Upgrade, down is Downgrade.
 *
 * The app never takes a payment. A plan button asks the main process to open
 * that plan's page on getfalcon.co in the browser (see main/plans); the page
 * is looked up there from a fixed table, so the renderer only names a plan.
 */

const GEIST = "var(--font-geist-sans), sans-serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Same arrival as the settings panel: a fade, at the size it will keep. */
const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

/** The site's layout tweak: the big tier line sits a touch lower. */
const BASE_LAYOUT = { ...TICKET_LAYOUT, nameTop: 220 / 741 };

/** Gap between the cards, in px — the ticket width is measured from it. */
const GAP = 12;
/** A card's horizontal padding, in px (px-4). */
const CARD_PAD = 16;

const UNKNOWN_MEMBER = { memberNumber: null as number | null, grantedAt: null as string | null };

// The vendored ticket has no font or per-row colour props, so its rows are
// targeted by class — the same trick the site and the waitlist ticket use.
function ticketCss(key: string, t: TicketColors): string {
  return `
.plan-tk-${key} div.whitespace-pre,
.plan-tk-${key} div.whitespace-nowrap:not(.grid) {
  font-family: var(--font-geist-mono), monospace;
  color: ${t.labelColor};
}
.plan-tk-${key} div.font-medium:not(.grid) {
  color: ${t.nameColor};
  text-align: left;
}
.plan-tk-${key} .will-change-transform {
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1) !important;
}`;
}

const TICKET_CSS = [
  ...PLANS.map((p) => ticketCss(p.key, p.ticket)),
  ...Object.entries(STAFF_TICKETS).map(([role, s]) => ticketCss(role, s.ticket)),
].join("\n");

function Ticket({
  cssKey,
  name,
  colors,
  presenter,
  venue,
  dates,
  width,
}: {
  cssKey: string;
  name: string;
  colors: TicketColors;
  presenter: string;
  venue: string;
  dates: string;
  width: number;
}) {
  return (
    <div
      className={`plan-tk-${cssKey} flex justify-center`}
      style={{ filter: "drop-shadow(0 6px 14px rgba(8, 12, 18, 0.28))", fontFamily: GEIST }}
    >
      <AdmitOneTicket
        tilt={{}}
        name={name}
        presenter={presenter}
        event=""
        venue={venue}
        dates={dates}
        stubText="Admit one"
        watermark="2026"
        width={width}
        texture={{
          ...TICKET_TEXTURE,
          colorBack: colors.colorBack,
          colorFront: colors.colorFront,
          colorHighlight: colors.colorHighlight,
        }}
        layout={{ ...BASE_LAYOUT, inkColor: colors.inkColor, watermarkColor: colors.watermarkColor }}
      />
    </div>
  );
}

/** Monthly / Annual, as on the site: a segmented control with a sliding pill. */
function BillingToggle({ billing, onChange }: { billing: Billing; onChange: (next: Billing) => void }) {
  const t = useT();
  const options: { key: Billing; label: string }[] = [
    { key: "monthly", label: t("plans.monthly") },
    { key: "annual", label: t("plans.annual") },
  ];
  return (
    <div
      role="group"
      aria-label={t("plans.billingPeriod")}
      className="flex w-fit items-center gap-0.5 rounded-full border border-white/60 bg-white/40 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]"
    >
      {options.map((o) => {
        const on = billing === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={cn(
              "app-no-drag relative rounded-full px-3.5 py-1 text-[12.5px] font-normal transition-colors",
              on ? "text-[#1d1b1b]" : "text-[#6b7280] hover:text-[#1d1b1b]",
            )}
          >
            {on ? (
              <motion.span
                layoutId="plans-billing-pill"
                aria-hidden
                className="absolute inset-0 rounded-full bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-1 ring-black/[0.06]"
                transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {o.label}
              {o.key === "annual" ? (
                <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[#9CA3AF]">
                  {t("plans.save", { percent: Math.round(ANNUAL_DISCOUNT * 100) })}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const CARD =
  "relative flex min-w-0 flex-col rounded-2xl border px-4 pb-4 pt-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1";
const CARD_REST = "border-white/60 bg-white/40 ring-black/[0.04]";
const CARD_CURRENT = "border-white/70 bg-white/60 ring-black/[0.1]";

const BUTTON = "app-no-drag flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[13px] transition-colors";

function CurrentBadge() {
  const t = useT();
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-[#1d1b1b]/[0.07] px-2 py-0.5 text-[10.5px] font-medium tracking-[0.02em] text-[#1d1b1b]">
      {t("plans.current")}
    </span>
  );
}

function FeatureList({ planKey }: { planKey: PlanKey }) {
  const t = useT();
  return (
    <ul className="space-y-[6px]">
      {PLAN_FEATURES.map((f) => {
        const v = f.values[planKey];
        const off = v === false;
        return (
          <li key={f.key} className="flex items-baseline justify-between gap-2 text-[12px] leading-[17px]">
            <span className={cn("min-w-0", off ? "text-[#b4b4ae]" : "text-[#4b5563]")}>{featureLabel(f, t)}</span>
            {v === true ? (
              <Check
                className="h-3.5 w-3.5 shrink-0 self-center text-[#1d1b1b]"
                strokeWidth={2}
                aria-label={t("plans.included")}
              />
            ) : off ? (
              <Minus
                className="h-3.5 w-3.5 shrink-0 self-center text-[#b4b4ae]"
                strokeWidth={2}
                aria-label={t("plans.notIncluded")}
              />
            ) : (
              <span className="whitespace-nowrap text-right font-medium text-[#1d1b1b]">{featureValueText(v, t)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Price and billing period on one line; the period sits at the right edge. */
function PriceLine({ plan, billing }: { plan: Plan; billing: Billing }) {
  const t = useT();
  return (
    <div className="mt-1.5 flex items-baseline gap-1">
      <span className="text-[22px] font-medium tabular-nums leading-none tracking-[-0.01em] text-[#1d1b1b]">
        ${planPrice(plan, billing)}
      </span>
      <span className="text-[12px] text-[#6b7280]">{t("plans.perMonth")}</span>
      <span className="ml-auto truncate text-[11px] text-[#9CA3AF]">
        {billing === "annual" ? t("plans.billedAnnually") : t("plans.billedMonthly")}
      </span>
    </div>
  );
}

function openPlan(key: PlanKey): void {
  const bridge = window.meridian?.openPlanPage;
  if (bridge) {
    void bridge(key);
    return;
  }
  // No plan-aware bridge (an older preload): the generic opener, same fixed URL.
  void window.meridian?.openExternal(PLAN_URLS[key]);
}

export default function PlansModal({
  open,
  onClose,
  user = null,
  current: currentOverride,
}: {
  open: boolean;
  onClose: () => void;
  /** The signed-in user: whose ticket this is, and which plan it is on. */
  user?: AuthUser | null;
  /** Overrides the plan read from `user` (preview harness). */
  current?: CurrentPlan;
}) {
  const [billing, setBilling] = useState<Billing>("monthly");
  const [member, setMember] = useState(UNKNOWN_MEMBER);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const { t, tNodes } = useI18n();

  const current = useMemo<CurrentPlan>(
    () => currentOverride ?? currentPlanFromAppMetadata(user?.app_metadata),
    [currentOverride, user],
  );
  const email = user?.email ?? "";
  const fullName = displayNameFromUser(user?.user_metadata, email).trim() || "Member";

  // Staff see their role's ticket where a plan would be, then the paid plans.
  const plans = current.kind === "staff" ? PLANS.filter((p) => p.key !== "early") : PLANS;
  const cards = plans.length + (current.kind === "staff" ? 1 : 0);
  const ticketWidth = gridWidth
    ? Math.max(120, Math.floor((gridWidth - GAP * (cards - 1)) / cards - CARD_PAD * 2))
    : 0;

  // Esc closes; the page behind never scrolls under the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // The member line on the tickets: the reader's number and grant date, from
  // the site's membership lookup (the signed-in user's own, by session token,
  // keyed on the email only so it re-runs on an account switch). Until it
  // answers the tickets read "#———".
  useEffect(() => {
    if (!open || !email) return;
    let live = true;
    void getMembership().then((m) => {
      if (live && m.found) setMember({ memberNumber: m.memberNumber, grantedAt: m.grantedAt });
    });
    return () => {
      live = false;
    };
  }, [open, email]);

  // The ticket is drawn at a pixel width, so it follows the card's.
  useLayoutEffect(() => {
    if (!open) return;
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setGridWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  const venue = `Member ${memberLabel(member.memberNumber)}`;
  const currentLabel = currentPlanLabel(current, t);
  const rise = (i: number) => ({
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { delay: 0.06 + i * 0.05, duration: 0.42, ease: EASE_OUT },
  });

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="plans" className="fixed inset-0 z-[95] flex items-center justify-center">
          <style>{TICKET_CSS}</style>
          {/* Backdrop — the dashboard blurs away behind the panel. */}
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t("plans.dialog")}
            className="app-no-drag relative flex h-[min(720px,calc(100vh-48px))] w-[min(1100px,calc(100vw-48px))] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            {...PANEL_FADE}
          >
            {/* The strip along the top still drags the window, since the
                panel covers the app's own; the close button sits above it. */}
            <div className="app-drag-region absolute inset-x-0 top-0 h-12" aria-hidden />

            {/* Never scrolls: sized to fit the panel at the smallest window
                (1200 x 680, where the panel is at its widest and shortest),
                any spare height shared above and below the content. Every
                language is measured to fit there with room for one wrapped
                feature row (`__plans.measure()` in the preview harness);
                overflow-hidden is only a last guard. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-7 pb-6 pt-6">
              <div className="my-auto">
                <header className="flex items-end justify-between gap-6 pr-8">
                  <div className="min-w-0">
                    <h2 className="font-baskerville text-[22px] font-normal leading-[1.25] text-[#1d1b1b]">
                      {t("plans.title")}
                    </h2>
                    <p className="mt-1.5 text-[13px] font-normal text-[#6b7280]">
                      {tNodes(current.kind === "staff" ? "plans.youreOnStaff" : "plans.youreOn", {
                        plan: <span className="text-[#1d1b1b]">{currentLabel}</span>,
                      })}
                    </p>
                  </div>
                  <div className="app-no-drag relative shrink-0">
                    <BillingToggle billing={billing} onChange={setBilling} />
                  </div>
                </header>

                <div
                  ref={gridRef}
                  className="mt-6 grid"
                  style={{ gridTemplateColumns: `repeat(${cards}, minmax(0, 1fr))`, gap: GAP }}
                >
                  {current.kind === "staff" ? (
                    <motion.div {...rise(0)} className={cn(CARD, CARD_CURRENT)}>
                      {ticketWidth ? (
                        <Ticket
                          cssKey={current.role}
                          name={roleTicketName(current.role)}
                          colors={STAFF_TICKETS[current.role].ticket}
                          presenter={fullName}
                          venue={venue}
                          dates={grantedLabel(member.grantedAt)}
                          width={ticketWidth}
                        />
                      ) : null}
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <span
                          title={roleLabel(current.role, t)}
                          className="truncate font-baskerville text-[16px] text-[#1d1b1b]"
                        >
                          {roleLabel(current.role, t)}
                        </span>
                        <CurrentBadge />
                      </div>
                      <p className="mt-2 text-[12px] leading-[17px] text-[#6b7280]">
                        {t("plans.granted", { role: roleLabel(current.role, t) })}
                      </p>
                    </motion.div>
                  ) : null}

                  {plans.map((plan, i) => {
                    const change = current.kind === "plan" ? planChange(current.key, plan.key) : null;
                    const isCurrent = change === "current";
                    return (
                      <motion.div
                        key={plan.key}
                        {...rise(i + (current.kind === "staff" ? 1 : 0))}
                        className={cn(CARD, isCurrent ? CARD_CURRENT : CARD_REST)}
                      >
                        {ticketWidth ? (
                          <Ticket
                            cssKey={plan.key}
                            name={plan.label}
                            colors={plan.ticket}
                            presenter={fullName}
                            venue={venue}
                            dates={isCurrent ? grantedLabel(member.grantedAt) : "2026"}
                            width={ticketWidth}
                          />
                        ) : null}

                        <div className="mt-3 flex items-center justify-between gap-2">
                          <span className="truncate font-baskerville text-[16px] text-[#1d1b1b]">{plan.label}</span>
                          {isCurrent ? <CurrentBadge /> : null}
                        </div>
                        <PriceLine plan={plan} billing={billing} />

                        <div className="mt-3.5">
                          {isCurrent ? (
                            <button type="button" disabled className={cn(BUTTON, "cursor-default bg-black/[0.04] text-[#9CA3AF]")}>
                              {t("plans.current")}
                            </button>
                          ) : change === "upgrade" ? (
                            <button
                              type="button"
                              onClick={() => openPlan(plan.key)}
                              className={cn(BUTTON, "bg-[#1d1b1b] text-white shadow-[0_2px_10px_rgba(0,0,0,0.12)] hover:bg-black")}
                            >
                              {t("plans.upgrade")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openPlan(plan.key)}
                              className={cn(
                                BUTTON,
                                "btn-quiet border border-white/60 bg-white/55 text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] hover:bg-white/80",
                              )}
                            >
                              {change === "downgrade" ? t("plans.downgrade") : t("plans.view")}
                            </button>
                          )}
                        </div>

                        <div aria-hidden className="my-4 h-px bg-black/[0.06]" />
                        <FeatureList planKey={plan.key} />
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label={t("plans.close")}
              className="app-no-drag absolute right-4 top-4 rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
