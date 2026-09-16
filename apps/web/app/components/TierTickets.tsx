"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, X } from "lucide-react";
import GetStartedButton from "./GetStartedButton";
import {
  COUNTRIES,
  DEFAULT_COUNTRY_ISO,
  formatPhone,
  normalizePhoneDigits,
} from "./country-codes";
import {
  TICKET_HOVER_EASE_CSS,
  TICKET_HOVER_MS,
  TICKET_HOVER_SCALE,
} from "@meridian/ui";
import AdmitOneTicket, {
  TICKET_TEXTURE,
  TICKET_LAYOUT,
} from "./ui/admit-one-ticket";

const MONO = "var(--font-geist-mono), monospace";

// Measure before paint on the client so the ticket never renders at the
// desktop width first (that flash also made framer animate the size change).
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

// Shared layout tweak (big tier line sits a touch lower, like the waitlist
// ticket).
const BASE_LAYOUT = { ...TICKET_LAYOUT, nameTop: 220 / 741 };

type Tier = {
  key: string;
  label: string;
  /** Big centre text — the component stacks one word per line. */
  name: string;
  texture: typeof TICKET_TEXTURE;
  layout: typeof BASE_LAYOUT;
  /** Faded mono labels (top block + member line). */
  labelColor: string;
  /** Big centre text colour. */
  nameColor: string;
  /** Monthly list price in USD; annual billing applies ANNUAL_DISCOUNT. */
  priceMonthly: number;
};

export const TIERS: Tier[] = [
  {
    key: "early",
    label: "Early Access",
    name: "Early Access",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#05262f",
      colorFront: "#0f7d92",
      colorHighlight: "#4fd8e6",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#c2eff5", watermarkColor: "#0d4a58" },
    labelColor: "#5aa3b2",
    nameColor: "#c2eff5",
    priceMonthly: 9,
  },
  {
    key: "silver",
    label: "Silver",
    name: "Silver",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#c6ccd4",
      colorFront: "#eef1f5",
      colorHighlight: "#9aa3ae",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#4a5560", watermarkColor: "#aeb6bf" },
    labelColor: "#7a8593",
    nameColor: "#3d4650",
    priceMonthly: 19,
  },
  {
    key: "gold",
    label: "Gold",
    name: "Gold",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#d19b16",
      colorFront: "#f6d878",
      colorHighlight: "#ffe9a8",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#6b4e08", watermarkColor: "#e8c95f" },
    labelColor: "#a87e14",
    nameColor: "#5f4506",
    priceMonthly: 49,
  },
  {
    key: "platinum",
    label: "Platinum",
    name: "Platinum",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#1a1d21",
      colorFront: "#3d424a",
      colorHighlight: "#e8ebf0",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#eef1f5", watermarkColor: "#31353c" },
    labelColor: "#7d848e",
    nameColor: "#f2f4f7",
    priceMonthly: 99,
  },
  {
    key: "staff",
    label: "Staff",
    name: "Staff",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#0d2e1c",
      colorFront: "#2f7d4f",
      colorHighlight: "#8ee6a8",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#dcf7e4", watermarkColor: "#164a2c" },
    labelColor: "#71a888",
    nameColor: "#e8fff0",
    priceMonthly: 0,
  },
  {
    key: "deputy",
    label: "Deputy",
    name: "Deputy",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#5c2a06",
      colorFront: "#c26a15",
      colorHighlight: "#ffc987",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#ffe6cc", watermarkColor: "#7d3d0c" },
    labelColor: "#c99163",
    nameColor: "#fff1e2",
    priceMonthly: 0,
  },
  {
    key: "leader",
    label: "Leader",
    name: "Leader",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#4d0f14",
      colorFront: "#b02f33",
      colorHighlight: "#ffa8a0",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#ffdedb", watermarkColor: "#6e191d" },
    labelColor: "#c88079",
    nameColor: "#ffeceb",
    priceMonthly: 0,
  },
  {
    key: "talent_manager",
    label: "Talent Manager",
    name: "Talent Manager",
    texture: {
      ...TICKET_TEXTURE,
      colorBack: "#1a2438",
      colorFront: "#3d5a8a",
      colorHighlight: "#9ec0ff",
    },
    layout: { ...BASE_LAYOUT, inkColor: "#e4edff", watermarkColor: "#243456" },
    labelColor: "#7a93b8",
    nameColor: "#eef4ff",
    priceMonthly: 0,
  },
];

// Per-tier text styling — the vendored ticket has no font/per-text-color
// props, so target its rows by class (same trick as the waitlist ticket).
export const TIER_CSS = TIERS.map(
  (t) => `
.tk-${t.key} div.whitespace-pre,
.tk-${t.key} div.whitespace-nowrap:not(.grid) {
  font-family: var(--font-geist-mono), monospace;
  color: ${t.labelColor};
}
.tk-${t.key} div.font-medium:not(.grid) {
  color: ${t.nameColor};
  text-align: left;
}
.tk-${t.key} .will-change-transform {
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1) !important;
}
`,
)
  .join("\n")
  // Grid tickets grow a little on hover. The scale lives on an inner layer so
  // it composes with the tilt transform and the shared layout animation.
  .concat(`
.tier-ticket-inner {
  transition: transform ${TICKET_HOVER_MS}ms ${TICKET_HOVER_EASE_CSS};
}
.tier-ticket-btn:hover .tier-ticket-inner {
  transform: scale(${TICKET_HOVER_SCALE});
}
`);

// Same dashed-line language as the homepage FeatureGrid.
const DASH = "border-dashed border-black/[0.14]";

const GEIST = "var(--font-geist-sans), sans-serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
// Gentle in-and-out: no jolt at the start, soft landing at the end. Used for
// the ticket's flight to the centre and the frosted wash behind it.
const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

// Plan comparison matrix. `true` → included (✓), `false` → not included (—),
// a string → the tier-specific value.
export const FEATURES: { label: string; values: Record<string, string | boolean> }[] = [
  {
    label: "Tracked companies",
    values: { early: "3", silver: "5", gold: "25", platinum: "Unlimited" },
  },
  {
    label: "Daily top signal",
    values: { early: true, silver: true, gold: true, platinum: true },
  },
  {
    label: "Second-order signals",
    values: { early: false, silver: false, gold: true, platinum: true },
  },
  {
    label: "Company reports",
    values: { early: "Standard", silver: "Standard", gold: "Deep", platinum: "Institutional" },
  },
  {
    label: "Relationship graph",
    values: { early: false, silver: "Core", gold: "Full", platinum: "Full + history" },
  },
  {
    label: "24/7 news monitoring",
    values: { early: false, silver: false, gold: true, platinum: true },
  },
  {
    label: "Tracking agents",
    values: { early: false, silver: false, gold: "3", platinum: "Unlimited" },
  },
  {
    label: "Priority support",
    values: { early: false, silver: false, gold: false, platinum: true },
  },
];

export type Billing = "monthly" | "annual";

/** Annual billing takes 20% off the monthly rate. */
export const ANNUAL_DISCOUNT = 0.2;

/** Monthly-equivalent price for the chosen billing period. */
export function monthlyPrice(tier: Tier, billing: Billing = "monthly"): string {
  const value =
    billing === "annual"
      ? Math.round(tier.priceMonthly * (1 - ANNUAL_DISCOUNT))
      : tier.priceMonthly;
  return `$${value}/mo`;
}

/** Subtle segmented control for the billing period. */
function BillingToggle({
  billing,
  onChange,
}: {
  billing: Billing;
  onChange: (next: Billing) => void;
}) {
  const options: { key: Billing; label: string }[] = [
    { key: "monthly", label: "Monthly" },
    { key: "annual", label: "Annual" },
  ];

  return (
    <div
      role="group"
      aria-label="Billing period"
      className="mx-auto flex w-fit items-center gap-1 rounded-full border border-black/[0.08] bg-black/[0.025] p-1"
      style={{ fontFamily: GEIST }}
    >
      {options.map((o) => {
        const active = billing === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={active}
            className={`relative rounded-full px-4 py-1.5 text-[13px] transition-colors ${
              active ? "text-[#1d1b1b]" : "text-[#8a8a8a] hover:text-[#484845]"
            }`}
          >
            {active ? (
              <motion.span
                layoutId="billing-pill"
                className="absolute inset-0 rounded-full bg-[#fdfdfd] shadow-[0_1px_3px_rgba(8,12,18,0.10)]"
                transition={{ duration: 0.28, ease: EASE_SOFT }}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {o.label}
              {o.key === "annual" ? (
                <span className="text-[10px] uppercase tracking-[0.08em] text-[#a3a3a0]">
                  save 20%
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const GRID_COLS: Record<number, string> = {
  1: "",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

/** Pricing-style grid: one column per tier. No line above — the vertical
    dashed separators start level with the tickets and run downward (through
    the feature rows to come); horizontal dashed lines bleed across the full
    screen width. */
export function TierGrid({
  firstName,
  lastName,
  ticketWidth = 300,
  previewWidth = 460,
  tierKeys,
  showBilling = true,
  showComparison = true,
  showPrice = true,
  showGridPrice = true,
  showRules = true,
  stageHeading,
  stageParagraphs,
  stageStep2,
  onApply,
  priceOverride,
}: {
  firstName: string;
  lastName: string;
  ticketWidth?: number;
  /** Ticket size once it flies to the centre of the selection stage. */
  previewWidth?: number;
  /** Which tiers to render (defaults to all). */
  tierKeys?: string[];
  /** Monthly/Annual switch — pointless on a single-tier page. */
  showBilling?: boolean;
  /** The per-tier feature list under the ticket row. */
  showComparison?: boolean;
  /** The "Available at …" line in the focus stage. */
  showPrice?: boolean;
  /** The same line under each ticket in the grid — off when it should only
      appear once the ticket is focused. */
  showGridPrice?: boolean;
  /** Dashed column/row rules. Off for the bare, side-by-side layout. */
  showRules?: boolean;
  /** Replaces the feature list in the focus stage with a headline… */
  stageHeading?: string;
  /** …and these paragraphs. */
  stageParagraphs?: string[];
  /** Optional second screen: "Continue" moves here instead of leaving. */
  stageStep2?: { intro: string; paragraphs: string[] };
  /** Called with the credentials chosen on the apply screen. No account is
      created by this component. */
  onApply?: (application: {
    fullName: string;
    email: string;
    phone: string;
    password: string;
  }) => void;
  /** Fixed price label (e.g. an annual-only tier) instead of the computed one. */
  priceOverride?: string;
}) {
  const tiers = tierKeys ? TIERS.filter((t) => tierKeys.includes(t.key)) : TIERS;
  const colsClass = GRID_COLS[tiers.length] ?? GRID_COLS[4];

  // The vendored ticket sizes everything from a pixel width, so clamp that
  // width to what the viewport can actually give it.
  const [viewport, setViewport] = useState<number | null>(null);
  const [viewportH, setViewportH] = useState<number | null>(null);
  useIsomorphicLayoutEffect(() => {
    const update = () => {
      setViewport(window.innerWidth);
      setViewportH(window.innerHeight);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const fit = (desired: number, chrome: number) =>
    viewport === null ? desired : Math.min(desired, viewport - chrome);
  // Grid: shell padding + column padding on both sides.
  const gridTicketWidth = fit(ticketWidth, 96);
  // Focus stage: bounded by the stage padding and by the height left over
  // once the copy window and CTA are accounted for, so the whole stage fits
  // on screen and the wheel can page instead of scroll.
  const stageTicketWidth = Math.min(
    fit(previewWidth, 56),
    viewportH ? Math.max(240, ((viewportH - 570) * 741) / 425) : previewWidth,
  );
  // A lone tier shouldn't stretch its dashed column across the whole page.
  const solo = tiers.length === 1;
  const shellClass = solo
    ? "mx-auto max-w-[560px] px-6"
    : "mx-auto max-w-[1180px] px-6 sm:px-10";
  const featureTextClass = solo ? "text-[15px]" : "text-[13.5px]";
  const ticketHeight = gridTicketWidth * (425 / 741);
  // The vertical rules only peek out beside the ticket's bottom edge, then
  // run far downward through the (upcoming) feature area.
  const lineTop = ticketHeight * 0.85;

  // Picking a plan happens in place: the page washes white and the chosen
  // ticket flies to the centre, rather than navigating away.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = tiers.find((t) => t.key === selectedKey) ?? null;
  const [billing, setBilling] = useState<Billing>("monthly");
  // The CTA lands muted and only lights up after a few seconds, so the copy
  // gets read first.
  // Only the copy slides: two stacked pages inside a window whose height
  // follows the active page. The ticket above it never moves.
  const [stageStep, setStageStep] = useState<1 | 2 | 3>(1);
  useEffect(() => {
    setStageStep(1);
  }, [selectedKey]);

  const page1Ref = useRef<HTMLDivElement>(null);
  const page2Ref = useRef<HTMLDivElement>(null);
  const page3Ref = useRef<HTMLDivElement>(null);
  const [pageHeights, setPageHeights] = useState({
    first: 0,
    second: 0,
    third: 0,
  });

  // Credentials are held in memory only — no account is created here. The
  // signup (and its verification email) happens when the application is
  // submitted.
  const [applyName, setApplyName] = useState("");
  const [applyEmail, setApplyEmail] = useState("");
  const [applyPhone, setApplyPhone] = useState("");
  const [applyIso, setApplyIso] = useState<string>(DEFAULT_COUNTRY_ISO);
  const country = COUNTRIES.find((c) => c.iso === applyIso) ?? COUNTRIES[0];
  const nameValid = applyName.trim().split(/\s+/).filter(Boolean).length >= 2;
  const phoneValid = applyPhone.replace(/\D/g, "").length >= 6;

  // Re-format on every keystroke. Backspacing onto a separator has to eat the
  // digit before it, otherwise the formatter just types the separator back.
  const onPhoneChange = (raw: string) => {
    let digits = normalizePhoneDigits(applyIso, raw);
    const deleting = raw.length < applyPhone.length;
    if (deleting && digits === normalizePhoneDigits(applyIso, applyPhone)) {
      digits = digits.slice(0, -1);
    }
    setApplyPhone(formatPhone(applyIso, digits));
  };

  const onCountryChange = (iso: string) => {
    setApplyIso(iso);
    setApplyPhone(formatPhone(iso, applyPhone));
  };
  const [applyPassword, setApplyPassword] = useState("");
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applyEmail.trim());
  const passwordValid =
    applyPassword.length >= 6 &&
    /[a-z]/.test(applyPassword) &&
    /[A-Z]/.test(applyPassword) &&
    /[0-9]/.test(applyPassword);
  useIsomorphicLayoutEffect(() => {
    if (!selectedKey) return;
    const pages = [page1Ref, page2Ref, page3Ref];
    // scrollHeight, not offsetHeight: once minHeight is applied every page
    // reports the window height, which would hide a page that actually needs
    // more room (fonts loading late made page one spill into page two).
    const contentHeight = (ref: React.RefObject<HTMLDivElement>) =>
      ref.current?.scrollHeight ?? 0;
    const measure = () =>
      setPageHeights({
        first: contentHeight(page1Ref),
        second: contentHeight(page2Ref),
        third: contentHeight(page3Ref),
      });
    measure();

    const observer = new ResizeObserver(measure);
    pages.forEach((ref) => {
      Array.from(ref.current?.children ?? []).forEach((child) =>
        observer.observe(child),
      );
    });
    // Late-loading fonts change the wrapping, so re-measure once they settle.
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selectedKey, viewport, stageStep2]);

  // The wheel turns the page instead of scrolling the stage.
  const wheelLock = useRef(false);
  const onStageWheel = (e: React.WheelEvent) => {
    if (!stageStep2 || wheelLock.current || Math.abs(e.deltaY) < 12) return;
    // If the stage itself has to scroll (short viewport), leave the wheel alone.
    const el = e.currentTarget as HTMLElement;
    if (el.scrollHeight > el.clientHeight + 4) return;
    const next = Math.min(3, Math.max(1, stageStep + (e.deltaY > 0 ? 1 : -1))) as
      | 1
      | 2
      | 3;
    if (next === stageStep) return;
    wheelLock.current = true;
    setStageStep(next);
    setTimeout(() => {
      wheelLock.current = false;
    }, 700);
  };

  // The CTA is muted for a beat so the copy gets read — but only the first
  // time; reopening a ticket shouldn't make people wait again.
  const readDelayDone = useRef(false);
  const [ctaReady, setCtaReady] = useState(false);
  useEffect(() => {
    if (!selectedKey) return;
    if (readDelayDone.current) {
      setCtaReady(true);
      return;
    }
    setCtaReady(false);
    const timer = setTimeout(() => {
      readDelayDone.current = true;
      setCtaReady(true);
    }, 4000);
    return () => clearTimeout(timer);
  }, [selectedKey]);

  function choose(key: string) {
    sessionStorage.setItem("falcon-selected-plan", key);
    setSelectedKey(key);
  }

  // Esc backs out of the selection.
  useEffect(() => {
    if (!selectedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey]);

  return (
    <div className="w-full">
      <style>{TIER_CSS}</style>

      {showBilling ? (
        <div className="mt-12">
          <BillingToggle billing={billing} onChange={setBilling} />
        </div>
      ) : null}

      <p
        className="mb-6 mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-[#1d1b1b]/35"
        style={{ fontFamily: MONO }}
      >
        {solo ? "Click on the ticket to continue" : "Click on a ticket to proceed"}
      </p>

      <div className={shellClass}>
        <div className={`grid grid-cols-1 ${colsClass}`}>
          {tiers.map((t, i) => (
            <div
              key={t.key}
              className={`tk-${t.key} relative flex flex-col items-center px-6 pb-4`}
            >
              {/* Clicking a ticket picks that plan. While it is selected the
                  slot keeps its space and the ticket itself lives in the
                  overlay, so the shared layout animation can fly it there. */}
              {selectedKey === t.key ? (
                <div
                  aria-hidden
                  style={{ width: gridTicketWidth, aspectRatio: "741 / 425" }}
                />
              ) : (
                <motion.button
                  type="button"
                  // The shared-element id is attached only once the width is
                  // measured, so the flight never starts from the
                  // pre-measurement size. Re-keying on that moment gives
                  // framer a fresh projection node that already carries the
                  // id — without it the first click had nothing to animate
                  // from and the ticket jumped to the centre.
                  key={viewport === null ? "unmeasured" : "measured"}
                  layoutId={viewport === null ? undefined : `tier-ticket-${t.key}`}
                  transition={{ duration: 0.45, ease: EASE_SOFT }}
                  onClick={() => choose(t.key)}
                  aria-label={`Choose the ${t.label} plan`}
                  className="tier-ticket-btn relative z-10 block cursor-pointer"
                  style={{
                    filter: "drop-shadow(0 5px 12px rgba(8, 12, 18, 0.3))",
                  }}
                >
                  <div className="tier-ticket-inner">
                  <AdmitOneTicket
                    tilt={{}}
                    name={t.name}
                    presenter={[firstName, lastName].filter(Boolean).join(" ")}
                    event=""
                    venue="Member #001"
                    dates="Granted Aug 2026"
                    stubText="Admit one"
                    watermark="2026"
                    width={gridTicketWidth}
                    texture={t.texture}
                    layout={t.layout}
                  />
                  </div>
                </motion.button>
              )}
              {/* Price, above the horizontal rule. */}
              {showPrice && showGridPrice ? (
                <p
                  className="mt-4 text-[15px] text-[#767676]"
                  style={{ fontFamily: "var(--font-geist-sans), sans-serif" }}
                >
                  Available at{" "}
                  <span className="font-medium text-[#1d1b1b]">
                    {priceOverride ?? monthlyPrice(t, billing)}
                  </span>
                </p>
              ) : null}
              {/* Vertical rule: peeks out beside the ticket's bottom edge and
                  runs down to the row's end; the comparison section below
                  continues the same lines. */}
              {showRules ? (
                <div
                  aria-hidden
                  className={`pointer-events-none absolute bottom-0 left-0 right-0 border-l ${DASH} ${
                    i === tiers.length - 1 ? `border-r ${DASH}` : ""
                  }`}
                  style={{ top: lineTop }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {/* Full-bleed horizontal rule under the ticket row. */}
      {showRules ? <div className={`w-full border-t ${DASH}`} aria-hidden /> : null}

      {/* Plan comparison: one column per tier, rows aligned across columns. */}
      {showComparison ? (
        <>
      <div className={shellClass}>
        <div className={`grid grid-cols-1 ${colsClass}`}>
          {tiers.map((t, i) => (
            <div
              key={t.key}
              className={`border-r ${DASH} ${i === 0 ? `border-l ${DASH}` : ""} px-8 py-9`}
            >
              <ul className="space-y-3.5">
                {FEATURES.map((f) => {
                  const v = f.values[t.key] ?? false;
                  const off = v === false;
                  return (
                    <li
                      key={f.label}
                      className={`flex items-baseline justify-between gap-4 ${featureTextClass}`}
                      style={{ fontFamily: GEIST }}
                    >
                      <span className={off ? "text-[#a3a39f]" : "text-[#484845]"}>
                        {f.label}
                      </span>
                      <span
                        className={
                          off
                            ? "text-[#a3a39f]"
                            : "whitespace-nowrap font-medium text-[#1d1b1b]"
                        }
                      >
                        {v === true ? "✓" : v === false ? "—" : v}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
      {/* Full-bleed horizontal rule closing the comparison. */}
      <div className={`w-full border-t ${DASH}`} aria-hidden />
        </>
      ) : null}

      {/* Selection stage: the page washes white, the chosen ticket flies to
          the centre, its features follow, and the CTA fades in last. */}
      <AnimatePresence>
        {selected ? (
          <motion.div
            key="stage"
            className={`tk-${selected.key} fixed inset-0 z-50 overflow-y-auto`}
            onWheel={onStageWheel}
          >
            {/* Frosted wash: white enough to focus the ticket, sheer enough
                that the page stays faintly visible behind it. It fades on its
                own layer — an animating opacity on the parent would break the
                backdrop filter and swallow this transition. */}
            <motion.div
              className="absolute inset-0 bg-[#fdfdfd]/50 backdrop-blur-xl backdrop-saturate-150"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: EASE_SOFT }}
            />

            <motion.button
              type="button"
              onClick={() => setSelectedKey(null)}
              aria-label="Close"
              className="fixed left-8 top-8 z-10 flex h-9 w-9 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ delay: 0.58, duration: 0.3, ease: EASE_SOFT }}
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </motion.button>

            {/* Panel 1 — the ticket and its pitch. */}
            <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-12">

              <motion.div
                layoutId={viewport === null ? undefined : `tier-ticket-${selected.key}`}
                className="relative"
                style={{ filter: "drop-shadow(0 12px 30px rgba(8, 12, 18, 0.3))" }}
                transition={{ duration: 0.45, ease: EASE_SOFT }}
              >
                <AdmitOneTicket
                  tilt={{}}
                  name={selected.name}
                  presenter={[firstName, lastName].filter(Boolean).join(" ")}
                  event=""
                  venue="Member #001"
                  dates="Granted Aug 2026"
                  stubText="Admit one"
                  watermark="2026"
                  width={stageTicketWidth}
                  texture={selected.texture}
                  layout={selected.layout}
                />
              </motion.div>

              {showPrice ? (
                <motion.p
                  className="mt-6 text-[15px] text-[#3a3a38]"
                  style={{ fontFamily: GEIST }}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  transition={{ delay: 0.3, duration: 0.32, ease: EASE_SOFT }}
                >
                  Available at{" "}
                  <span className="font-medium text-[#1d1b1b]">
                    {priceOverride ?? monthlyPrice(selected, billing)}
                  </span>
                </motion.p>
              ) : null}

              {stageParagraphs?.length ? (
                <motion.div
                  className="-ml-10 mt-3 w-full max-w-[680px] overflow-hidden pl-10 text-left"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  // Plain style, not an animated value: the window is locked to
                  // the taller page so paging can never nudge the ticket.
                  style={{
                    height:
                      Math.max(
                        pageHeights.first,
                        pageHeights.second,
                        pageHeights.third,
                      ) || undefined,
                  }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  transition={{ delay: 0.38, duration: 0.45, ease: EASE_SOFT }}
                >
                  {/* Two stacked pages; the track slides by the first page’s
                      height so page two rises into view from below. */}
                  <motion.div
                    animate={{
                      y: -(stageStep - 1) * (Math.max(pageHeights.first, pageHeights.second, pageHeights.third) || 0),
                    }}
                    transition={{ duration: 0.6, ease: EASE_SOFT }}
                  >
                    <div
                      ref={page1Ref}
                      style={{ height: Math.max(pageHeights.first, pageHeights.second, pageHeights.third) || undefined }}
                      className="-ml-12 overflow-y-auto pl-12 pt-6"
                    >
                      {stageHeading ? (
                        <h2
                          className="relative text-[30px] leading-[36px]"
                          style={{
                            fontFamily:
                              "var(--font-libre-baskerville), Georgia, serif",
                            fontWeight: 400,
                            color: "rgb(29, 27, 27)",
                          }}
                        >
                          <span
                            aria-hidden
                            className="pointer-events-none absolute -left-10 select-none"
                            style={{
                              top: "-0.18em",
                              fontSize: "2.4em",
                              lineHeight: 1,
                            }}
                          >
                            &ldquo;
                          </span>
                          {stageHeading}
                        </h2>
                      ) : null}
                      <div className="mt-6 space-y-5">
                        {stageParagraphs.map((text) => (
                          <p
                            key={text.slice(0, 28)}
                            className="text-[15px] leading-[26px] text-[#4b4b48]"
                            style={{ fontFamily: GEIST }}
                          >
                            {text}
                          </p>
                        ))}
                      </div>
                    </div>

                    {stageStep2 ? (
                      <div
                        ref={page2Ref}
                        aria-hidden={stageStep !== 2}
                        style={{ height: Math.max(pageHeights.first, pageHeights.second, pageHeights.third) || undefined }}
                        className="-ml-12 overflow-y-auto pl-12 pt-6"
                      >
                        <h2
                          className="relative text-[30px] leading-[36px]"
                          style={{
                            fontFamily:
                              "var(--font-libre-baskerville), Georgia, serif",
                            fontWeight: 400,
                            color: "rgb(29, 27, 27)",
                          }}
                        >
                          <span
                            aria-hidden
                            className="pointer-events-none absolute -left-10 select-none"
                            style={{
                              top: "-0.18em",
                              fontSize: "2.4em",
                              lineHeight: 1,
                            }}
                          >
                            &ldquo;
                          </span>
                          {stageStep2.intro}
                        </h2>
                        <div className="mt-6 space-y-5">
                          {stageStep2.paragraphs.map((text) => (
                            <p
                              key={text.slice(0, 28)}
                              className="text-[15px] leading-[26px] text-[#4b4b48]"
                              style={{ fontFamily: GEIST }}
                            >
                              {text}
                            </p>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {stageStep2 ? (
                      <div
                        ref={page3Ref}
                        aria-hidden={stageStep !== 3}
                        style={{ height: Math.max(pageHeights.first, pageHeights.second, pageHeights.third) || undefined }}
                        className="-ml-12 overflow-y-auto pl-12 pt-6"
                      >
                        <h3
                          className="text-[30px] leading-[36px]"
                          style={{
                            fontFamily:
                              "var(--font-libre-baskerville), Georgia, serif",
                            fontWeight: 400,
                            color: "rgb(29, 27, 27)",
                          }}
                        >
                          Set up your Falcon account
                        </h3>
                        <p
                          className="mt-1 text-[13px] italic leading-[20px] text-[#9a9a9a]"
                          style={{ fontFamily: GEIST }}
                        >
                          Nothing is created yet. Your account is set up when you
                          submit your application.
                        </p>

                        <div className="mt-6 space-y-5">
                          <label className="block">
                            <span
                              className="block text-[13px] leading-[18px] text-[#1d1b1b]"
                              style={{ fontFamily: GEIST }}
                            >
                              Full name
                            </span>
                            <input
                              type="text"
                              autoComplete="name"
                              placeholder="Jane Doe"
                              value={applyName}
                              onChange={(e) => setApplyName(e.target.value)}
                              tabIndex={stageStep === 3 ? 0 : -1}
                              className="mt-2 w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60"
                              style={{ fontFamily: GEIST }}
                            />
                          </label>

                          <label className="block">
                            <span
                              className="block text-[13px] leading-[18px] text-[#1d1b1b]"
                              style={{ fontFamily: GEIST }}
                            >
                              Email
                            </span>
                            <input
                              type="email"
                              autoComplete="email"
                              placeholder="jane@example.com"
                              value={applyEmail}
                              onChange={(e) => setApplyEmail(e.target.value)}
                              tabIndex={stageStep === 3 ? 0 : -1}
                              className="mt-2 w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60"
                              style={{ fontFamily: GEIST }}
                            />
                          </label>


                          <label className="block">
                            <span
                              className="block text-[13px] leading-[18px] text-[#1d1b1b]"
                              style={{ fontFamily: GEIST }}
                            >
                              Phone number
                            </span>
                            <div className="mt-2 flex items-center border-b border-black/20 pb-2 transition-colors focus-within:border-black/60">
                              <div className="relative flex shrink-0 items-center gap-1.5 border-r border-black/15 pr-2.5">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={`https://flagcdn.com/w40/${country.iso}.png`}
                                  alt=""
                                  width={22}
                                  height={16}
                                  className="h-[16px] w-[22px] object-cover"
                                />
                                <ChevronDown
                                  aria-hidden
                                  className="h-3.5 w-3.5 text-[#8f8f8b]"
                                  strokeWidth={1.75}
                                />
                                <select
                                  aria-label="Country"
                                  value={applyIso}
                                  onChange={(e) => onCountryChange(e.target.value)}
                                  tabIndex={stageStep === 3 ? 0 : -1}
                                  className="absolute inset-0 cursor-pointer opacity-0"
                                >
                                  {COUNTRIES.map((c) => (
                                    <option key={c.iso} value={c.iso}>
                                      {c.name} ({c.dial})
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <input
                                type="tel"
                                autoComplete="tel-national"
                                placeholder={country.sample}
                                value={applyPhone}
                                onChange={(e) => onPhoneChange(e.target.value)}
                                tabIndex={stageStep === 3 ? 0 : -1}
                                className="w-full border-0 bg-transparent pl-3 text-[16px] text-[#1d1b1b] outline-none placeholder:text-[#a3a39f]"
                                style={{ fontFamily: GEIST }}
                              />
                            </div>
                          </label>

                          <label className="block">
                            <span
                              className="block text-[13px] leading-[18px] text-[#1d1b1b]"
                              style={{ fontFamily: GEIST }}
                            >
                              Password
                            </span>
                            <input
                              type="password"
                              autoComplete="new-password"
                              placeholder="At least 6 characters"
                              value={applyPassword}
                              onChange={(e) => setApplyPassword(e.target.value)}
                              tabIndex={stageStep === 3 ? 0 : -1}
                              className="mt-2 w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60"
                              style={{ fontFamily: GEIST }}
                            />
                            {applyPassword && !passwordValid ? (
                              <span
                                className="mt-2 block text-[13px] leading-[18px] text-[#b3453f]"
                                style={{ fontFamily: GEIST }}
                              >
                                Use 6+ characters with an uppercase letter, a lowercase
                                letter and a number.
                              </span>
                            ) : null}
                          </label>
                        </div>
                      </div>
                    ) : null}
                  </motion.div>
                </motion.div>
              ) : (
              <motion.ul
                className="mt-8 w-full max-w-sm space-y-3"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                transition={{ delay: 0.38, duration: 0.35, ease: EASE_SOFT }}
              >
                {FEATURES.map((f) => {
                  const v = f.values[selected.key] ?? false;
                  const off = v === false;
                  return (
                    <li
                      key={f.label}
                      className="flex items-baseline justify-between gap-4 text-[14px]"
                      style={{ fontFamily: GEIST }}
                    >
                      <span className={off ? "text-[#a3a39f]" : "text-[#484845]"}>
                        {f.label}
                      </span>
                      <span
                        className={
                          off
                            ? "text-[#a3a39f]"
                            : "whitespace-nowrap font-medium text-[#1d1b1b]"
                        }
                      >
                        {v === true ? "✓" : v === false ? "—" : v}
                      </span>
                    </li>
                  );
                })}
              </motion.ul>
              )}

              <motion.div
                className={`mt-10 flex flex-col items-center gap-4 ${
                  ctaReady || stageStep === 2 ? "" : "pointer-events-none"
                }`}
                initial={{ opacity: 0 }}
                animate={{ opacity: ctaReady || stageStep === 2 ? 1 : 0.3 }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                transition={
                  ctaReady || stageStep === 2
                    ? { duration: 0.7, ease: EASE_SOFT }
                    : { delay: 0.62, duration: 0.35, ease: EASE_SOFT }
                }
              >
                {!stageStep2 ? (
                  <GetStartedButton
                    label="Continue"
                    href="/login"
                    className="h-[45px] w-[260px] pl-4 pr-3.5"
                  />
                ) : stageStep === 1 ? (
                  <GetStartedButton
                    label="Continue"
                    onClick={() => setStageStep(2)}
                    className="h-[45px] w-[260px] pl-4 pr-3.5"
                  />
                ) : stageStep === 2 ? (
                  <GetStartedButton
                    label="Continue to apply"
                    onClick={() => setStageStep(3)}
                    className="h-[45px] w-[260px] pl-4 pr-3.5"
                  />
                ) : (
                  <button
                    type="button"
                    disabled={
                      !nameValid || !emailValid || !phoneValid || !passwordValid
                    }
                    onClick={() =>
                      onApply?.({
                        fullName: applyName.trim().replace(/\s+/g, " "),
                        email: applyEmail.trim(),
                        phone: `${country.dial} ${applyPhone.trim()}`,
                        password: applyPassword,
                      })
                    }
                    className={`flex h-[45px] w-[260px] items-center justify-center rounded-lg text-[13px] transition-colors ${
                      nameValid && emailValid && phoneValid && passwordValid
                        ? "bg-[#1c1917] text-[rgb(231,231,231)] hover:bg-[#0f0d0b]"
                        : "cursor-not-allowed bg-[#eceae7] text-[#9a9a9a]"
                    }`}
                    style={{ fontFamily: GEIST }}
                  >
                    Continue
                  </button>
                )}

                {stageStep2 ? (
                  <button
                    type="button"
                    onClick={() => setStageStep(stageStep === 3 ? 2 : 1)}
                    aria-hidden={stageStep === 1}
                    tabIndex={stageStep === 1 ? -1 : 0}
                    className={`text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-opacity hover:text-[#1d1b1b] ${
                      stageStep === 1 ? "pointer-events-none opacity-0" : "opacity-100"
                    }`}
                    style={{ fontFamily: MONO }}
                  >
                    &larr; Back
                  </button>
                ) : null}
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The four membership-tier tickets, side by side (wrapping on small screens). */
export default function TierTickets({
  firstName,
  lastName,
  width = 340,
  showLabels = true,
  tierKeys,
}: {
  firstName: string;
  lastName: string;
  width?: number;
  showLabels?: boolean;
  /** Which tiers to render (defaults to all). */
  tierKeys?: string[];
}) {
  const tiers = tierKeys ? TIERS.filter((t) => tierKeys.includes(t.key)) : TIERS;
  return (
    <div className="mx-auto flex max-w-[1560px] flex-wrap items-start justify-center gap-10">
      <style>{TIER_CSS}</style>
      {tiers.map((t) => (
        <div key={t.key} className={`tk-${t.key} flex flex-col items-center`}>
          <div
            style={{
              filter: "drop-shadow(0 5px 12px rgba(8, 12, 18, 0.3))",
            }}
          >
            <AdmitOneTicket
              tilt={{}}
              name={t.name}
              presenter={[firstName, lastName].filter(Boolean).join(" ")}
              event=""
              venue="Member #001"
              dates="Granted Aug 2026"
              stubText="Admit one"
              watermark="2026"
              width={width}
              texture={t.texture}
              layout={t.layout}
            />
          </div>
          {showLabels ? (
            <p
              className="mt-5 text-xs uppercase tracking-[0.2em] text-[#767676]"
              style={{ fontFamily: MONO }}
            >
              {t.label}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
