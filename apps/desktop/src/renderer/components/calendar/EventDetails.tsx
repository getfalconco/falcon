import { useState } from "react";
import { ArrowUpRight, Pencil, Trash2, X } from "lucide-react";
import { useBriefingText } from "@/components/briefing/use-briefing-text";
import { useI18n } from "@/lib/i18n";
import { sectorLabel } from "./sector-labels";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import type { BriefingText } from "../../../shared/briefing-text";
import { countdownSentence, daysBetween } from "../../../shared/calendar-agenda";
import { CATEGORY_COLOR } from "../../../shared/calendar-events";
import { colorAccent, eventShade } from "./calendar-colors";
import { addDays, hhmm, longDay as dayName, zonedParts } from "./calendar-dates";
import type { CalEvent } from "./calendar-model";
import EarningsFacts from "./EarningsFacts";
import { Mark } from "./EventBlocks";
import { econLines } from "./econ-lines";
import { BUTTON, ICON_BUTTON, MONO_HEAD } from "./calendar-styles";

/**
 * An event's card. Market events are read-only and say where their date
 * comes from; the reader's own can be edited or deleted (two presses, so a
 * stray click cannot lose one). A ticker opens its stock page. A company's
 * earnings date also carries the figures the other tabs hold for it
 * (EarningsFacts).
 */

/** "Mon, Oct 12 · 08:30 - 09:30 GMT+3", "Mon, Oct 12 - Wed, Oct 14", "Mon, Oct 12 · All day". */
export function whenLine(event: CalEvent, zone: string | undefined, zoneText: string, allDayWord: string, locale = "en-US"): string {
  const longDay = (ymd: string) => dayName(ymd, locale);
  if (event.allDay) {
    if (event.endDate && event.endDate !== event.startDate) return `${longDay(event.startDate)} - ${longDay(event.endDate)}`;
    return `${longDay(event.startDate)} · ${allDayWord}`;
  }
  if (event.startMs === null) return "";
  const s = zonedParts(event.startMs, zone);
  if (event.origin === "market") return `${longDay(s.ymd)} · ${hhmm(s.minutes)} ${zoneText}`;
  const e = zonedParts(event.endMs ?? event.startMs, zone);
  const sameDay = e.ymd === s.ymd || (e.minutes === 0 && addDays(s.ymd, 1) === e.ymd);
  return sameDay
    ? `${longDay(s.ymd)} · ${hhmm(s.minutes)} - ${hhmm(e.minutes)} ${zoneText}`
    : `${longDay(s.ymd)} ${hhmm(s.minutes)} - ${longDay(e.ymd)} ${hhmm(e.minutes)} ${zoneText}`;
}

/**
 * "NVDA reports in 12 days": a company date counted down from today (New
 * York's calendar day). Null for a date already behind, a row that is not a
 * company date, or a split (whose ratio the card does not carry).
 */
export function countdownLine(event: CalEvent, today: string, text: BriefingText): string | null {
  if (event.origin !== "market" || !event.corporateKind || !event.allDay) return null;
  const ticker = event.tickers[0];
  if (!ticker) return null;
  const days = daysBetween(today, event.startDate);
  if (days === null || days < 0) return null;
  return countdownSentence(event.corporateKind, ticker, days, text);
}

export default function EventDetails({
  event,
  zone,
  zoneText,
  today,
  nowMs,
  theme,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalEvent;
  zone: string | undefined;
  zoneText: string;
  /** Today's New York calendar date, for the countdown line. */
  today: string;
  /** The clock, for a speech's "Completed". */
  nowMs: number;
  theme: Theme;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => Promise<string | null>;
}) {
  const { t, locale } = useI18n();
  const text = useBriefingText();
  const countdown = countdownLine(event, today, text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shade = eventShade(event.color, theme);
  const lines = econLines(event, nowMs, (key, params) => t(key, params), locale);
  const figures = [lines.actual, lines.forecast, lines.previous].filter((l): l is string => Boolean(l));

  const remove = async () => {
    setBusy(true);
    const problem = await onDelete();
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <div className="p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-[5px] h-[10px] w-[10px] shrink-0 rounded-[3px]" style={{ backgroundColor: shade.accent }} aria-hidden />
        <span className="-ml-1 mt-[3px] flex shrink-0 empty:hidden">
          <Mark event={event} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 data-selectable className="select-text text-[15px] font-medium leading-[1.3] text-[#1d1b1b]">
            {event.title}
          </h3>
          <p className="mt-1 text-[12px] leading-[1.45] text-[#6b7280]">{whenLine(event, zone, zoneText, t("calendar.detail.allDay"), locale)}</p>
          {event.timeLine && event.origin === "market" && !event.allDay ? (
            <p className="text-[11.5px] leading-[1.45] text-[#9CA3AF]">{event.timeLine}</p>
          ) : null}
          {countdown ? <p className="mt-1 text-[12.5px] font-medium leading-[1.45] text-[#1d1b1b]">{countdown}</p> : null}
          {lines.completed ? <p className="mt-1 text-[12.5px] leading-[1.45] text-[#4b5563]">{lines.completed}</p> : null}
          {figures.length > 0 ? (
            <div className="mt-1.5 space-y-0.5">
              {figures.map((line, i) => (
                <p key={line} className={cn("text-[12.5px] leading-[1.45] tabular-nums", i === 0 ? "font-medium text-[#1d1b1b]" : "text-[#6b7280]")}>
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </div>
        <div className="-mr-1.5 -mt-1 flex items-center">
          {event.user ? (
            <>
              <button type="button" className={ICON_BUTTON} onClick={onEdit} aria-label={t("calendar.detail.edit")}>
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
              </button>
              <button type="button" className={ICON_BUTTON} onClick={() => setConfirming(true)} aria-label={t("calendar.detail.delete")}>
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              </button>
            </>
          ) : null}
          <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label={t("common.close")}>
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-[20px]">
        {event.holding ? (
          <span className={cn("rounded-full px-2 py-[2px] text-[11px]", event.holding === "held" ? "bg-black/[0.08] font-medium text-[#1d1b1b]" : "bg-black/[0.04] text-[#4b5563]")}>
            {t(event.holding === "held" ? "calendar.detail.position" : "calendar.detail.watchlist")}
          </span>
        ) : null}
        <span className="rounded-full bg-black/[0.04] px-2 py-[2px] text-[11px] text-[#4b5563]">{event.kindLabel}</span>
        {event.category ? (
          <span className="flex items-center gap-1 rounded-full bg-black/[0.04] px-2 py-[2px] text-[11px] text-[#4b5563]">
            <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: colorAccent(CATEGORY_COLOR[event.category]) }} aria-hidden />
            {sectorLabel(t, event.category)}
          </span>
        ) : null}
        {event.estimated ? <span className="rounded-full bg-[#fef3c7] px-2 py-[2px] text-[11px] text-[#92400e]">{t("calendar.detail.estimated")}</span> : null}
        {event.tickers.map((ticker) => (
          <button
            key={ticker}
            type="button"
            onClick={() => {
              openStock(ticker);
              onClose();
            }}
            className="app-no-drag flex items-center gap-0.5 rounded-full bg-black/[0.04] px-2 py-[2px] text-[11px] text-[#1d1b1b] transition-colors hover:bg-black/[0.06]"
            aria-label={t("calendar.detail.openStock", { ticker })}
          >
            {ticker}
            <ArrowUpRight className="h-3 w-3 text-[#9CA3AF]" strokeWidth={2} aria-hidden />
          </button>
        ))}
      </div>

      {event.detail ? <p className="mt-3 pl-[20px] text-[12.5px] leading-[1.5] text-[#4b5563]">{event.detail}</p> : null}

      {event.notes ? (
        <div className="mt-3 pl-[20px]">
          <div className={MONO_HEAD}>{t("calendar.detail.notes")}</div>
          <p data-selectable className="mt-1 select-text whitespace-pre-wrap text-[12.5px] leading-[1.5] text-[#4b5563]">
            {event.notes}
          </p>
        </div>
      ) : null}

      <EarningsFacts event={event} today={today} onClose={onClose} />

      {event.origin === "market" ? (
        <p className="mt-3 border-t border-black/[0.06] pl-[20px] pt-2.5 text-[11px] leading-[1.45] text-[#9CA3AF]">
          {/* The generic "date from the data provider" line says nothing the
              reader can use, so only a named source is shown. */}
          {[
            event.sourceLabel === t("calendar.source.provider") || event.sourceLabel === t("briefing.source.provider")
              ? null
              : event.sourceLabel,
            t("calendar.detail.readOnly"),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}

      {confirming ? (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-black/[0.06] pt-3">
          <span className="mr-auto text-[12.5px] text-[#1d1b1b]">{t("calendar.detail.deleteConfirm")}</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="app-no-drag rounded-lg bg-[#DC2626] px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#B91C1C] disabled:opacity-60"
          >
            {t("calendar.detail.delete")}
          </button>
        </div>
      ) : null}
      {error ? <p className={cn("mt-2 text-right text-[12px] text-[#DC2626]")}>{error}</p> : null}
    </div>
  );
}
