import { useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useCalendarScope, writeCalendarScope, type CalendarScope } from "@/lib/calendar-scope";

/**
 * "Important | All": the one choice both calendars share (lib/calendar-scope).
 * "Important" keeps the reader's own names and the high-impact releases of
 * the US, the major European economies and their region; "All" is the whole
 * economic calendar. A text-only segmented control.
 */

const SCOPES: ReadonlyArray<{ id: CalendarScope; key: MessageKey }> = [
  { id: "important", key: "calendar.scope.important" },
  { id: "all", key: "calendar.scope.all" },
];

export default function ScopeSwitch({ className }: { className?: string }) {
  const { t } = useI18n();
  const value = useCalendarScope();
  return (
    <div role="radiogroup" aria-label={t("calendar.scope.label")} className={cn("flex items-center rounded-[10px] bg-black/[0.05] p-[2px]", className)}>
      {SCOPES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={value === s.id}
          onClick={() => writeCalendarScope(s.id)}
          className={cn(
            "app-no-drag flex-1 whitespace-nowrap rounded-[8px] px-3 py-1 text-[12px] font-medium transition-colors",
            value === s.id ? "bg-white/90 text-[#1d1b1b] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-[#6b7280] hover:text-[#1d1b1b]",
          )}
        >
          {t(s.key)}
        </button>
      ))}
    </div>
  );
}
