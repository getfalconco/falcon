import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CalendarViewMode, WeekStart } from "./calendar-dates";
import type { ZoneMode } from "./calendar-prefs";
import { BUTTON, ICON_BUTTON, MONO_HEAD } from "./calendar-styles";

/**
 * The head of the calendar card: the range shown, Today and the arrows, the
 * zone switch (the reader's own clock or New York's, where market events are
 * scheduled), the Day / Week / Month switch and a small menu for the week's
 * layout.
 */

const VIEWS: Array<{ id: CalendarViewMode; key: MessageKey; hint: string }> = [
  { id: "day", key: "calendar.view.day", hint: "D" },
  { id: "week", key: "calendar.view.week", hint: "W" },
  { id: "month", key: "calendar.view.month", hint: "M" },
];

const SEGMENT = "app-no-drag relative rounded-[8px] px-2.5 py-1 text-[12px] transition-colors";

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; text: string; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center rounded-[10px] bg-black/[0.04] p-[2px]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(SEGMENT, value === o.id ? "bg-white/90 text-[#1d1b1b] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-[#6b7280] hover:text-[#1d1b1b]")}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

export default function CalendarHeader({
  title,
  weekNumber,
  view,
  zoneMode,
  localText,
  nyText,
  showZoneSwitch,
  weekStart,
  showWeekends,
  onToday,
  onStep,
  onView,
  onZone,
  onWeekStart,
  onWeekends,
}: {
  title: string;
  weekNumber: number | null;
  view: CalendarViewMode;
  zoneMode: ZoneMode;
  /** "Local time" and "NY time", in the reader's language. */
  localText: string;
  nyText: string;
  showZoneSwitch: boolean;
  weekStart: WeekStart;
  showWeekends: boolean;
  onToday: () => void;
  onStep: (direction: -1 | 1) => void;
  onView: (view: CalendarViewMode) => void;
  onZone: (mode: ZoneMode) => void;
  onWeekStart: (start: WeekStart) => void;
  onWeekends: (show: boolean) => void;
}) {
  const t = useT();
  const reduce = useReducedMotion();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] px-4 py-3">
      <h2 className="min-w-0 truncate text-[17px] font-medium text-[#1d1b1b]" aria-live="polite">
        {title}
      </h2>
      {weekNumber !== null ? <span className={cn(MONO_HEAD, "mt-[3px] shrink-0")}>{t("calendar.weekNumber", { n: weekNumber })}</span> : null}

      <div className="ml-2 flex items-center gap-0.5">
        <button type="button" className={ICON_BUTTON} onClick={() => onStep(-1)} aria-label={t("calendar.previous")} title={`${t("calendar.previous")} (←)`}>
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
        </button>
        <button type="button" className={ICON_BUTTON} onClick={() => onStep(1)} aria-label={t("calendar.next")} title={`${t("calendar.next")} (→)`}>
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </button>
        <button type="button" className={cn(BUTTON, "ml-1 py-1")} onClick={onToday} title={`${t("calendar.today")} (T)`}>
          {t("calendar.today")}
        </button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {showZoneSwitch ? (
          <Segmented
            value={zoneMode}
            label={t("calendar.zone.label")}
            onChange={onZone}
            options={[
              { id: "local", text: localText, title: t("calendar.zone.local") },
              { id: "et", text: nyText, title: t("calendar.zone.et") },
            ]}
          />
        ) : null}
        <Segmented
          value={view}
          label={t("calendar.view.label")}
          onChange={onView}
          options={VIEWS.map((v) => ({ id: v.id, text: t(v.key), title: `${t(v.key)} (${v.hint})` }))}
        />
        <div ref={menuRef} className="relative">
          <button type="button" className={ICON_BUTTON} onClick={() => setMenu((m) => !m)} aria-label={t("calendar.options")} aria-expanded={menu}>
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
          <AnimatePresence>
            {menu ? (
              <motion.div
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: reduce ? 0 : 0.12 }}
                className="app-no-drag absolute right-0 top-full z-50 mt-2 w-52 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
              >
                <div className={cn(MONO_HEAD, "px-2 pb-1 pt-1")}>{t("calendar.options.weekStart")}</div>
                {([1, 0] as WeekStart[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => onWeekStart(d)}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] text-[#1d1b1b] hover:bg-black/[0.05]"
                  >
                    {d === 1 ? t("calendar.options.monday") : t("calendar.options.sunday")}
                    {weekStart === d ? <Check className="h-3.5 w-3.5 text-[#4b5563]" strokeWidth={2} /> : null}
                  </button>
                ))}
                <div className="my-1 border-t border-black/[0.06]" />
                <button
                  type="button"
                  role="switch"
                  aria-checked={showWeekends}
                  onClick={() => onWeekends(!showWeekends)}
                  className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] text-[#1d1b1b] hover:bg-black/[0.05]"
                >
                  {t("calendar.options.weekends")}
                  {showWeekends ? <Check className="h-3.5 w-3.5 text-[#4b5563]" strokeWidth={2} /> : null}
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
