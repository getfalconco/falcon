import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, Check, MoreVertical } from "lucide-react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import ConnectPortfolioEmpty, { usePortfolioConnected } from "@/components/dashboard/ConnectPortfolioEmpty";
import { usePortfolioReturn } from "@/hooks/usePortfolioReturn";
import { monthDayYear } from "@/lib/dashboard-dates";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { useI18n, type MessageKey } from "@/lib/i18n";
import {
  RETURN_PERIODS,
  compactSignedUsd,
  defaultPeriod,
  isReturnPeriod,
  joinClasses,
  returnDirection,
  returnPercent,
  returnTone,
  type HeldClass,
  type ReturnPeriod,
} from "@/lib/portfolio-return";
import { getThemeSnapshot, subscribeTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Portfolio return: how much the book has made over a window, as one large
 * figure on a card whose colour is the figure. Deep olive for a strong gain,
 * a softer green for a small one, grey around nothing, then amber and red as
 * a loss deepens; every tenth of a percent moves it (lib/portfolio-return).
 *
 * The pill top right is the same gain in dollars. The line under the figure
 * says what it covers, the classes the book holds and the window, and is the
 * control for the window. When a brokerage is linked the money moved in or
 * out of it is not visible here, so the card names the figure a change.
 */

const PERIOD_KEY = "falcon.ui.returnPeriod";
const MASKED_MONEY = "$*****";

const SCOPE_KEY: Record<Exclude<ReturnPeriod, "All">, MessageKey> = {
  "1M": "returns.scope.1M",
  "3M": "returns.scope.3M",
  YTD: "returns.scope.YTD",
  "1Y": "returns.scope.1Y",
  "3Y": "returns.scope.3Y",
};

const PERIOD_KEY_LABEL: Record<ReturnPeriod, MessageKey> = {
  "1M": "returns.period.1M",
  "3M": "returns.period.3M",
  YTD: "returns.period.YTD",
  "1Y": "returns.period.1Y",
  "3Y": "returns.period.3Y",
  All: "returns.period.All",
};

const CLASS_KEY: Record<HeldClass, MessageKey> = {
  stocks: "returns.class.stocks",
  funds: "returns.class.funds",
  crypto: "returns.class.crypto",
  cash: "returns.class.cash",
  brokerage: "returns.class.brokerage",
};

function readStoredPeriod(): ReturnPeriod | null {
  try {
    const raw = localStorage.getItem(PERIOD_KEY);
    return isReturnPeriod(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Closes a popover on a press outside it or on Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}

const PANEL =
  "app-no-drag absolute right-0 z-50 w-48 rounded-2xl border border-white/60 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]";

export default function PortfolioReturnCard({
  masked = false,
  onDuplicate,
  onRemove,
}: {
  masked?: boolean;
  onDuplicate?: () => void;
  onRemove?: () => void;
}) {
  const { t, locale } = useI18n();
  const connected = usePortfolioConnected();
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, (): Theme => "light");

  const [chosen, setChosen] = useState<ReturnPeriod | null>(readStoredPeriod);
  const [auto, setAuto] = useState<ReturnPeriod>("All");
  const period = chosen ?? auto;
  const view = usePortfolioReturn(period);
  useEffect(() => {
    if (!chosen) setAuto(defaultPeriod(view.firstAt, Date.now()));
  }, [chosen, view.firstAt]);
  const choose = (p: ReturnPeriod) => {
    setChosen(p);
    try {
      localStorage.setItem(PERIOD_KEY, p);
    } catch {
      /* the choice holds for this session */
    }
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const [periodOpen, setPeriodOpen] = useState(false);
  const periodRef = useRef<HTMLDivElement>(null);
  useDismiss(periodOpen, periodRef, () => setPeriodOpen(false));

  const label = t(view.flowsKnown ? "returns.card.label" : "returns.card.labelChange");

  if (!connected) {
    return (
      <div className="flex h-full min-h-[320px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
        <ChartCardHeader label={t("returns.card.label")} onDuplicate={onDuplicate} onRemove={onRemove} />
        <div className="min-h-0 flex-1">
          <ConnectPortfolioEmpty line={t("returns.card.empty")} />
        </div>
      </div>
    );
  }

  const ratio = view.ratio ?? 0;
  const tone = returnTone(view.ratio, theme);
  const direction = returnDirection(ratio);
  const pct = returnPercent(ratio, locale);
  const figureLabel = t(direction === "up" ? "returns.card.up" : direction === "down" ? "returns.card.down" : "returns.card.flat", { pct });

  const inner = Math.max(0, width - 40);
  const size = inner > 0 ? Math.round(Math.min(96, Math.max(34, inner * 0.17))) : 52;

  const classes = view.classes.map((c) => t(CLASS_KEY[c]));
  const scope =
    period === "All" || view.clipped
      ? t("returns.scope.since", { date: monthDayYear(new Date(view.startAt), locale) })
      : t(SCOPE_KEY[period]);
  const line = classes.length > 0 ? `${joinClasses(classes, locale)} · ${scope}` : joinClasses([scope], locale);

  const fullGain = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", signDisplay: "exceptZero" }).format(view.gain);

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-[320px] w-full select-none flex-col rounded-3xl p-5 font-sans ring-1 ring-black/[0.06]"
      style={{ background: tone.background, color: tone.textCss, boxShadow: `${tone.rim}, 0 10px 30px rgba(0,0,0,0.10)` }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span className="truncate text-[11px] font-medium tracking-[0.04em]" style={{ color: tone.mutedCss }}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span
            className="rounded-full bg-black/80 px-2.5 py-[3px] text-[11.5px] font-semibold leading-[18px] tabular-nums text-white"
            title={masked ? undefined : fullGain}
          >
            {masked ? MASKED_MONEY : compactSignedUsd(view.gain, locale)}
          </span>
          <div ref={menuRef} data-no-lift className="relative -mr-[10px] flex">
            <button
              type="button"
              aria-label={t("dashboard.card.menu")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className={cn(
                "app-no-drag transition-opacity duration-150 focus-visible:opacity-100",
                menuOpen ? "opacity-100" : "opacity-0 group-hover/card:opacity-80 hover:!opacity-100",
              )}
              style={{ color: tone.textCss }}
            >
              <MoreVertical className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            <AnimatePresence>
              {menuOpen ? (
                <motion.div role="menu" aria-label={t("dashboard.card.actions")} {...DROPDOWN_FADE} className={cn(PANEL, "top-full mt-2 p-1.5")}>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onDuplicate?.();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-content-primary transition-all duration-150 hover:translate-x-0.5 hover:bg-ink/[0.07] active:scale-[0.97]"
                  >
                    {t("dashboard.card.duplicate")}
                  </button>
                  <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onRemove?.();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-tone-negative transition-all duration-150 hover:translate-x-0.5 hover:bg-tone-negative-fill/[0.10] active:scale-[0.97]"
                  >
                    {t("dashboard.card.delete")}
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1" />

      <div role="img" aria-label={figureLabel} className="flex min-w-0 items-center leading-none" style={{ fontSize: size, gap: size * 0.14 }}>
        {direction === "up" ? (
          <ArrowUp aria-hidden strokeWidth={1.25} style={{ width: size * 0.66, height: size * 0.66, flexShrink: 0 }} />
        ) : direction === "down" ? (
          <ArrowDown aria-hidden strokeWidth={1.25} style={{ width: size * 0.66, height: size * 0.66, flexShrink: 0 }} />
        ) : null}
        <span className="truncate font-extralight tracking-[-0.01em] tabular-nums">{pct}</span>
      </div>

      <div ref={periodRef} data-no-lift className="relative mt-2.5 flex min-w-0">
        <button
          type="button"
          aria-label={`${line}. ${t("returns.card.periodButton")}`}
          aria-haspopup="dialog"
          aria-expanded={periodOpen}
          onClick={() => setPeriodOpen((v) => !v)}
          className="app-no-drag min-w-0 truncate rounded text-left text-[12.5px] font-normal underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-none"
          style={{ color: tone.mutedCss, textDecorationColor: tone.mutedCss }}
        >
          {line}
        </button>
        <AnimatePresence>
          {periodOpen ? (
            <motion.div
              role="dialog"
              aria-label={t("returns.card.periodButton")}
              {...DROPDOWN_FADE}
              className={cn(PANEL, "bottom-full left-0 right-auto mb-2 p-2")}
            >
              <div className="px-1 pb-1.5">
                <span className="font-sans text-[11px] font-normal tracking-[0.04em] text-content-tertiary">{t("returns.card.periodHeading")}</span>
              </div>
              <div role="radiogroup" aria-label={t("returns.card.periodButton")}>
                {RETURN_PERIODS.map((p) => {
                  const active = p === period;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        choose(p);
                        setPeriodOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] font-normal text-content-primary transition-colors hover:bg-ink/[0.06]"
                    >
                      {t(PERIOD_KEY_LABEL[p])}
                      <span
                        aria-hidden
                        className={cn(
                          "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-sm border transition-colors",
                          active ? "border-content-primary bg-ink text-white" : "border-black/20 bg-white/60",
                        )}
                      >
                        {active ? <Check className="h-[10px] w-[10px]" strokeWidth={3} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
