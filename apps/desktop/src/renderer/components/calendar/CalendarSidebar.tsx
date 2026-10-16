import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { upperIn, useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import type { Agenda, AgendaRow } from "../../../shared/calendar-agenda";
import {
  CALENDAR_EVENT_TYPES,
  CATEGORY_COLOR,
  type CalendarCategory,
  type CalendarEventType,
} from "../../../shared/calendar-events";
import { colorAccent, nowLineColor } from "./calendar-colors";
import { addMonths, fullDay, monthGrid, monthTitle, sameMonth, startOfMonth, weekday, weekdayInitials, type WeekStart } from "./calendar-dates";
import type { CalendarFilters } from "./calendar-model";
import { ICON_BUTTON, SECTION_LABEL } from "./calendar-styles";
import { sectorLabel } from "./sector-labels";

/**
 * The calendar's left column: the button for a new event, a small month to
 * jump with, and the filters, Notion style: a checkable list per facet, each
 * row with its colour dot. Under them, the quiet lines that say how far the
 * data reaches.
 */

export const TYPE_LABEL_KEY: Record<CalendarEventType, MessageKey> = {
  earnings: "calendar.type.earnings",
  macro: "calendar.type.macro",
  fed: "calendar.type.fed",
  corporate: "calendar.type.corporate",
  derivatives: "calendar.type.derivatives",
  session: "calendar.type.session",
  mine: "calendar.type.mine",
};

/** The dot beside an event type: market-wide types wear the market-wide colour, the rest a neutral of their own. */
const TYPE_DOT: Record<CalendarEventType, string> = {
  earnings: "#3b82f6",
  macro: colorAccent(CATEGORY_COLOR["Market-wide"]),
  fed: "#6366f1",
  corporate: "#14b8a6",
  derivatives: "#64748b",
  session: "#78716c",
  mine: "#ec4899",
};

function MiniMonth({
  anchor,
  today,
  weekStart,
  highlight,
  marked,
  theme,
  onPick,
}: {
  anchor: string;
  today: string;
  weekStart: WeekStart;
  /** The days the main view shows, tinted here. */
  highlight: ReadonlySet<string>;
  /** Days with something on them, dotted. */
  marked: ReadonlySet<string>;
  theme: Theme;
  onPick: (ymd: string) => void;
}) {
  const { t, locale } = useI18n();
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  // Follow the main view when it leaves the month shown here.
  useEffect(() => {
    if (!sameMonth(month, anchor)) setMonth(startOfMonth(anchor));
  }, [anchor]);
  const grid = monthGrid(month, weekStart);
  const red = nowLineColor(theme);

  return (
    <div className="select-none">
      <div className="mb-1 flex items-center justify-between pl-1">
        <span className="text-[12.5px] font-medium text-[#1d1b1b]">
          {monthTitle(month, locale)}
        </span>
        <div className="flex items-center">
          <button type="button" className={cn(ICON_BUTTON, "h-6 w-6")} aria-label={t("calendar.previous")} onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button type="button" className={cn(ICON_BUTTON, "h-6 w-6")} aria-label={t("calendar.next")} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center">
        {grid.slice(0, 7).map((d) => (
          <span key={d} className="pb-1 text-[9.5px] uppercase text-[#9CA3AF]">
            {weekdayInitials(locale)[weekday(d)]}
          </span>
        ))}
        {grid.map((d) => {
          const isToday = d === today;
          const inMonth = sameMonth(d, month);
          const lit = highlight.has(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              aria-label={fullDay(d, locale)}
              aria-current={isToday ? "date" : undefined}
              className={cn(
                "app-no-drag relative mx-auto my-[1px] flex h-[24px] w-full items-center justify-center text-[11.5px] tabular-nums transition-colors",
                lit ? "bg-black/[0.05]" : "hover:bg-black/[0.04]",
                isToday ? "font-medium" : inMonth ? "text-[#1d1b1b]" : "text-[#9CA3AF]",
              )}
            >
              <span
                className={cn("flex h-[20px] w-[20px] items-center justify-center rounded-full", isToday && "text-white")}
                style={isToday ? { backgroundColor: red } : undefined}
              >
                {Number(d.slice(8))}
              </span>
              {marked.has(d) && !isToday ? <span className="absolute bottom-[1px] h-[3px] w-[3px] rounded-full bg-[#9CA3AF]" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CheckRow({ label, color, checked, count, onToggle, onOnly }: { label: string; color: string; checked: boolean; count?: number; onToggle: () => void; onOnly?: () => void }) {
  return (
    <div className="group flex items-center">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        onDoubleClick={onOnly}
        className="app-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-[5px] text-left transition-colors hover:bg-black/[0.04]"
      >
        <span
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] border transition-colors"
          style={{ backgroundColor: checked ? color : "transparent", borderColor: color }}
          aria-hidden
        >
          {checked ? <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} /> : null}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", checked ? "text-[#1d1b1b]" : "text-[#9CA3AF]")}>{label}</span>
        {count !== undefined && count > 0 ? <span className="shrink-0 text-[10px] tabular-nums text-[#9CA3AF]">{count}</span> : null}
      </button>
    </div>
  );
}

/** How many of the reader's own dates the column lists before the grid takes over. */
const HELD_ROWS = 5;
const WATCH_ROWS = 3;

/** One of the reader's dates: the countdown sentence, and the date it lands on. Pressing it shows that day. */
function AgendaButton({ row, onPick }: { row: AgendaRow; onPick: (ymd: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(row.date)}
      className="app-no-drag flex w-full items-baseline gap-2 rounded-lg px-1.5 py-[5px] text-left transition-colors hover:bg-black/[0.04]"
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[12px] leading-[1.35]", row.tier === "held" ? "font-medium text-[#1d1b1b]" : "text-[#4b5563]")}>{row.text}</span>
        {row.estimated && row.detail ? <span className="block text-[10.5px] leading-[1.35] text-[#9CA3AF]">{row.detail}</span> : null}
      </span>
      <span className={cn("shrink-0 text-[10px] uppercase tabular-nums", row.daysUntil === 0 ? "text-[#189e9a]" : "text-[#9CA3AF]")}>{row.dateLabel}</span>
    </button>
  );
}

/**
 * The reader's own dates at the head of the column: held names first, then
 * the watchlist, each counted down from today, with the switch that draws
 * held names' dates emphasised on the grid.
 */
function PositionsSection({
  agenda,
  holdsAny,
  highlight,
  onHighlight,
  onPick,
}: {
  agenda: Agenda;
  holdsAny: boolean;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  onPick: (ymd: string) => void;
}) {
  const { t, locale } = useI18n();
  const heldRows = agenda.rows.filter((r) => r.tier === "held").slice(0, HELD_ROWS);
  const watchRows = agenda.rows.filter((r) => r.tier === "watchlist").slice(0, WATCH_ROWS);
  return (
    <section aria-label={t("briefing.agenda.positionsHead")}>
      {holdsAny ? (
        <>
          <div className="mb-1 px-1.5">
            <span className={SECTION_LABEL}>{upperIn(t("briefing.agenda.positionsHead"), locale)}</span>
          </div>
          {heldRows.map((row) => (
            <AgendaButton key={row.id} row={row} onPick={onPick} />
          ))}
        </>
      ) : null}
      {agenda.note ? <p className="px-1.5 pb-1 pt-0.5 text-[11px] leading-[1.45] text-[#9CA3AF]">{agenda.note}</p> : null}
      {watchRows.length > 0 ? (
        <>
          <div className={cn("mb-1 px-1.5", holdsAny && "mt-2")}>
            <span className={SECTION_LABEL}>{upperIn(t("briefing.agenda.watchlistHead"), locale)}</span>
          </div>
          {watchRows.map((row) => (
            <AgendaButton key={row.id} row={row} onPick={onPick} />
          ))}
        </>
      ) : null}
      {holdsAny ? (
        <div className="mt-1.5 border-t border-black/[0.06] pt-1.5">
          <CheckRow label={t("calendar.positions.highlight")} color="#6b7280" checked={highlight} onToggle={() => onHighlight(!highlight)} />
        </div>
      ) : null}
    </section>
  );
}

export type SidebarProps = {
  anchor: string;
  today: string;
  weekStart: WeekStart;
  visible: ReadonlySet<string>;
  marked: ReadonlySet<string>;
  theme: Theme;
  filters: CalendarFilters;
  categories: CalendarCategory[];
  /** Events per type and per category in the shown range, before filtering. */
  typeCounts: Partial<Record<CalendarEventType, number>>;
  categoryCounts: Partial<Record<CalendarCategory, number>>;
  hasWatchlist: boolean;
  /** The reader's own upcoming dates, ranked held first (`shared/calendar-agenda.ts`). */
  agenda: Agenda;
  holdsAny: boolean;
  highlightPositions: boolean;
  onHighlightPositions: (on: boolean) => void;
  notes: Array<{ text: string; tone: "quiet" | "warn" }>;
  onPick: (ymd: string) => void;
  onNewEvent: (anchor: DOMRect) => void;
  onFilters: (next: CalendarFilters) => void;
};

function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function CalendarSidebar(props: SidebarProps) {
  const { t, locale } = useI18n();
  const { filters } = props;
  const filtered = filters.hiddenTypes.length > 0 || filters.hiddenCategories.length > 0 || filters.watchlistOnly;

  return (
    <aside className="scrollbar-meridian flex w-[220px] shrink-0 flex-col gap-5 overflow-y-auto pb-2 pr-1" aria-label={t("calendar.title")}>
      <button
        type="button"
        onClick={(e) => props.onNewEvent(e.currentTarget.getBoundingClientRect())}
        className="glass-cta app-no-drag flex w-full items-center justify-center gap-1.5 py-2 text-[12.5px] font-medium"
      >
        {t("calendar.newEvent")}
      </button>

      <MiniMonth
        anchor={props.anchor}
        today={props.today}
        weekStart={props.weekStart}
        highlight={props.visible}
        marked={props.marked}
        theme={props.theme}
        onPick={props.onPick}
      />

      <PositionsSection
        agenda={props.agenda}
        holdsAny={props.holdsAny}
        highlight={props.highlightPositions}
        onHighlight={props.onHighlightPositions}
        onPick={props.onPick}
      />

      <section>
        <div className="mb-1 flex items-center justify-between px-1.5">
          <span className={SECTION_LABEL}>{upperIn(t("calendar.filters.types"), locale)}</span>
          {filtered ? (
            <button
              type="button"
              onClick={() => props.onFilters({ hiddenTypes: [], hiddenCategories: [], watchlistOnly: false })}
              className="app-no-drag text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
            >
              {t("calendar.filters.reset")}
            </button>
          ) : null}
        </div>
        {CALENDAR_EVENT_TYPES.map((type) => (
          <CheckRow
            key={type}
            label={t(TYPE_LABEL_KEY[type])}
            color={TYPE_DOT[type]}
            checked={!filters.hiddenTypes.includes(type)}
            count={props.typeCounts[type]}
            onToggle={() => props.onFilters({ ...filters, hiddenTypes: toggled(filters.hiddenTypes, type) })}
            onOnly={() => props.onFilters({ ...filters, hiddenTypes: CALENDAR_EVENT_TYPES.filter((x) => x !== type) })}
          />
        ))}
      </section>

      {props.categories.length > 0 ? (
        <section>
          <div className="mb-1 px-1.5">
            <span className={SECTION_LABEL}>{upperIn(t("calendar.filters.sectors"), locale)}</span>
          </div>
          {props.categories.map((category) => (
            <CheckRow
              key={category}
              label={sectorLabel(t, category)}
              color={colorAccent(CATEGORY_COLOR[category])}
              checked={!filters.hiddenCategories.includes(category)}
              count={props.categoryCounts[category]}
              onToggle={() => props.onFilters({ ...filters, hiddenCategories: toggled(filters.hiddenCategories, category) })}
              onOnly={() => props.onFilters({ ...filters, hiddenCategories: props.categories.filter((c) => c !== category) })}
            />
          ))}
          {props.hasWatchlist ? (
            <div className="mt-1.5 border-t border-black/[0.06] pt-1.5">
              <CheckRow
                label={t("calendar.filters.watchlistOnly")}
                color="#6b7280"
                checked={filters.watchlistOnly}
                onToggle={() => props.onFilters({ ...filters, watchlistOnly: !filters.watchlistOnly })}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {props.notes.length > 0 ? (
        <div className="mt-auto space-y-1.5 border-t border-black/[0.06] px-1.5 pt-3">
          {props.notes.map((n) => (
            <p key={n.text} className={cn("text-[11px] leading-[1.45]", n.tone === "warn" ? "text-[#D97706]" : "text-[#9CA3AF]")}>
              {n.text}
            </p>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
