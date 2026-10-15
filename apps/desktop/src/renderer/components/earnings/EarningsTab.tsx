import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { useNa } from "@/lib/i18n/na";
import { useEarnings, useEarningsReactions, useProfileSectors, type EarningsAnswer } from "@/lib/earnings-store";
import { cn } from "@/lib/utils";
import { useLiveQuotes } from "@/hooks/useLivePrices";
import { useHeldTickers, useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { sectorLabel } from "@/components/calendar/sector-labels";
import { CALENDAR_SECTORS } from "../../../shared/calendar-events";
import {
  EARNINGS_TIMES,
  type EarningsReaction,
  type EarningsRow,
  type EarningsScope,
  type EarningsTime,
} from "../../../shared/earnings-types";
import { reactionSession } from "../../../shared/earnings-time";
import {
  addDaysYmd,
  consensusText,
  countText,
  dayMoveOf,
  degradedNoticeable,
  filterRows,
  filtersActive,
  formatEps,
  formatMove,
  formatRevenueIn,
  formatSurprise,
  formatUsd,
  formatUsualMove,
  headerLine,
  isOut,
  nyToday,
  releaseTimeText,
  sectionRows,
  sectorsIn,
  shortCompanyName,
  shortDate,
  type EarningsFilters,
  type EarningsSection,
} from "../../../shared/earnings-view";
import EarningsDrawer from "./EarningsDrawer";
import { useImpliedMoves } from "@/lib/implied-move-store";
import { useEstimateRevisions } from "@/lib/estimates-store";
import {
  ESTIMATES_REQUEST_CAP,
  ESTIMATES_WITHIN_DAYS,
  estimateHint,
  estimateLine,
  isNotable,
  reportPeriod,
  type PeriodEstimates,
} from "../../../shared/estimate-revisions";
import { IMPLIED_REQUEST_CAP, IMPLIED_WITHIN_DAYS, impliedHint, impliedLine, type ImpliedMove, type ImpliedRequestItem } from "../../../shared/implied-move";
import ReadthroughSection from "@/components/readthrough/ReadthroughSection";
import EarningsLogo from "./EarningsLogo";
import {
  BUTTON,
  FIELD,
  FilterMenu,
  HeldMarker,
  LABEL,
  LinkChips,
  RowBadges,
  SKELETON,
  SURFACE,
  Segmented,
  TickerButton,
  timeLabel,
  useSay,
} from "./earnings-ui";

/**
 * Earnings: what each report means for the reader, in three sections
 * (reported this week, today, upcoming), for the reader's names, the names
 * the Tracker covers, or the whole market when its calendar can be read.
 *
 * Each row answers three questions from data alone: does this touch me (the
 * held or watched mark), how does this stock usually react (the mean size of
 * its last four report-day moves), and where does it spread (the reader's
 * names a 10-K or 20-F links to it). A reported row shows the actual against
 * the consensus as it stood before the release, and the move of the session
 * that first traded it. A figure no provider gave is left as the "not
 * available" mark. The row opens a drawer with the quarters and moves behind
 * these figures; the ticker opens the stock view.
 */

// v2: "For you" became the default for everyone, so an older saved choice is not carried over.
const PREFS_KEY = "falcon.ui.earnings.v2";
/** In the market-wide view a busy day has hundreds of reports; a day shows this many until asked for more. */
const DAY_CAP = 40;
/** "For you" is a reading list, not a calendar: a day shows this many until asked for more. */
const DAY_CAP_FORYOU = 12;
/** Live quotes are polled for at most this many reported rows. */
const LIVE_CAP = 24;

type Range = "2w" | "4w";
type Prefs = { scope: EarningsScope; range: Range };

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    return {
      scope: raw?.scope === "mine" || raw?.scope === "tracked" || raw?.scope === "all" ? raw.scope : "foryou",
      range: raw?.range === "2w" ? "2w" : "4w",
    };
  } catch {
    return { scope: "foryou", range: "4w" };
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* the choice holds for this session */
  }
}

/** Which scopes the last answer said can be asked for; kept for the session so the switch does not flicker. */
let knownScopes: EarningsAnswer["scopes"] | null = null;

const GRID = "grid grid-cols-[10px_84px_minmax(0,1fr)_96px_100px_100px_104px_72px_minmax(0,116px)] items-center gap-x-3";
const NUM = "text-right font-['Geist_Mono'] text-[12px] tabular-nums";
const QUIET = "text-[#9CA3AF]";

function Skeleton() {
  return (
    <div className="space-y-6 px-5 py-5" aria-hidden>
      {[0, 1, 2].map((g) => (
        <div key={g} className="space-y-3">
          <div className={cn(SKELETON, "h-3 w-28")} />
          {["w-[62%]", "w-[48%]", "w-[56%]"].map((w) => (
            <div key={w} className={GRID}>
              <div />
              <div className="flex items-center gap-2">
                <div className={cn(SKELETON, "h-5 w-5 rounded-full")} />
                <div className={cn(SKELETON, "h-[18px] w-12")} />
              </div>
              <div className={cn(SKELETON, "h-3", w)} />
              <div className={cn(SKELETON, "h-3 w-16")} />
              <div className={cn(SKELETON, "h-3 w-12")} />
              <div className={cn(SKELETON, "h-3 w-12")} />
              <div className={cn(SKELETON, "h-3 w-10")} />
              <div className={cn(SKELETON, "h-3 w-10")} />
              <div />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[320px] flex-col items-center justify-center px-8 py-12 text-center">{children}</div>;
}

/** The quiet time text: the release minute once on record, the hour bucket before. */
function TimeCell({ row }: { row: EarningsRow }) {
  const { say, t } = useSay();
  const exact = releaseTimeText(row.releasedAt, say);
  const text = exact ?? (row.time === "unknown" ? "" : timeLabel(t, row.time));
  return (
    <span title={timeLabel(t, row.time)} className={cn("truncate text-[11.5px]", exact ? "text-[#4b5563]" : QUIET)}>
      {text}
    </span>
  );
}

function EpsCell({ row }: { row: EarningsRow }) {
  const { say, lang, t } = useSay();
  const na = useNa();
  if (isOut(row)) {
    const actual = formatEps(row.epsActual, lang);
    const est = formatEps(row.epsEstimate, lang);
    if (actual === null) return <span className={cn(NUM, QUIET)}>{row.phase === "pending" ? t("earnings.cell.pending") : na}</span>;
    const diff = row.epsEstimate !== null && row.epsActual !== null ? row.epsActual - row.epsEstimate : null;
    const verdict = diff === null ? undefined : diff > 0 ? t("earnings.drawer.aboveConsensus") : diff < 0 ? t("earnings.drawer.belowConsensus") : t("earnings.drawer.atConsensus");
    return (
      <span className={cn(NUM, "text-[#1d1b1b]")} title={verdict}>
        {est ? t("earnings.cell.vs", { actual, estimate: est }) : actual}
      </span>
    );
  }
  const { text, thin } = consensusText(row, say, lang);
  const c = row.consensus;
  const title =
    thin && c
      ? c.analysts !== null
        ? t("earnings.thin.hint", { count: c.analysts, low: formatEps(c.low, lang) ?? na, high: formatEps(c.high, lang) ?? na, mean: formatEps(row.epsEstimate, lang) ?? na })
        : t("earnings.thin.hintNoCount", { low: formatEps(c.low, lang) ?? na, high: formatEps(c.high, lang) ?? na, mean: formatEps(row.epsEstimate, lang) ?? na })
      : row.epsCurrency && row.epsCurrency !== "USD"
        ? row.epsCurrency
        : undefined;
  return (
    <span title={title} className={cn(NUM, text ? (thin ? "text-[#6b7280]" : "text-[#1d1b1b]") : QUIET, thin && "text-[11px]")}>
      {text ?? na}
    </span>
  );
}

function RevenueCell({ row }: { row: EarningsRow }) {
  const { lang, t } = useSay();
  const na = useNa();
  const out = isOut(row);
  const value = out ? row.revenueActual : row.revenueEstimate;
  const usd = out ? row.revenueActualUsd : row.revenueEstimateUsd;
  const text = formatRevenueIn(value, row.revenueCurrency, lang);
  const title =
    usd !== null && row.fx
      ? t("earnings.fx.hint", { amount: formatUsd(usd, lang) ?? na, currency: row.fx.currency, rate: String(row.fx.rate.toPrecision(4)), date: shortDate(row.fx.asOf, lang) })
      : out && row.revenueEstimate !== null
        ? t("earnings.cell.consensusWas", { value: formatRevenueIn(row.revenueEstimate, row.revenueCurrency, lang) ?? na })
        : undefined;
  if (out && text === null && row.phase === "pending") return <span className={cn(NUM, QUIET)}>{t("earnings.cell.pending")}</span>;
  return (
    <span title={title} className={cn(NUM, text ? "text-[#1d1b1b]" : QUIET)}>
      {text ?? na}
    </span>
  );
}

function toneOf(v: number | null): string {
  return v === null ? QUIET : v > 0 ? "text-[#16a34a]" : v < 0 ? "text-[#dc2626]" : "text-[#4b5563]";
}

type RowProps = {
  row: EarningsRow;
  reaction: EarningsReaction | null | undefined;
  live: number | null;
  today: string;
  /** The options line's figure: absent when not asked or not read yet, null when no quotes support one. */
  implied?: ImpliedMove | null;
  /** The reported quarter's estimate revisions, passed only when they are notable. */
  estimate?: PeriodEstimates | null;
  onOpen: (row: EarningsRow) => void;
};

function Row({ row, reaction, live, today, implied, estimate, onOpen }: RowProps) {
  const { say, lang, t } = useSay();
  const na = useNa();
  const out = isOut(row);
  let fifth: ReactNode;
  if (out) {
    const day = reactionSession(row.date, row.time, row.releasedAt ? Date.parse(row.releasedAt) : null);
    const { move, live: isLive } = row.phase === "reported" ? dayMoveOf(day, today, reaction ?? null, live) : { move: null, live: false };
    fifth = (
      <span className={cn(NUM, toneOf(move))} title={isLive ? t("earnings.drawer.live") : undefined}>
        {formatMove(move, lang) ?? na}
      </span>
    );
  } else {
    const surprise = row.lastSurprise ? formatSurprise(row.lastSurprise.surprisePct, lang) : null;
    const pct = row.lastSurprise?.surprisePct ?? null;
    const title =
      row.lastSurprise && row.lastSurprise.quarterEnd
        ? t("earnings.surprise.detail", {
            date: shortDate(row.lastSurprise.quarterEnd, lang),
            actual: formatEps(row.lastSurprise.epsActual, lang) ?? na,
            estimate: formatEps(row.lastSurprise.epsEstimate, lang) ?? na,
          })
        : undefined;
    fifth = (
      <span title={title} className={cn(NUM, surprise === null ? QUIET : toneOf(pct))}>
        {surprise ?? na}
      </span>
    );
  }
  const usual = reaction === undefined ? null : formatUsualMove(reaction?.usualMove ?? null, lang);
  const name = shortCompanyName(row.company) ?? row.ticker;
  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={t("earnings.row.details", { ticker: row.ticker })}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(row);
        }
      }}
      className={cn(GRID, "app-no-drag cursor-pointer rounded-xl px-2 py-2 outline-none transition-colors hover:bg-black/[0.03] focus-visible:bg-black/[0.04]")}
    >
      <HeldMarker row={row} />
      <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <EarningsLogo ticker={row.ticker} />
        <TickerButton row={row} />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[13px] text-[#1d1b1b]" title={[row.company, row.fiscalPeriod ? t("earnings.fiscal", { period: row.fiscalPeriod }) : null].filter(Boolean).join(", ") || undefined}>
          {name}
        </span>
        <RowBadges row={row} marks={false} />
      </span>
      <TimeCell row={row} />
      <EpsCell row={row} />
      <RevenueCell row={row} />
      {fifth}
      <span className={cn(NUM, usual ? "text-[#4b5563]" : QUIET)} title={usual ? t("earnings.usual.hint") : undefined}>
        {reaction === undefined ? "" : (usual ?? na)}
      </span>
      <LinkChips links={row.readsThrough} className="justify-start" />
      {implied && !out ? (
        <span className="col-[3/-1] truncate pt-0.5 text-[11.5px] leading-[1.4] text-[#6b7280]" title={impliedHint(implied, say, lang)}>
          {impliedLine(implied, say, lang)}
        </span>
      ) : null}
      {estimate && !out ? (
        <span className="col-[3/-1] truncate pt-0.5 text-[11.5px] leading-[1.4] text-[#6b7280]" title={estimateHint(estimate, say, lang)}>
          {estimateLine(estimate, say, lang)}
        </span>
      ) : null}
    </li>
  );
}

function ColumnHeads({ section }: { section: EarningsSection["key"] }) {
  const { t } = useSay();
  const out = section === "reported";
  const head = (text: string, right = false) => (
    <span className={cn(LABEL, "truncate", right && "text-right")} title={text}>
      {text}
    </span>
  );
  return (
    <div className={cn(GRID, "px-2 pb-1 pt-1")} aria-hidden>
      <span />
      <span />
      {head(t("earnings.col.company"))}
      {head(t("earnings.col.time"))}
      {head(out ? t("earnings.col.epsReported") : t("earnings.col.eps"), true)}
      {head(out ? t("earnings.col.revenueReported") : t("earnings.col.revenue"), true)}
      {head(out ? t("earnings.col.dayMove") : t("earnings.col.surprise"), true)}
      {head(t("earnings.col.usualMove"), true)}
      {head(t("earnings.col.readsThrough"))}
    </div>
  );
}

export default function EarningsTab() {
  const { say, lang, t } = useSay();
  const held = useHeldTickers();
  const watchlist = useWatchlistTickers();
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  useEffect(() => writePrefs(prefs), [prefs]);
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState<EarningsFilters["sector"]>(null);
  const [time, setTime] = useState<EarningsTime | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<EarningsRow | null>(null);

  const sectorsFollowed = useProfileSectors();
  const state = useEarnings(prefs.scope, held, watchlist, prefs.scope === "foryou" ? sectorsFollowed : []);
  const answer = state.value;
  if (answer) knownScopes = answer.scopes;

  const today = answer?.today ?? nyToday();
  const through = prefs.range === "2w" ? addDaysYmd(today, 13) : null;
  const filters: EarningsFilters = { query, sector, time, through };
  const rows = answer?.rows ?? [];
  const inRange = useMemo(() => filterRows(rows, { query: "", sector: null, time: null, through }), [rows, through]);
  const shown = useMemo(() => filterRows(rows, filters), [rows, query, sector, time, through]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => sectionRows(shown, today, say, lang), [shown, today, say, lang]);
  const header = useMemo(() => (answer ? headerLine(inRange, today, say, lang) : null), [answer, inRange, today, say, lang]);
  const sectors = sectorsIn(inRange, CALENDAR_SECTORS);
  const times = EARNINGS_TIMES.filter((x) => inRange.some((r) => r.time === x));

  // Reaction figures for the reader's and covered names, and every name in a
  // short list; the rest of the market view gets them when its drawer opens.
  const reactionTickers = useMemo(
    () => shown.filter((r) => prefs.scope !== "all" || r.held || r.watchlist || r.tracked || shown.length <= 60).map((r) => r.ticker),
    [shown, prefs.scope],
  );
  const reactions = useEarningsReactions(reactionTickers);
  // The options line: upcoming reports in the next two weeks among the names the reaction figures are read for.
  const impliedItems = useMemo<ImpliedRequestItem[]>(() => {
    const asked = new Set(reactionTickers);
    const until = addDaysYmd(today, IMPLIED_WITHIN_DAYS);
    return shown
      .filter((r) => !isOut(r) && r.date >= today && r.date <= until && asked.has(r.ticker))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, IMPLIED_REQUEST_CAP)
      .map((r) => ({ ticker: r.ticker, date: r.date, time: r.time }));
  }, [shown, reactionTickers, today]);
  const implied = useImpliedMoves(impliedItems);
  // The estimates line: the same upcoming reports, shown only where the last 30 days moved the consensus notably.
  const estimateTickers = useMemo(() => {
    const asked = new Set(reactionTickers);
    const until = addDaysYmd(today, ESTIMATES_WITHIN_DAYS);
    return shown
      .filter((r) => !isOut(r) && r.date >= today && r.date <= until && asked.has(r.ticker))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, ESTIMATES_REQUEST_CAP)
      .map((r) => r.ticker);
  }, [shown, reactionTickers, today]);
  const estimates = useEstimateRevisions(estimateTickers);
  const notableEstimate = (row: EarningsRow): PeriodEstimates | null => {
    const p = reportPeriod(estimates[row.ticker] ?? null, row.date);
    return p && isNotable(p) && estimateLine(p, say, lang) !== null ? p : null;
  };
  const liveKey = useMemo(
    () =>
      [...new Set(shown.filter((r) => r.phase === "reported" && r.date >= addDaysYmd(today, -4)).map((r) => r.ticker))]
        .slice(0, LIVE_CAP)
        .sort()
        .join(","),
    [shown, today],
  );
  const quotes = useLiveQuotes(liveKey);
  const liveOf = (ticker: string): number | null => {
    const q = quotes[ticker];
    return q && q.changePercent !== null ? q.changePercent / 100 : null;
  };

  const setScope = (scope: EarningsScope) => {
    setPrefs((p) => ({ ...p, scope }));
    setExpanded({});
  };
  const clearFilters = () => {
    setQuery("");
    setSector(null);
    setTime(null);
  };

  const scopes = answer?.scopes ?? knownScopes;
  const scopeOptions: Array<{ id: EarningsScope; text: string }> = [
    { id: "foryou", text: t("earnings.scope.forYou") },
    { id: "mine", text: t("earnings.scope.mine") },
    ...(scopes?.tracked !== false ? [{ id: "tracked" as const, text: t("earnings.scope.tracked") }] : []),
    ...(scopes?.all || prefs.scope === "all" ? [{ id: "all" as const, text: t("earnings.scope.all") }] : []),
  ];

  const noNames = prefs.scope === "mine" && held.length === 0 && watchlist.length === 0;
  const dayCap = prefs.scope === "foryou" ? DAY_CAP_FORYOU : DAY_CAP;
  const failure = !answer && state.error !== null ? state.error : null;

  const renderRows = (list: EarningsRow[]) => (
    <ul className="pb-2">
      {list.map((row) => (
        <Row key={row.ticker} row={row} reaction={reactions[row.ticker]} live={liveOf(row.ticker)} today={today} implied={implied[row.ticker]} estimate={notableEstimate(row)} onOpen={setOpen} />
      ))}
    </ul>
  );

  let body: ReactNode;
  if (noNames) {
    body = (
      <Centered>
        <p className="text-[14px] font-medium text-[#1d1b1b]">{t("earnings.empty.noNames")}</p>
        <p className="mt-1.5 max-w-[420px] text-[13px] leading-[1.55] text-[#6b7280]">{t("earnings.empty.noNamesHint")}</p>
        {scopes?.tracked !== false ? (
          <button type="button" onClick={() => setScope("tracked")} className={cn(BUTTON, "mt-4")}>
            {t("earnings.empty.showTracked")}
          </button>
        ) : null}
      </Centered>
    );
  } else if (failure !== null) {
    const message =
      failure === "restart"
        ? t("earnings.error.restart")
        : failure === "scope_unavailable"
          ? prefs.scope === "all"
            ? t("earnings.error.allUnavailable")
            : t("earnings.error.trackedUnavailable")
          : t("earnings.error.load");
    body = (
      <Centered>
        <p className="text-[14px] font-medium text-[#1d1b1b]">{message}</p>
        {failure === "restart" ? null : failure === "scope_unavailable" ? (
          <button type="button" onClick={() => setScope("mine")} className={cn(BUTTON, "mt-4")}>
            {t("earnings.scope.mine")}
          </button>
        ) : (
          <button type="button" onClick={state.retry} className={cn(BUTTON, "mt-4")}>
            {t("earnings.error.retry")}
          </button>
        )}
      </Centered>
    );
  } else if (!answer) {
    body = <Skeleton />;
  } else if (inRange.length === 0) {
    body = (
      <Centered>
        <p className="text-[13.5px] text-[#6b7280]">{prefs.scope === "foryou" ? t("earnings.empty.forYou") : t("earnings.empty.none")}</p>
      </Centered>
    );
  } else if (shown.length === 0) {
    body = (
      <Centered>
        <p className="text-[13.5px] text-[#6b7280]">{t("earnings.empty.filtered")}</p>
        <button type="button" onClick={clearFilters} className={cn(BUTTON, "mt-4")}>
          {t("earnings.empty.clearFilters")}
        </button>
      </Centered>
    );
  } else {
    body = (
      <div className="px-3 pb-4">
        {sections.map((s) => (
          <section key={s.key} className="border-t-[0.5px] border-black/[0.06] pt-3 first-of-type:border-t-0" aria-label={s.title}>
            <h3 className="flex items-baseline gap-2 px-2 pb-1">
              <span className="text-[13px] font-medium text-[#1d1b1b]">{s.title}</span>
              <span className="ml-auto text-[11.5px] tabular-nums text-[#9CA3AF]">{countText(s.rows.length, say, lang)}</span>
            </h3>
            <ColumnHeads section={s.key} />
            {s.key !== "upcoming"
              ? renderRows(expanded[s.key] ? s.rows : s.rows.slice(0, dayCap))
              : s.days.map((g) => {
                  const list = expanded[g.date] ? g.rows : g.rows.slice(0, dayCap);
                  const more = g.rows.length - list.length;
                  return (
                    <div key={g.date} className="pt-1">
                      <p className="flex items-baseline gap-2 px-2 pb-0.5 pt-1">
                        <span className="text-[12px] text-[#4b5563]">{g.title}</span>
                        {g.subtitle ? <span className="text-[11.5px] text-[#9CA3AF]">{g.subtitle}</span> : null}
                      </p>
                      {renderRows(list)}
                      {more > 0 ? (
                        <button type="button" onClick={() => setExpanded((e) => ({ ...e, [g.date]: true }))} className={cn(BUTTON, "mb-3 ml-2")}>
                          {t("earnings.showMore", { count: more })}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
            {s.key !== "upcoming" && !expanded[s.key] && s.rows.length > dayCap ? (
              <button type="button" onClick={() => setExpanded((e) => ({ ...e, [s.key]: true }))} className={cn(BUTTON, "mb-3 ml-2")}>
                {t("earnings.showMore", { count: s.rows.length - dayCap })}
              </button>
            ) : null}
          </section>
        ))}
      </div>
    );
  }

  const notes: string[] = [];
  if (answer && !noNames) {
    if (answer.marketCalendar === "stale") notes.push(t("earnings.note.stale"));
    if (answer.marketCalendar === "missing") notes.push(t("earnings.note.noMarket"));
    if (shown.some((r) => r.status === "unknown")) notes.push(t("earnings.note.unmarked"));
    if (answer.unavailable.length > 0) notes.push(t("earnings.note.unavailable", { names: answer.unavailable.join(", ") }));
    // Only when something the reader would notice is missing, not for one failed sector lookup.
    if (degradedNoticeable(answer)) notes.push(t("earnings.note.degraded"));
  }
  // Main runs older code than this view (earnings-load.ts): the reader's own names stand in for "For you".
  if (answer?.outdatedMain) notes.unshift(t("earnings.note.restart"));

  return (
    <div className="app-no-drag px-8 pb-10 pt-5">
      <ReadthroughSection />
      <div className={cn(SURFACE, "overflow-visible")}>
        <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          <Segmented value={prefs.scope} label={t("earnings.scope.label")} onChange={setScope} options={scopeOptions} />
          <Segmented
            value={prefs.range}
            label={t("earnings.range.label")}
            onChange={(range) => setPrefs((p) => ({ ...p, range }))}
            options={[
              { id: "2w", text: t("earnings.range.twoWeeks") },
              { id: "4w", text: t("earnings.range.fourWeeks") },
            ]}
          />
          <label className="relative ml-1">
            <span className="sr-only">{t("earnings.search.label")}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9CA3AF]" strokeWidth={2} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={t("earnings.search.placeholder")}
              className={cn(FIELD, "h-8 w-[200px] pl-8")}
            />
          </label>
          <FilterMenu
            label={t("earnings.filter.sector")}
            value={sector}
            allText={t("earnings.filter.allSectors")}
            options={sectors.map((s) => ({ id: s, text: sectorLabel(t, s) }))}
            onChange={setSector}
          />
          <FilterMenu
            label={t("earnings.filter.time")}
            value={time}
            allText={t("earnings.filter.anyTime")}
            options={times.map((x) => ({ id: x, text: timeLabel(t, x) }))}
            onChange={setTime}
          />
          {filtersActive(filters) ? (
            <button type="button" onClick={clearFilters} className="app-no-drag px-1 text-[12px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]">
              {t("earnings.empty.clearFilters")}
            </button>
          ) : null}
          {answer && !noNames ? (
            <span className="ml-auto text-[12px] tabular-nums text-[#9CA3AF]" aria-live="polite">
              {countText(shown.length, say, lang)}
            </span>
          ) : null}
        </div>

        {header && !noNames ? <p className="border-b-[0.5px] border-black/[0.06] px-5 py-2.5 text-[12.5px] leading-[1.5] text-[#4b5563]">{header}</p> : null}

        {body}

        {notes.length > 0 ? (
          <div className="space-y-1 border-t-[0.5px] border-black/[0.06] px-5 py-3">
            {notes.map((note) => (
              <p key={note} className="text-[11.5px] leading-[1.45] text-[#9CA3AF]">
                {note}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <EarningsDrawer row={open} today={today} live={open ? liveOf(open.ticker) : null} onClose={() => setOpen(null)} />
    </div>
  );
}
