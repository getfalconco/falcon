import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import ConnectPortfolioEmpty, { usePortfolioConnected } from "@/components/dashboard/ConnectPortfolioEmpty";
import { useLivePrices } from "@/hooks/useLivePrices";
import { readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import { useReducedMotionPref } from "@/lib/motion";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { positionMarketValue } from "../../../shared/portfolio-weights";
import { buildAllocation, classAt, CLASS_ORDER, parsePlan, type Allocation, type AssetClass } from "./allocation";

type Props = {
  /** The privacy mask: dollar amounts hide, percentages stay. */
  masked?: boolean;
  onDuplicate?: () => void;
  onRemove?: () => void;
};

const MASKED_MONEY = "$*****";

/**
 * Each class's colour, right in either theme: Apple's system hues
 * (systemIndigo, systemTeal, systemOrange, systemPink, systemYellow), the
 * warm ones mixed a little toward the theme's ink so they deepen on the light
 * canvas and lift on the dark one; cash is the ink itself at a low alpha, the
 * quiet grey the arc ends in.
 */
const CLASS_COLOR: Readonly<Record<AssetClass, string>> = {
  stocks: "var(--system-indigo)",
  funds: "var(--system-teal)",
  crypto: "color-mix(in srgb, var(--system-orange) 92%, var(--text-primary))",
  options: "var(--system-pink)",
  linked: "color-mix(in srgb, var(--system-yellow) 84%, var(--text-primary))",
  other: "var(--warning-muted)",
  cash: "rgb(var(--ink-rgb) / 0.34)",
};
/** An unlit tick: the arc's shape before the sweep reaches it. */
const TRACK = "rgb(var(--ink-rgb) / 0.07)";

const CLASS_LABEL: Readonly<Record<AssetClass, MessageKey>> = {
  stocks: "allocation.class.stocks",
  funds: "allocation.class.funds",
  crypto: "allocation.class.crypto",
  options: "allocation.class.options",
  linked: "allocation.class.linked",
  other: "allocation.class.other",
  cash: "allocation.class.cash",
};

/* ------------------------------------------------------------------------ */
/* The planned split: one number (the invested percent), kept on this       */
/* machine and shared by every copy of the card.                            */
/* ------------------------------------------------------------------------ */

const PLAN_KEY = "falcon.ui.allocationPlan.v1";
const PLAN_EVENT = "falcon:allocation-plan-changed";

function readPlan(): number | null {
  try {
    return parsePlan(localStorage.getItem(PLAN_KEY));
  } catch {
    return null;
  }
}

function writePlan(plan: number | null): void {
  try {
    if (plan == null) localStorage.removeItem(PLAN_KEY);
    else localStorage.setItem(PLAN_KEY, String(plan));
  } catch {
    /* non-fatal: the plan lasts the session */
  }
  window.dispatchEvent(new Event(PLAN_EVENT));
}

function subscribePlan(listener: () => void): () => void {
  window.addEventListener(PLAN_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(PLAN_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

/* ------------------------------------------------------------------------ */
/* The book: the same three sources Net worth adds up.                      */
/* ------------------------------------------------------------------------ */

function useAllocation(): Allocation | null {
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);
  const prices = useLivePrices(Object.keys(account.positions).sort().join(","));

  const [linked, setLinked] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void window.meridian
      ?.getBrokerageNetWorth?.()
      .then((res) => {
        if (!cancelled && res?.ok && res.networth.connected) setLinked(res.networth.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () =>
      buildAllocation({
        cash: account.cash,
        holdings: Object.values(account.positions).map((p) => ({
          symbol: p.symbol,
          value: positionMarketValue(p.shares, p.costUsd, prices[p.symbol]),
        })),
        linked,
      }),
    [account, prices, linked],
  );
}

/* ------------------------------------------------------------------------ */
/* Motion: the arc sweeps in once, and later changes glide.                 */
/* ------------------------------------------------------------------------ */

type Shares = Partial<Record<AssetClass, number>>;
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const SWEEP_MS = 1100;
const GLIDE_MS = 650;

/**
 * The shares as drawn this frame, and how far round the arc the colour has
 * reached (0 to 1). The first allocation sweeps in from the left end; any
 * later one glides from what is on screen to the new shares.
 */
function useAnimatedShares(target: Shares | null, reduced: boolean): { shares: Shares; sweep: number; moving: boolean } {
  const [frame, setFrame] = useState<{ shares: Shares; sweep: number; moving: boolean }>({
    shares: target ?? {},
    sweep: reduced ? 1 : 0,
    moving: false,
  });
  const drawn = useRef(frame);
  drawn.current = frame;
  const swept = useRef(reduced);
  const key = target ? CLASS_ORDER.map((k) => (target[k] ?? 0).toFixed(4)).join(",") : "";

  useEffect(() => {
    if (!target) return;
    if (reduced) {
      swept.current = true;
      setFrame({ shares: target, sweep: 1, moving: false });
      return;
    }
    const from = drawn.current.shares;
    const first = !swept.current;
    const start = performance.now();
    const ms = first ? SWEEP_MS : GLIDE_MS;
    let raf = 0;
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / ms);
      const e = easeOut(x);
      if (first) {
        setFrame({ shares: target, sweep: e, moving: x < 1 });
      } else {
        const shares: Shares = {};
        for (const k of CLASS_ORDER) {
          const a = from[k] ?? 0;
          const b = target[k] ?? 0;
          if (a > 0 || b > 0) shares[k] = a + (b - a) * e;
        }
        setFrame({ shares, sweep: 1, moving: x < 1 });
      }
      if (x < 1) raf = requestAnimationFrame(tick);
      else swept.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `key` stands for `target`'s contents; a new object with the same shares is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced]);

  return frame;
}

/* ------------------------------------------------------------------------ */
/* The gauge.                                                               */
/* ------------------------------------------------------------------------ */

const TICKS = 58;
const VB_W = 240;
const VB_H = 128;
const CX = VB_W / 2;
const CY = 120;
const R_OUT = 112;
const R_IN = 86;

function polar(r: number, fraction: number): { x: number; y: number } {
  const a = Math.PI * (1 - fraction);
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
}

function Gauge({
  shares,
  sweep,
  plan,
  focus,
}: {
  shares: Shares;
  sweep: number;
  plan: number | null;
  focus: AssetClass | null;
}) {
  const slices = CLASS_ORDER.filter((k) => (shares[k] ?? 0) > 0).map((k) => ({ key: k, share: shares[k]! }));
  const sum = slices.reduce((s, x) => s + x.share, 0) || 1;
  const norm = slices.map((s) => ({ key: s.key, share: s.share / sum }));
  const planAt = plan == null ? null : plan / 100;
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="block h-auto w-full overflow-visible" aria-hidden>
      {Array.from({ length: TICKS }, (_, i) => {
        // Placed end to end (the first tick lies flat at the left, the last
        // at the right); coloured by the class under the middle of its slot.
        const place = i / (TICKS - 1);
        const mid = (i + 0.5) / TICKS;
        const key = classAt(norm, mid);
        const lit = key != null && mid <= sweep + 1e-9;
        const a = polar(R_IN, place);
        const b = polar(R_OUT, place);
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={lit ? CLASS_COLOR[key] : TRACK}
            strokeWidth={2.6}
            strokeLinecap="round"
            opacity={lit && focus && key !== focus ? 0.28 : 1}
            style={{ transition: "opacity 160ms ease" }}
          />
        );
      })}
      {/* The plan: a short mark just outside the arc where invested would end. */}
      {planAt != null ? (
        (() => {
          const a = polar(R_OUT + 5, planAt);
          const b = polar(R_OUT + 12, planAt);
          return (
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--text-secondary)" strokeWidth={1.6} strokeLinecap="round" />
          );
        })()
      ) : null}
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* The plan pill.                                                           */
/* ------------------------------------------------------------------------ */

const PILL =
  "app-no-drag -my-1 flex h-6 items-center rounded-full bg-fill-selected px-2.5 font-sans text-[11px] font-medium tabular-nums leading-none tracking-[0.02em] transition-colors";

function PlanPill({ plan }: { plan: number | null }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft != null) inputRef.current?.select();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft != null]);

  const commit = () => {
    if (draft == null) return;
    const text = draft.trim();
    if (text === "") writePlan(null);
    else {
      const next = parsePlan(text);
      if (next != null) writePlan(next);
    }
    setDraft(null);
  };

  if (draft != null) {
    const typed = parsePlan(draft);
    return (
      <label data-no-lift className={cn(PILL, "gap-0.5 text-content-primary ring-1 ring-edge-strong")}>
        <input
          ref={inputRef}
          value={draft}
          inputMode="numeric"
          maxLength={3}
          aria-label={t("allocation.plan.input")}
          title={t("allocation.plan.input")}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          className="w-[3ch] bg-transparent text-right text-content-primary outline-none"
        />
        <span className="text-content-tertiary">/{typed == null ? "" : 100 - typed}</span>
      </label>
    );
  }

  if (plan == null) {
    return (
      <button
        type="button"
        data-no-lift
        onClick={() => setDraft("")}
        aria-label={t("allocation.plan.setAria")}
        className={cn(
          PILL,
          "bg-transparent text-content-tertiary opacity-0 hover:bg-fill-selected hover:text-content-primary focus-visible:opacity-100 group-hover/card:opacity-100",
        )}
      >
        {t("allocation.plan.set")}
      </button>
    );
  }

  const parts = { invested: plan, cash: 100 - plan };
  return (
    <button
      type="button"
      data-no-lift
      onClick={() => setDraft(String(plan))}
      aria-label={t("allocation.plan.change", parts)}
      title={t("allocation.plan.change", parts)}
      className={cn(PILL, "text-content-secondary hover:text-content-primary")}
    >
      {t("allocation.plan.pill", parts)}
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* The card.                                                                */
/* ------------------------------------------------------------------------ */

function money(v: number): string {
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/**
 * Allocation: how the book splits by kind of holding. A half dial of thin
 * ticks, coloured in order (stocks, funds, crypto, options, linked accounts,
 * cash last in grey), each class taking its share of the arc; the invested
 * share (everything but cash) in the middle; and a legend with each class's
 * percent and dollars. The reader can keep a planned invested and cash split
 * beside it, as a pill in the masthead and a mark on the arc.
 */
export default function AllocationCard({ masked = false, onDuplicate, onRemove }: Props) {
  const t = useT();
  const connected = usePortfolioConnected();
  const allocation = useAllocation();
  const plan = useSyncExternalStore(subscribePlan, readPlan, () => null);
  const reduced = useReducedMotionPref();
  const [focus, setFocus] = useState<AssetClass | null>(null);

  const target = useMemo<Shares | null>(
    () => (allocation ? Object.fromEntries(allocation.slices.map((s) => [s.key, s.share])) : null),
    [allocation],
  );
  const { shares, sweep, moving } = useAnimatedShares(target, reduced);

  // The headline counts up with the sweep and glides with the shares, then
  // rests on exactly the figure the legend adds up to.
  const animatedInvested = 1 - (shares.cash ?? 0) / (Object.values(shares).reduce((s, v) => s + (v ?? 0), 0) || 1);
  const invested = allocation
    ? moving
      ? Math.round(animatedInvested * 100 * sweep)
      : allocation.investedPercent
    : 0;

  let body: React.ReactNode;
  if (!connected) {
    body = <ConnectPortfolioEmpty line={t("allocation.empty")} />;
  } else if (!allocation) {
    body = (
      <p className="flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5] text-content-tertiary">
        {t("allocation.nothing")}
      </p>
    );
  } else {
    const gaugeLabel = t("allocation.gauge", { invested: allocation.investedPercent, cash: 100 - allocation.investedPercent });
    body = (
      <>
        {/* The dial takes the room the legend leaves, centred in it; on a
            short card the legend is what gives way, and scrolls. */}
        <div className="flex flex-1 items-center justify-center pb-2">
        <div
          role="img"
          aria-label={gaugeLabel}
          className="relative w-full max-w-[340px] [container-type:inline-size]"
        >
          <Gauge shares={shares} sweep={sweep} plan={plan} focus={focus} />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
            <span className="flex items-start font-sans font-light leading-none tracking-[-0.03em] text-content-primary tabular-nums text-[clamp(34px,19cqw,58px)]">
              {invested}
              <span className="ml-[0.06em] mt-[0.12em] text-[0.3em] font-normal tracking-normal text-content-tertiary">%</span>
            </span>
            <span className="mt-1.5 text-[12px] leading-none text-content-tertiary">{t("allocation.invested")}</span>
          </div>
        </div>
        </div>

        <ul className="scrollbar-meridian mt-3 min-h-0 shrink overflow-y-auto">
          {allocation.slices.map((s, i) => (
            <li
              key={s.key}
              onPointerEnter={() => setFocus(s.key)}
              onPointerLeave={() => setFocus((f) => (f === s.key ? null : f))}
              className={cn(
                "flex items-center gap-3 py-[11px] text-[13px] leading-none",
                i > 0 && "border-t border-edge-subtle",
              )}
            >
              <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: CLASS_COLOR[s.key] } as CSSProperties} />
              <span className="min-w-0 flex-1 truncate font-medium text-content-primary">{t(CLASS_LABEL[s.key])}</span>
              <span className="w-10 shrink-0 text-right tabular-nums text-content-tertiary">{s.percent === 0 ? "<1%" : `${s.percent}%`}</span>
              <span className="min-w-[76px] shrink-0 text-right font-medium tabular-nums text-content-primary">
                {masked ? MASKED_MONEY : money(s.value)}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("allocation.card.label")}
        actions={connected && allocation ? <PlanPill plan={plan} /> : undefined}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-3">{body}</div>
    </div>
  );
}
