import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { BUTTON, LABEL, SKELETON, SURFACE, TickerButton, useSay } from "@/components/earnings/earnings-ui";
import EarningsLogo from "@/components/earnings/EarningsLogo";
import { useNa } from "@/lib/i18n/na";
import { useReducedMotionPref } from "@/lib/motion";
import { onReadthroughViewRequest, useHeldPositions, useReadthroughRadar } from "@/lib/readthrough-store";
import { cn } from "@/lib/utils";
import { formatMove, formatSurprise, nyToday, shortDate } from "../../../shared/earnings-view";
import { READTHROUGH_BENCHMARK, READTHROUGH_MAX_EVENTS, READTHROUGH_MIN_EVENTS, type ReadthroughRow } from "../../../shared/readthrough-types";
import { formatRatio, formatSize, headLine, sinceLine, statsLine } from "../../../shared/readthrough-view";
import { LinkLine, NamePill, toneOf } from "./readthrough-ui";

/**
 * The Earnings tab's Read-through section: every pair the radar found (a
 * filing-linked supplier, customer or competitor of the reader's names with
 * a report in the next four weeks or the last week), with the figures
 * behind the card's sentence. A row opens the reports it was measured on,
 * one line each: the session, both moves, the move beyond the market.
 *
 * It sits above the calendar and folds away; the dashboard card's arrow
 * opens it and brings it into view.
 */

const OPEN_KEY = "falcon.ui.readthrough.open.v1";
const ROWS = 8;

const GRID = "grid grid-cols-[84px_minmax(0,1fr)_minmax(0,150px)_64px_76px_88px_72px_72px] items-center gap-x-3";
const NUM = "text-right font-['Geist_Mono'] text-[12px] tabular-nums";
const QUIET = "text-[#9CA3AF]";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* the choice holds for this session */
  }
}

function Heads() {
  const { t } = useSay();
  const head = (text: string, right = false) => (
    <span className={cn(LABEL, "truncate", right && "text-right")} title={text}>
      {text}
    </span>
  );
  return (
    <div className={cn(GRID, "px-2 pb-1 pt-1")} aria-hidden>
      <span />
      {head(t("readthrough.col.report"))}
      {head(t("readthrough.col.link"))}
      {head(t("readthrough.col.withIt"), true)}
      {head(t("readthrough.col.avg"), true)}
      {head(t("readthrough.col.beyond"), true)}
      {head(t("readthrough.col.ratio"), true)}
      {head(t("readthrough.col.next"), true)}
    </div>
  );
}

function Events({ row }: { row: ReadthroughRow }) {
  const { lang, t } = useSay();
  const na = useNa();
  const s = row.stats;
  const EV = "grid grid-cols-[96px_96px_80px_80px_96px_80px_minmax(0,1fr)] items-center gap-x-3";
  const head = (text: string, right = true) => <span className={cn(LABEL, "truncate", right && "text-right")}>{text}</span>;
  const cell = (v: number | null) => <span className={cn(NUM, toneOf(v))}>{formatMove(v, lang) ?? na}</span>;
  return (
    <div className="mb-2 ml-[96px] mr-2 rounded-xl bg-black/[0.025] px-3 py-2.5">
      <div className={cn(EV, "pb-1")} aria-hidden>
        {head(t("readthrough.events.report"), false)}
        {head(t("readthrough.events.session"), false)}
        {head(row.counterparty)}
        {head(row.holding)}
        {head(t("readthrough.col.beyond"))}
        {head(t("readthrough.col.next"))}
        {head(t("readthrough.events.surprise"))}
      </div>
      <ul>
        {row.events.map((e) => (
          <li key={e.reactionDay} className={cn(EV, "py-0.5")}>
            <span className="text-[12px] text-[#4b5563]">{shortDate(e.date, lang)}</span>
            <span className="text-[12px] text-[#9CA3AF]">{shortDate(e.reactionDay, lang)}</span>
            {cell(e.counterpartyMove)}
            {cell(e.holdingMove)}
            {cell(e.holdingAbnormal)}
            {cell(e.holdingNextAbnormal)}
            <span className={cn(NUM, e.surprisePct === null ? QUIET : toneOf(e.surprisePct))}>
              {formatSurprise(e.surprisePct, lang) ?? na}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-[#9CA3AF]">
        {s
          ? t("readthrough.events.caption", { beta: formatRatio(s.beta, lang) ?? "1.0", benchmark: READTHROUGH_BENCHMARK })
          : t("readthrough.events.captionFew", { min: READTHROUGH_MIN_EVENTS })}
        {s?.betaFallback ? ` ${t("readthrough.events.betaFallback")}` : ""}
        {s && s.surpriseEvents > 0 ? ` ${t("readthrough.events.surpriseCount", { holding: row.holding, with: s.withSurprise, count: s.surpriseEvents })}` : ""}
      </p>
    </div>
  );
}

function Row({ row, today, open, onToggle }: { row: ReadthroughRow; today: string; open: boolean; onToggle: () => void }) {
  const { say, lang, t } = useSay();
  const na = useNa();
  const s = row.stats;
  const since = sinceLine(row, say, lang);
  const canOpen = row.events.length > 0;
  return (
    <li>
      <div
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        aria-expanded={canOpen ? open : undefined}
        aria-label={canOpen ? t("readthrough.row.expand", { counterparty: row.counterparty, holding: row.holding }) : undefined}
        onClick={canOpen ? onToggle : undefined}
        onKeyDown={(e) => {
          if (canOpen && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(GRID, "app-no-drag rounded-xl px-2 py-2 outline-none transition-colors", canOpen && "cursor-pointer hover:bg-black/[0.03] focus-visible:bg-black/[0.04]")}
      >
        <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <EarningsLogo ticker={row.counterparty} />
          <TickerButton row={{ ticker: row.counterparty, company: row.counterpartyName }} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-[#1d1b1b]">{headLine(row, today, say, lang)}</span>
          {since || s ? <span className="block truncate text-[11.5px] tabular-nums text-[#6b7280]">{since ?? statsLine(row, say, lang)}</span> : null}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-[12px] font-medium text-[#1d1b1b]">{row.holding}</span>
            <NamePill row={row} />
          </span>
          <LinkLine row={row} />
        </span>
        {s ? (
          <>
            <span className={cn(NUM, "text-[#1d1b1b]")} title={t("readthrough.hint.withIt", { holding: row.holding, counterparty: row.counterparty })}>
              {t("readthrough.cell.of", { with: s.withIt, count: s.events })}
            </span>
            <span className={cn(NUM, "text-[#1d1b1b]")} title={t("readthrough.hint.avg", { holding: row.holding })}>
              {formatSize(s.avgAbsMove, lang) ?? na}
            </span>
            <span className={cn(NUM, "text-[#4b5563]")} title={t("readthrough.hint.beyond", { holding: row.holding, beta: formatRatio(s.beta, lang) ?? "1.0", benchmark: READTHROUGH_BENCHMARK })}>
              {formatSize(s.avgAbsAbnormal, lang) ?? na}
            </span>
            <span
              className={cn(NUM, s.sensitivity === null ? QUIET : "text-[#4b5563]")}
              title={s.normalAbsAbnormal !== null ? t("readthrough.hint.ratio", { counterparty: row.counterparty, usual: formatSize(s.normalAbsAbnormal, lang) ?? na }) : undefined}
            >
              {s.sensitivity === null ? na : t("readthrough.cell.ratio", { ratio: formatRatio(s.sensitivity, lang) ?? "" })}
            </span>
            <span className={cn(NUM, toneOf(s.avgNextFollow))} title={t("readthrough.hint.next", { counterparty: row.counterparty, count: s.nextEvents })}>
              {formatMove(s.avgNextFollow, lang) ?? na}
            </span>
          </>
        ) : (
          <span className="col-span-5 text-right text-[11.5px] text-[#9CA3AF]">{statsLine(row, say, lang)}</span>
        )}
      </div>
      {open && canOpen ? <Events row={row} /> : null}
    </li>
  );
}

export default function ReadthroughSection() {
  const { t } = useSay();
  const held = useHeldPositions();
  const watchlist = useWatchlistTickers();
  const state = useReadthroughRadar(held, watchlist);
  const answer = state.value;
  const today = answer?.today ?? nyToday();
  const reduced = useReducedMotionPref();
  const [open, setOpen] = useState(readOpen);
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => writeOpen(open), [open]);
  useEffect(
    () =>
      onReadthroughViewRequest(() => {
        setOpen(true);
        // After the tab switch has drawn the panel.
        requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" }));
      }),
    [reduced],
  );

  if (held.length === 0 && watchlist.length === 0) return null;

  const rows = (answer?.rows ?? []).filter((r) => r.kind !== "later");
  const shown = all ? rows : rows.slice(0, ROWS);

  let body: ReactNode;
  if (!answer && state.error !== null) {
    body = (
      <div className="flex items-center gap-3 px-5 py-4">
        <p className="text-[12.5px] text-[#6b7280]">{state.error === "restart" ? t("readthrough.error.restart") : t("readthrough.card.failed")}</p>
        {state.error !== "restart" ? (
          <button type="button" onClick={state.retry} className={BUTTON}>
            {t("readthrough.error.retry")}
          </button>
        ) : null}
      </div>
    );
  } else if (!answer) {
    body = (
      <div className="space-y-3 px-5 py-4" aria-hidden>
        {["w-[64%]", "w-[52%]"].map((w) => (
          <div key={w} className={cn(SKELETON, "h-3", w)} />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = <p className="px-5 py-4 text-[12.5px] text-[#6b7280]">{answer.links === 0 ? t("readthrough.card.noLinks") : t("readthrough.card.empty")}</p>;
  } else {
    body = (
      <div className="px-3 pb-3">
        <Heads />
        <ul>
          {shown.map((row) => (
            <Fragment key={row.id}>
              <Row row={row} today={today} open={expanded === row.id} onToggle={() => setExpanded((x) => (x === row.id ? null : row.id))} />
            </Fragment>
          ))}
        </ul>
        {rows.length > shown.length ? (
          <button type="button" onClick={() => setAll(true)} className={cn(BUTTON, "mb-1 ml-2 mt-1")}>
            {t("readthrough.section.showMore", { count: rows.length - shown.length })}
          </button>
        ) : null}
      </div>
    );
  }

  const notes: string[] = [];
  if (answer && rows.length > 0) notes.push(t("readthrough.note.method", { max: READTHROUGH_MAX_EVENTS, min: READTHROUGH_MIN_EVENTS, benchmark: READTHROUGH_BENCHMARK }));
  if (answer?.truncated) notes.push(t("readthrough.note.truncated"));
  if (answer && answer.degraded.length > 0) notes.push(t("readthrough.note.degraded"));

  return (
    <section ref={ref} aria-label={t("readthrough.section.title")} className={cn(SURFACE, "mb-4 scroll-mt-4 overflow-visible")}>
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="app-no-drag flex items-center gap-1.5 rounded-lg px-1 text-[13px] font-medium text-[#1d1b1b] outline-none focus-visible:ring-2 focus-visible:ring-[#9CA3AF]"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 text-[#9CA3AF] transition-transform motion-reduce:transition-none", !open && "-rotate-90")} strokeWidth={2} aria-hidden />
          {t("readthrough.section.title")}
        </button>
        <span className="min-w-0 truncate text-[12px] text-[#9CA3AF]">{t("readthrough.section.intro")}</span>
        {answer && rows.length > 0 ? (
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-[#9CA3AF]">{rows.length === 1 ? t("readthrough.section.countOne") : t("readthrough.section.count", { count: rows.length })}</span>
        ) : null}
      </div>
      {open ? (
        <>
          <div className="border-t-[0.5px] border-black/[0.06]">{body}</div>
          {notes.length > 0 ? (
            <div className="space-y-1 border-t-[0.5px] border-black/[0.06] px-5 py-2.5">
              {notes.map((n) => (
                <p key={n} className="text-[11.5px] leading-[1.45] text-[#9CA3AF]">
                  {n}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

