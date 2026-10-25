import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { sectorLabel, validationMessage } from "./sector-labels";
import { cn } from "@/lib/utils";
import type { StockCatalogEntry } from "../../../shared/stock-catalog";
import {
  CALENDAR_COLORS,
  CALENDAR_SECTORS,
  CATEGORY_COLOR,
  USER_EVENT_NOTES_MAX,
  USER_EVENT_TITLE_MAX,
  isCalendarSector,
  validateUserEventInput,
  type CalendarColor,
  type CalendarSector,
  type UserCalendarEvent,
  type UserCalendarEventInput,
} from "../../../shared/calendar-events";
import { colorAccent } from "./calendar-colors";
import { addDays, hhmm, parseHhmm, zonedParts, zonedWallToMs } from "./calendar-dates";
import { BUTTON, FIELD, ICON_BUTTON, MONO_HEAD } from "./calendar-styles";
import type { CreateRequest } from "./TimeGridView";

/**
 * Creating or editing one of the reader's own events. Times are typed in the
 * zone the calendar is showing (named beside them) and saved as instants, so
 * the event stays put when the view switches zone. An end at or before the
 * start runs past midnight into the next day. The ticker field suggests from
 * the app's own symbol search; picking a followed name fills its sector.
 */

type Form = {
  title: string;
  allDay: boolean;
  date: string;
  endDate: string;
  start: string;
  end: string;
  ticker: string;
  sector: CalendarSector | "";
  color: CalendarColor;
  colorTouched: boolean;
  notes: string;
};

function formFrom(source: { request: CreateRequest } | { event: UserCalendarEvent }, zone: string | undefined): Form {
  if ("event" in source) {
    const e = source.event;
    if (e.all_day) {
      return { title: e.title, allDay: true, date: e.date ?? "", endDate: e.end_date ?? e.date ?? "", start: "09:00", end: "10:00", ticker: e.ticker ?? "", sector: e.sector ?? "", color: e.color, colorTouched: true, notes: e.notes };
    }
    const s = zonedParts(Date.parse(e.start_at ?? ""), zone);
    const en = zonedParts(Date.parse(e.end_at ?? ""), zone);
    return { title: e.title, allDay: false, date: s.ymd, endDate: s.ymd, start: hhmm(s.minutes), end: hhmm(en.minutes), ticker: e.ticker ?? "", sector: e.sector ?? "", color: e.color, colorTouched: true, notes: e.notes };
  }
  const r = source.request;
  if (r.allDay) return { title: "", allDay: true, date: r.date, endDate: r.endDate, start: "09:00", end: "10:00", ticker: "", sector: "", color: "blue", colorTouched: false, notes: "" };
  const s = zonedParts(r.startMs, zone);
  const en = zonedParts(r.endMs, zone);
  return { title: "", allDay: false, date: s.ymd, endDate: s.ymd, start: hhmm(s.minutes), end: hhmm(en.minutes), ticker: "", sector: "", color: "blue", colorTouched: false, notes: "" };
}

/** The form as the IPC input, or null when a time cannot be read. */
function inputFrom(form: Form, zone: string | undefined): UserCalendarEventInput | null {
  const common = {
    title: form.title,
    ticker: form.ticker.trim() || null,
    sector: form.sector || null,
    color: form.color,
    notes: form.notes,
  };
  if (form.allDay) {
    return { ...common, all_day: true, date: form.date, end_date: form.endDate || form.date, start_at: null, end_at: null };
  }
  const start = parseHhmm(form.start);
  const end = parseHhmm(form.end);
  if (start === null || end === null || !form.date) return null;
  const startMs = zonedWallToMs(form.date, start, zone);
  const endMs = end > start ? zonedWallToMs(form.date, end, zone) : zonedWallToMs(addDays(form.date, 1), end, zone);
  return { ...common, all_day: false, date: null, end_date: null, start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString() };
}

const LABEL = "w-[64px] shrink-0 text-[12px] text-content-secondary";

/**
 * A 24-hour "HH:MM" field, the clock the rest of the app prints. A native
 * time input would follow the machine's locale into "02:00 PM" and not fit;
 * this one takes "9", "930", "9:30" or "21:05" and tidies it on leaving.
 */
function TimeField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const tidy = (text: string): string => {
    const digits = text.replace(/[^0-9:]/g, "");
    let candidate = digits;
    if (!digits.includes(":")) {
      if (digits.length <= 2) candidate = `${digits}:00`;
      else candidate = `${digits.slice(0, -2)}:${digits.slice(-2)}`;
    }
    const minutes = parseHhmm(candidate);
    return minutes === null || minutes >= 1440 ? text : hhmm(minutes);
  };
  return (
    <input
      value={value}
      inputMode="numeric"
      maxLength={5}
      placeholder="09:30"
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onChange(tidy(e.target.value))}
      className={cn(FIELD, "h-8 w-[64px] px-2 text-center text-[12.5px] tabular-nums")}
    />
  );
}

export default function EventEditor({
  source,
  zone,
  zoneText,
  sectorOf,
  onDraft,
  onCancel,
  onSave,
}: {
  source: { request: CreateRequest } | { event: UserCalendarEvent };
  zone: string | undefined;
  zoneText: string;
  sectorOf: (ticker: string) => CalendarSector | null;
  /** Called as the dates and times change, so the grid's ghost follows the form. */
  onDraft: (request: CreateRequest | null) => void;
  onCancel: () => void;
  onSave: (input: UserCalendarEventInput) => Promise<string | null>;
}) {
  const t = useT();
  const editing = "event" in source;
  const [form, setForm] = useState<Form>(() => formFrom(source, zone));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  // The grid's ghost follows the dates and times typed here.
  const input = useMemo(() => inputFrom(form, zone), [form, zone]);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  useEffect(() => {
    if (!input) return;
    if (input.all_day && input.date) onDraftRef.current({ allDay: true, date: input.date, endDate: input.end_date ?? input.date });
    else if (input.start_at && input.end_at) onDraftRef.current({ allDay: false, startMs: Date.parse(input.start_at), endMs: Date.parse(input.end_at) });
  }, [input]);

  // --- Ticker suggestions --------------------------------------------------
  const [suggestions, setSuggestions] = useState<StockCatalogEntry[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const query = form.ticker.trim();
    const search = window.meridian?.searchStockSymbols;
    if (!suggestOpen || query.length < 1 || !search) {
      setSuggestions([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      search(query, 6)
        .then((list) => {
          if (live) {
            setSuggestions(Array.isArray(list) ? list.slice(0, 6) : []);
            setActive(0);
          }
        })
        .catch(() => live && setSuggestions([]));
    }, 140);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [form.ticker, suggestOpen]);

  const pickTicker = (entry: StockCatalogEntry) => {
    const ticker = entry.symbol.toUpperCase();
    setForm((f) => {
      const sector = f.sector || sectorOf(ticker) || "";
      return { ...f, ticker, sector, color: f.colorTouched || !sector ? f.color : CATEGORY_COLOR[sector] };
    });
    setSuggestOpen(false);
  };

  const onTickerKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!suggestOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickTicker(suggestions[active]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setSuggestOpen(false);
    }
  };

  const save = async () => {
    if (saving) return;
    if (!input) {
      setError(t("calendar.editor.badTime"));
      return;
    }
    const checked = validateUserEventInput(input);
    if (!checked.ok) {
      setError(validationMessage(t, checked));
      return;
    }
    setSaving(true);
    setError(null);
    const problem = await onSave(checked.value);
    setSaving(false);
    if (problem) setError(problem);
  };

  return (
    <form
      className="p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className={MONO_HEAD}>{editing ? t("calendar.editor.editTitle") : t("calendar.editor.newTitle")}</span>
        <button type="button" className={cn(ICON_BUTTON, "-mr-1.5")} onClick={onCancel} aria-label={t("common.close")}>
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <input
        ref={titleRef}
        value={form.title}
        maxLength={USER_EVENT_TITLE_MAX}
        onChange={(e) => set("title", e.target.value)}
        placeholder={t("calendar.editor.titlePlaceholder")}
        aria-label={t("calendar.editor.titlePlaceholder")}
        className={cn(FIELD, "h-10 w-full text-[14.5px]")}
      />

      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2">
          <span className={LABEL}>{t("calendar.editor.allDay")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={form.allDay}
            onClick={() => set("allDay", !form.allDay)}
            className={cn("app-no-drag relative h-[18px] w-[30px] rounded-full transition-colors", form.allDay ? "bg-ink" : "bg-black/[0.12]")}
          >
            <span className={cn("absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left]", form.allDay ? "left-[14px]" : "left-[2px]")} />
          </button>
        </label>

        {form.allDay ? (
          <>
            <div className="flex items-center gap-2">
              <span className={LABEL}>{t("calendar.editor.date")}</span>
              <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate }))} className={cn(FIELD, "h-8 flex-1 text-[12.5px]")} />
            </div>
            <div className="flex items-center gap-2">
              <span className={LABEL}>{t("calendar.editor.endDate")}</span>
              <input type="date" value={form.endDate} min={form.date} onChange={(e) => set("endDate", e.target.value)} className={cn(FIELD, "h-8 flex-1 text-[12.5px]")} />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className={LABEL}>{t("calendar.editor.date")}</span>
              <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} className={cn(FIELD, "h-8 flex-1 text-[12.5px]")} />
            </div>
            <div className="flex items-center gap-2">
              <span className={LABEL}>{t("calendar.editor.time")}</span>
              <TimeField value={form.start} onChange={(v) => set("start", v)} label={t("calendar.editor.start")} />
              <span className="text-[12px] text-content-tertiary">-</span>
              <TimeField value={form.end} onChange={(v) => set("end", v)} label={t("calendar.editor.end")} />
              <span className="ml-auto text-[10px] text-content-tertiary">{zoneText}</span>
            </div>
          </>
        )}

        <div className="relative flex items-center gap-2">
          <span className={LABEL}>{t("calendar.editor.ticker")}</span>
          <input
            value={form.ticker}
            onChange={(e) => {
              set("ticker", e.target.value.toUpperCase());
              setSuggestOpen(true);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 120)}
            onKeyDown={onTickerKey}
            placeholder={t("calendar.editor.tickerPlaceholder")}
            aria-label={t("calendar.editor.ticker")}
            aria-autocomplete="list"
            aria-expanded={suggestOpen && suggestions.length > 0}
            className={cn(FIELD, "h-8 flex-1 text-[12.5px]")}
          />
          {suggestOpen && suggestions.length > 0 ? (
            <ul role="listbox" className="absolute left-[72px] right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-white/60 bg-surface-2 p-1 shadow-[0_12px_32px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]">
              {suggestions.map((s, i) => (
                <li key={s.symbol} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickTicker(s)}
                    onMouseEnter={() => setActive(i)}
                    className={cn("app-no-drag flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", i === active && "bg-black/[0.05]")}
                  >
                    <span className="w-[52px] shrink-0 text-[11.5px] text-content-primary">{s.symbol}</span>
                    <span className="truncate text-[12px] text-content-secondary">{s.companyName}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className={LABEL}>{t("calendar.editor.sector")}</span>
          <select
            value={form.sector}
            onChange={(e) => {
              const sector = isCalendarSector(e.target.value) ? e.target.value : "";
              setForm((f) => ({ ...f, sector, color: f.colorTouched || !sector ? f.color : CATEGORY_COLOR[sector] }));
            }}
            aria-label={t("calendar.editor.sector")}
            className={cn(FIELD, "h-8 flex-1 text-[12.5px]")}
          >
            <option value="">{t("calendar.editor.noSector")}</option>
            {CALENDAR_SECTORS.map((s) => (
              <option key={s} value={s}>
                {sectorLabel(t, s)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className={LABEL}>{t("calendar.editor.color")}</span>
          <div className="flex flex-wrap gap-[5px]" role="radiogroup" aria-label={t("calendar.editor.color")}>
            {CALENDAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={form.color === c}
                aria-label={c}
                onClick={() => setForm((f) => ({ ...f, color: c, colorTouched: true }))}
                className="app-no-drag flex h-[16px] w-[16px] items-center justify-center rounded-full transition-transform hover:scale-110"
                style={{ backgroundColor: colorAccent(c), boxShadow: form.color === c ? `0 0 0 2px rgba(255,255,255,0.9), 0 0 0 3.5px ${colorAccent(c)}` : undefined }}
              />
            ))}
          </div>
        </div>

        <textarea
          value={form.notes}
          maxLength={USER_EVENT_NOTES_MAX}
          onChange={(e) => set("notes", e.target.value)}
          placeholder={t("calendar.editor.notesPlaceholder")}
          aria-label={t("calendar.editor.notes")}
          rows={2}
          className={cn(FIELD, "mt-1 block w-full resize-none py-2 text-[12.5px] leading-relaxed")}
        />
      </div>

      {error ? <p className="mt-2 text-[12px] leading-[1.45] text-tone-negative">{error}</p> : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" disabled={saving} className="glass-cta cta-primary app-no-drag px-4 py-1.5 text-[12.5px] font-medium disabled:opacity-60">
          {saving ? t("calendar.editor.saving") : t("calendar.editor.save")}
        </button>
      </div>
    </form>
  );
}
