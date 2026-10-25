import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import type { EarningsLink, EarningsRow, EarningsTime } from "../../../shared/earnings-types";
import { shortDate, type Say } from "../../../shared/earnings-view";

/**
 * The small pieces the Earnings tab and the Earnings card share, written in
 * the app's own class vocabulary (the card glass, the settings panes'
 * buttons and fields, the agents' plain ticker), so the dark theme's
 * translation in globals.css covers them without new rules.
 */

export const SURFACE =
  "rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150";

export const BUTTON =
  "app-no-drag btn-quiet inline-flex items-center gap-1.5 rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[12.5px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-50";

export const FIELD =
  "app-no-drag rounded-xl border border-white/60 bg-white/55 px-3 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-content-tertiary focus:bg-white/75 disabled:opacity-60";

export const LABEL = "select-none font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary";

export const SKELETON = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

/** The renderer's `t`, as the pure view helpers take it. */
export function useSay(): { say: Say; lang: string; t: ReturnType<typeof useI18n>["t"] } {
  const { language, t } = useI18n();
  const say = useCallback<Say>((key, params) => t(key as MessageKey, params), [t]);
  return { say, lang: language, t };
}

/** The ticker, set as plain text (no pill) the way the agent rows set it; a press opens the stock view. */
export function TickerButton({ row, className }: { row: Pick<EarningsRow, "ticker" | "company">; className?: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => openStock(row.ticker, row.company ?? undefined)}
      aria-label={t("earnings.row.open", { ticker: row.ticker })}
      className={cn(
        "app-no-drag inline-flex h-[18px] shrink-0 cursor-pointer items-center text-[12px] font-medium text-content-primary underline-offset-2 outline-none hover:underline focus-visible:underline",
        className,
      )}
    >
      {row.ticker}
    </button>
  );
}

const TIME_KEY: Record<EarningsTime, MessageKey> = {
  bmo: "earnings.time.bmo",
  amc: "earnings.time.amc",
  dmh: "earnings.time.dmh",
  unknown: "earnings.time.unknown",
};

export function timeLabel(t: (key: MessageKey) => string, time: EarningsTime): string {
  return t(TIME_KEY[time]);
}

/** The held or watched mark: a filled dot for a held name, a ring for a watched one. */
export function HeldMarker({ row }: { row: Pick<EarningsRow, "held" | "watchlist"> }) {
  const { t } = useI18n();
  if (!row.held && !row.watchlist) return <span aria-hidden />;
  const label = row.held ? t("earnings.badge.held") : t("earnings.badge.watchlist");
  return (
    <span title={label} aria-label={label} role="img" className="flex items-center justify-center">
      <span className={cn("block h-[7px] w-[7px] rounded-full", row.held ? "bg-ink opacity-70" : "border-[1.25px] border-current text-content-secondary")} />
    </span>
  );
}

const CATEGORY_KEY: Record<string, MessageKey> = {
  supplier: "earnings.category.supplier",
  customer: "earnings.category.customer",
  partner: "earnings.category.partner",
  competitor: "earnings.category.competitor",
  dependency: "earnings.category.dependency",
};

/** "AMD's 10-K names TSM as a supplier": who names whom, in which filing. */
export function linkSentence(t: (key: MessageKey, params?: Record<string, string | number>) => string, link: EarningsLink): string {
  const category = t(CATEGORY_KEY[link.category] ?? "earnings.category.related");
  return link.form
    ? t("earnings.link.namedIn", { filer: link.namedBy, form: link.form, named: link.named, category })
    : t("earnings.link.namedInFiling", { filer: link.namedBy, named: link.named, category });
}

/** The reader's names a report reads through to, as plain tickers (held ones in ink). */
export function LinkChips({ links, className }: { links: readonly EarningsLink[]; className?: string }) {
  const { t } = useI18n();
  if (links.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      {links.map((l) => (
        <span
          key={l.ticker}
          title={linkSentence(t, l)}
          className={cn(
            "inline-flex h-[18px] shrink-0 items-center text-[12px] font-medium",
            l.held ? "text-content-primary" : "text-content-body",
          )}
        >
          {l.ticker}
        </span>
      ))}
    </span>
  );
}

/** Quiet pills: held, on the watchlist, an estimated date or a window. */
export function RowBadges({ row, className, marks = true }: { row: EarningsRow; className?: string; marks?: boolean }) {
  const { language, t } = useI18n();
  const pill = "inline-flex h-[17px] shrink-0 items-center rounded-full px-1.5 text-[10.5px] leading-none";
  const items: ReactNode[] = [];
  if (marks && row.held) items.push(<span key="held" className={cn(pill, "bg-black/[0.06] text-content-body")}>{t("earnings.badge.held")}</span>);
  else if (marks && row.watchlist) items.push(<span key="watch" className={cn(pill, "bg-black/[0.04] text-content-secondary")}>{t("earnings.badge.watchlist")}</span>);
  if (row.reason === "sector") items.push(<span key="why" className={cn(pill, "bg-black/[0.04] text-content-secondary")}>{t("earnings.badge.sector")}</span>);
  else if (row.reason === "large") items.push(<span key="why" className={cn(pill, "bg-black/[0.04] text-content-secondary")}>{t("earnings.badge.large")}</span>);
  if (row.status === "estimated") {
    items.push(
      <span key="est" title={t("earnings.badge.estimatedHint")} className={cn(pill, "border border-dashed border-black/[0.12] text-content-secondary")}>
        {row.windowEnd ? t("earnings.badge.window", { date: shortDate(row.windowEnd, language) }) : t("earnings.badge.estimated")}
      </span>,
    );
  }
  if (items.length === 0) return null;
  return <span className={cn("flex shrink-0 items-center gap-1", className)}>{items}</span>;
}

const SEGMENT = "app-no-drag relative rounded-lg px-2.5 py-1 text-[12px] transition-colors";

/** The Calendar tab's segmented switch, in the same classes. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; text: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center rounded-xl bg-black/[0.04] p-[2px]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(SEGMENT, value === o.id ? "bg-white/90 text-content-primary shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-content-secondary hover:text-content-primary")}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

/**
 * A small pick-one menu (sector, time of day). The panel is opaque, as the
 * card menus are, and fades in and out with the dropdown motion every menu
 * in the app uses; Escape and a press outside close it.
 */
export function FilterMenu<T extends string>({
  label,
  value,
  allText,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  allText: string;
  options: Array<{ id: T; text: string }>;
  onChange: (v: T | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.id === value);
  const pick = (v: T | null) => {
    onChange(v);
    setOpen(false);
  };
  const item = (id: T | null, text: string) => (
    <button
      key={id ?? "__all"}
      type="button"
      role="menuitemradio"
      aria-checked={value === id}
      onClick={() => pick(id)}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-[12.5px] font-normal text-content-primary transition-colors hover:bg-ink/[0.06]"
    >
      <span className="truncate">{text}</span>
      {value === id ? <Check className="h-3.5 w-3.5 shrink-0 text-content-body" strokeWidth={2} aria-hidden /> : null}
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(BUTTON, "h-8 py-0", value !== null && "text-content-primary")}
      >
        <span className="text-content-secondary">{label}</span>
        <span className="max-w-[140px] truncate">{current ? current.text : allText}</span>
        <ChevronDown className="h-3.5 w-3.5 text-content-tertiary" strokeWidth={2} aria-hidden />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label={label}
            {...DROPDOWN_FADE}
            className="app-no-drag absolute left-0 top-full z-50 mt-2 max-h-[320px] w-56 overflow-y-auto rounded-2xl border border-white/60 bg-white p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]"
          >
            {item(null, allText)}
            <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />
            {options.map((o) => item(o.id, o.text))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
