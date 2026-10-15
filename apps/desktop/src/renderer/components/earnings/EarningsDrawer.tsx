import { useEffect, useMemo, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useNa } from "@/lib/i18n/na";
import { useEarningsDetail } from "@/lib/earnings-store";
import { useLiveQuotes } from "@/hooks/useLivePrices";
import { openCreateAgent } from "@/components/agents/agents-store";
import { earningsWatchDraft } from "@/components/agents/agent-prefill";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { EarningsReaction, EarningsRow } from "../../../shared/earnings-types";
import { reactionSession } from "../../../shared/earnings-time";
import { IMPLIED_WITHIN_DAYS, formatImpliedPct, impliedHint, type ImpliedMove, type ImpliedRequestItem } from "../../../shared/implied-move";
import { useImpliedMoves } from "@/lib/implied-move-store";
import {
  addDaysYmd,
  agentBrief,
  consensusText,
  dayDate,
  dayMoveOf,
  fiscalText,
  formatEps,
  formatMove,
  formatRevenueIn,
  formatUsd,
  formatUsualMove,
  isOut,
  pastDayText,
  releaseTimeText,
  shortDate,
} from "../../../shared/earnings-view";
import EarningsLogo from "./EarningsLogo";
import GuidanceLines from "./GuidanceLines";
import { BUTTON, RowBadges, SKELETON, TickerButton, linkSentence, useSay } from "./earnings-ui";

/**
 * The Earnings row's drawer: the figures behind the row, one report at a time.
 *
 *   This report      (once out) the actual against the consensus as it stood
 *                    before, and the session's move against the usual one
 *   Consensus        (before) EPS and revenue, how many estimates, their range
 *   Last four        EPS actual against consensus, and reported revenue
 *   quarters         (the providers keep no revenue consensus for the past)
 *   Guidance record  (three quarters or more on record) how reported figures
 *                    landed against the company's own guidance (GuidanceLines)
 *   Moves on report  the last report-day moves, the usual and the normal
 *   days             daily move
 *   Reads through    the reader's names a filing links to this company, the
 *   to               filing, and (once out) how they are moving
 *
 * Every figure is a provider's or computed from one; nothing is inferred.
 */

const SECTION = "mt-5 first:mt-0";
const HEAD = "text-[10.5px] font-medium uppercase tracking-[0.04em] text-[#9CA3AF]";
const NUM = "font-['Geist_Mono'] tabular-nums";

function tone(v: number | null): string {
  return v === null ? "text-[#9CA3AF]" : v > 0 ? "text-[#16a34a]" : v < 0 ? "text-[#dc2626]" : "text-[#4b5563]";
}

function Line({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={hint}>
      <span className="text-[12px] text-[#6b7280]">{label}</span>
      <span className={cn(NUM, "text-right text-[12px] text-[#1d1b1b]")}>{children}</span>
    </div>
  );
}

/** What the options price for the report, and the stock's own record against it. */
function ImpliedBlock({ v }: { v: ImpliedMove }) {
  const { say, lang, t } = useSay();
  const h = v.history;
  return (
    <section className={SECTION}>
      <p className={HEAD}>{t("implied.drawer.title")}</p>
      <div className="mt-1.5">
        <Line label={t("implied.drawer.move")} hint={impliedHint(v, say, lang)}>
          {formatImpliedPct(v.move, lang)}
        </Line>
        {h.above !== null && h.median !== null ? (
          <>
            <Line label={t("implied.drawer.above")}>{t("implied.drawer.aboveValue", { count: h.above, n: h.n })}</Line>
            <Line label={t("implied.drawer.median")}>{formatImpliedPct(h.median, lang)}</Line>
          </>
        ) : (
          <Line label={t("implied.drawer.sample")}>{h.n}</Line>
        )}
      </div>
    </section>
  );
}

type Props = {
  row: EarningsRow | null;
  today: string;
  /** The live quote's move for the row's ticker, as a fraction. */
  live: number | null;
  onClose: () => void;
};

export default function EarningsDrawer({ row, today, live, onClose }: Props) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [row, onClose]);

  return (
    <AnimatePresence>
      {row ? (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-40 bg-black/[0.08]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-modal="true"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="app-no-drag fixed bottom-3 right-3 top-12 z-50 flex w-[380px] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]"
          >
            <DrawerBody row={row} today={today} live={live} onClose={onClose} />
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function DrawerBody({ row, today, live, onClose }: { row: EarningsRow; today: string; live: number | null; onClose: () => void }) {
  const { say, lang, t } = useSay();
  const { language } = useI18n();
  const na = useNa();
  const state = useEarningsDetail(row.ticker);
  const detail = state.status === "ready" ? state.detail : null;
  const reaction: EarningsReaction | null = detail?.reaction ?? null;
  const out = isOut(row);
  const linkKey = out ? row.readsThrough.map((l) => l.ticker).sort().join(",") : "";
  const linkQuotes = useLiveQuotes(linkKey);
  const impliedAsk = useMemo<ImpliedRequestItem[]>(
    () => (!out && row.date >= today && row.date <= addDaysYmd(today, IMPLIED_WITHIN_DAYS) ? [{ ticker: row.ticker, date: row.date, time: row.time }] : []),
    [out, row.ticker, row.date, row.time, today],
  );
  const implied = useImpliedMoves(impliedAsk)[row.ticker] ?? null;

  const exact = releaseTimeText(row.releasedAt, say);
  const when = out
    ? t("earnings.drawer.reported", { when: pastDayText(row.date, today, say, lang) }) + (exact ? `, ${exact}` : "")
    : t("earnings.drawer.reportsOn", { date: dayDate(row.date, lang) }) + (row.time !== "unknown" ? `, ${say(`earnings.timePhrase.${row.time}`)}` : "");

  const reactionDay = reactionSession(row.date, row.time, row.releasedAt ? Date.parse(row.releasedAt) : null);
  const dayMove = row.phase === "reported" ? dayMoveOf(reactionDay, today, reaction, live) : { move: null, live: false };
  const usual = reaction?.usualMove ?? null;
  const consensus = consensusText(row, say, lang);
  const c = row.consensus;

  const revenueLine = (value: number | null, usd: number | null) => {
    const native = formatRevenueIn(value, row.revenueCurrency, lang);
    if (native === null) return na;
    const dollars = usd !== null ? formatUsd(usd, lang) : null;
    return dollars ? `${native} (${dollars})` : native;
  };
  const fxHint = row.fx ? t("earnings.fx.rate", { currency: row.fx.currency, rate: String(row.fx.rate.toPrecision(4)), date: shortDate(row.fx.asOf, lang) }) : undefined;

  return (
    <>
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <EarningsLogo ticker={row.ticker} />
            <TickerButton row={row} />
            <RowBadges row={row} />
          </div>
          <p className="mt-1.5 truncate text-[14px] text-[#1d1b1b]" title={row.company ?? undefined}>
            {row.company ?? row.ticker}
          </p>
          <p className="mt-0.5 text-[12px] text-[#6b7280]">
            {when}
            {row.fiscalPeriod ? ` · ${fiscalText(row.fiscalPeriod, say)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("earnings.drawer.close")}
          className="app-no-drag -mr-1 rounded-md p-1 text-[#9CA3AF] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
        >
          <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
        {out ? (
          <section className={SECTION}>
            <p className={HEAD}>{t("earnings.drawer.thisReport")}</p>
            <div className="mt-1.5">
              {row.phase === "pending" ? <p className="py-1 text-[12px] text-[#6b7280]">{t("earnings.cell.pending")}</p> : null}
              <Line label={t("earnings.drawer.eps")}>
                {row.epsActual !== null
                  ? formatEps(row.epsEstimate, lang)
                    ? t("earnings.cell.vs", { actual: formatEps(row.epsActual, lang)!, estimate: formatEps(row.epsEstimate, lang)! })
                    : formatEps(row.epsActual, lang)
                  : na}
              </Line>
              <Line label={t("earnings.drawer.revenue")} hint={fxHint}>
                {revenueLine(row.revenueActual, row.revenueActualUsd)}
              </Line>
              <Line label={t("earnings.drawer.revenueConsensus")} hint={fxHint}>
                {revenueLine(row.revenueEstimate, row.revenueEstimateUsd)}
              </Line>
              <Line label={t("earnings.drawer.dayMove")} hint={dayMove.live ? t("earnings.drawer.live") : undefined}>
                <span className={tone(dayMove.move)}>{formatMove(dayMove.move, lang) ?? na}</span>
                {usual !== null && dayMove.move !== null ? (
                  <span className="text-[#6b7280]"> {t("earnings.drawer.againstUsual", { usual: formatUsualMove(usual, lang)! })}</span>
                ) : null}
              </Line>
            </div>
          </section>
        ) : (
          <section className={SECTION}>
            <p className={HEAD}>{t("earnings.drawer.consensus")}</p>
            <div className="mt-1.5">
              <Line label={t("earnings.drawer.eps")} hint={row.epsCurrency && row.epsCurrency !== "USD" ? row.epsCurrency : undefined}>
                {consensus.text ?? na}
              </Line>
              {c && (c.analysts !== null || (c.low !== null && c.high !== null)) ? (
                <Line label={t("earnings.drawer.estimates")}>
                  {t("earnings.drawer.estimatesLine", {
                    count: c.analysts ?? na,
                    low: formatEps(c.low, lang) ?? na,
                    high: formatEps(c.high, lang) ?? na,
                  })}
                </Line>
              ) : null}
              {consensus.thin ? <Line label={t("earnings.drawer.mean")}>{formatEps(row.epsEstimate, lang) ?? na}</Line> : null}
              <Line label={t("earnings.drawer.revenue")} hint={fxHint}>
                {revenueLine(row.revenueEstimate, row.revenueEstimateUsd)}
              </Line>
            </div>
          </section>
        )}

        {implied ? <ImpliedBlock v={implied} /> : null}

        <section className={SECTION}>
          <p className={HEAD}>{t("earnings.drawer.quarters")}</p>
          {state.status === "loading" ? (
            <div className="mt-2 space-y-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className={cn(SKELETON, "h-3 w-full")} />
              ))}
            </div>
          ) : state.status === "failed" ? (
            <p className="mt-1.5 text-[12px] text-[#9CA3AF]">{t("earnings.drawer.failed")}</p>
          ) : detail && detail.quarters.length > 0 ? (
            <>
              <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_64px_72px_84px] gap-x-2 text-[11px] text-[#9CA3AF]">
                <span>{t("earnings.drawer.quarter")}</span>
                <span className="text-right">{t("earnings.drawer.actual")}</span>
                <span className="text-right">{t("earnings.drawer.estimate")}</span>
                <span className="text-right">{t("earnings.drawer.revenue")}</span>
              </div>
              {[...detail.quarters].reverse().map((q) => {
                const diff = q.epsActual !== null && q.epsEstimate !== null ? q.epsActual - q.epsEstimate : null;
                return (
                  <div key={q.periodEnd ?? q.fiscalQuarter ?? ""} className="grid grid-cols-[minmax(0,1fr)_64px_72px_84px] gap-x-2 py-[3px] text-[12px]">
                    <span className="truncate text-[#4b5563]">{q.fiscalQuarter ? fiscalText(q.fiscalQuarter, say) : q.periodEnd ? shortDate(q.periodEnd, lang) : na}</span>
                    <span className={cn(NUM, "text-right", tone(diff))}>{formatEps(q.epsActual, lang) ?? na}</span>
                    <span className={cn(NUM, "text-right text-[#4b5563]")}>{formatEps(q.epsEstimate, lang) ?? na}</span>
                    <span className={cn(NUM, "text-right text-[#1d1b1b]")}>{formatRevenueIn(q.revenueActual, detail.revenueCurrency, lang) ?? na}</span>
                  </div>
                );
              })}
              <p className="mt-1.5 text-[11px] leading-[1.45] text-[#9CA3AF]">{t("earnings.drawer.revenueNote")}</p>
            </>
          ) : (
            <p className="mt-1.5 text-[12px] text-[#9CA3AF]">{na}</p>
          )}
        </section>

        <GuidanceLines ticker={row.ticker} className={SECTION} />

        <section className={SECTION}>
          <p className={HEAD}>{t("earnings.drawer.reactions")}</p>
          {state.status === "loading" ? (
            <div className={cn(SKELETON, "mt-2 h-3 w-2/3")} aria-hidden />
          ) : (
            <div className="mt-1.5">
              {(reaction?.moves ?? [])
                .filter((m) => m.reactionDay < today)
                .slice(-4)
                .reverse()
                .map((m) => (
                  <Line key={m.date} label={dayDate(m.date, lang)} hint={m.releasedAt ? (releaseTimeText(m.releasedAt, say) ?? undefined) : undefined}>
                    <span className={tone(m.move)}>{formatMove(m.move, lang)}</span>
                  </Line>
                ))}
              <div className="mt-1 border-t-[0.5px] border-black/[0.06] pt-1">
                <Line label={t("earnings.drawer.usual")} hint={t("earnings.usual.hint")}>
                  {formatUsualMove(usual, lang) ?? na}
                </Line>
                <Line label={t("earnings.drawer.normal")} hint={t("earnings.normal.hint")}>
                  {formatUsualMove(reaction?.normalDailyMove ?? null, lang) ?? na}
                </Line>
              </div>
            </div>
          )}
        </section>

        <section className={SECTION}>
          <p className={HEAD}>{t("earnings.drawer.links")}</p>
          {row.readsThrough.length === 0 ? (
            <p className="mt-1.5 text-[12px] leading-[1.5] text-[#9CA3AF]">{t("earnings.drawer.noLinks")}</p>
          ) : (
            <ul className="mt-1.5 space-y-2.5">
              {row.readsThrough.map((l) => {
                const q = linkQuotes[l.ticker];
                const move = out && q && q.changePercent !== null ? q.changePercent / 100 : null;
                return (
                  <li key={l.ticker} className="text-[12px] leading-[1.45]">
                    <div className="flex items-center gap-2">
                      <TickerButton row={{ ticker: l.ticker, company: null }} />
                      <span className="text-[11px] text-[#6b7280]">{l.held ? t("earnings.badge.held") : t("earnings.badge.watchlist")}</span>
                      {out ? <span className={cn(NUM, "ml-auto text-[12px]", tone(move))}>{formatMove(move, lang) ?? ""}</span> : null}
                    </div>
                    <p className="mt-1 text-[#1d1b1b]">{linkSentence(t, l)}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[11px] text-[#9CA3AF]">
                      {l.filingDate ? <span>{t("earnings.link.filed", { date: shortDate(l.filingDate, lang) })}</span> : null}
                      {l.sourceUrl && /^https?:\/\//i.test(l.sourceUrl) ? (
                        <button
                          type="button"
                          onClick={() => void window.meridian?.openExternal(l.sourceUrl!)}
                          className="app-no-drag inline-flex items-center gap-1 text-[#4b5563] underline decoration-[#cfcfc8] underline-offset-[3px] transition-colors hover:text-[#1d1b1b] hover:decoration-[#1d1b1b]"
                        >
                          {t("earnings.drawer.openFiling")}
                        </button>
                      ) : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="flex items-center justify-between gap-3 border-t-[0.5px] border-black/[0.06] px-5 py-3">
        <span className="text-[11px] text-[#9CA3AF]">{row.source === "finnhub" ? t("earnings.drawer.source.finnhub") : t("earnings.drawer.source.yahoo")}</span>
        <button type="button" onClick={() => openCreateAgent(earningsWatchDraft({ ticker: row.ticker, date: row.date, today, brief: agentBrief(row, say, lang) }, language))} className={BUTTON}>
          {t("earnings.row.createAgent")}
        </button>
      </div>
    </>
  );
}
