import { useCallback, useMemo, type ReactNode } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useNa } from "@/lib/i18n/na";
import { cn } from "@/lib/utils";
import type { NextReport, ReportRow, StockEarnings } from "../../../../shared/stock-tab-data";
import {
  addDaysYmd,
  consensusText,
  dayDate,
  daysUntil,
  fiscalText,
  formatEps,
  formatMove,
  formatRevenueIn,
  formatSurprise,
  formatUsd,
  shortDate,
  whenText,
  type Say,
} from "../../../../shared/earnings-view";
import { useStockEarnings } from "../use-stock-tab-data";
import { useImpliedMoves } from "@/lib/implied-move-store";
import { IMPLIED_WITHIN_DAYS, impliedHint, impliedLine, type ImpliedRequestItem } from "../../../../shared/implied-move";
import type { StockSectionProps } from "./types";
import { categoryKey, fullDate } from "./stock-data-format";

/**
 * Stock tab: the stock's reports (main/stock-tab-data).
 *
 *   Next report     the date and how far off it is, the hour when known, and
 *                   the consensus EPS and revenue (revenue in the reporting
 *                   currency, with dollars beside it at a dated rate)
 *   Last N reports  EPS against the consensus, revenue, and the move of the
 *                   session that first traded each report. Yahoo keeps four
 *                   quarters; older rows come from the 8-K filings and carry
 *                   the date and the move only
 *   Options line    for a report two weeks out or less: the move the listed
 *                   options price for it, and how many of the stock's last
 *                   reports moved more (main/options, shared/implied-move.ts)
 *   Reported first  companies a filing links to this one that reported this
 *                   season, before its own report: their EPS against the
 *                   consensus and their move, as plain lines
 *
 * No whisper numbers: no source for them is wired into the app, so there is
 * no column for them.
 */

type T = ReturnType<typeof useI18n>["t"];

const NUM = "font-['Geist_Mono'] tabular-nums";

function tone(v: number | null): string {
  return v === null ? "text-content-tertiary" : v > 0 ? "text-tone-positive" : v < 0 ? "text-tone-negative" : "text-content-secondary";
}

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-[11.5px] text-content-tertiary">{label}</p>
      <p className={cn(NUM, "mt-0.5 text-[14px] text-content-primary")}>{children}</p>
    </div>
  );
}

function NextBlock({ next, today, t, say, lang, na }: { next: NextReport; today: string; t: T; say: Say; lang: string; na: string }) {
  const when = whenText(daysUntil(today, next.date), say, lang);
  const date = next.windowEnd ? t("stocktab.earnings.window", { from: shortDate(next.date, lang), to: shortDate(next.windowEnd, lang) }) : dayDate(next.date, lang);
  const hour = next.time !== "unknown" ? say(`earnings.timePhrase.${next.time}`) : null;
  const consensus = consensusText(next, say, lang);
  const revenue = formatRevenueIn(next.revenueEstimate, next.revenueCurrency, lang);
  const usd = next.revenueEstimateUsd !== null ? formatUsd(next.revenueEstimateUsd, lang) : null;
  const fxTitle = next.fx ? say("earnings.fx.rate", { currency: next.fx.currency, rate: String(next.fx.rate.toPrecision(4)), date: shortDate(next.fx.asOf, lang) }) : undefined;
  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-6">
      <Fact label={t("stocktab.earnings.next")}>
        <span className="font-sans">
          {date}, {when}
          {hour ? `, ${hour}` : ""}
        </span>
        {next.status === "estimated" ? (
          <span title={say("earnings.badge.estimatedHint")} className="ml-2 rounded-full bg-fill-selected px-1.5 py-px align-middle font-sans text-[10.5px] text-content-secondary">
            {say("earnings.badge.estimated")}
          </span>
        ) : null}
      </Fact>
      <Fact label={t("stocktab.earnings.consensusEps")} title={next.epsCurrency && next.epsCurrency !== "USD" ? next.epsCurrency : undefined}>
        {consensus.text ?? na}
        {next.consensus?.analysts ? <span className="ml-1.5 font-sans text-[11.5px] text-content-tertiary">{t("stocktab.earnings.analysts", { count: next.consensus.analysts })}</span> : null}
      </Fact>
      <Fact label={t("stocktab.earnings.consensusRevenue")} title={fxTitle}>
        {revenue ?? na}
        {revenue && usd ? <span className="ml-1.5 text-[11.5px] text-content-tertiary">({usd})</span> : null}
      </Fact>
    </div>
  );
}

function ReportsTable({ rows, currency, t, say, lang, na }: { rows: ReportRow[]; currency: string | null; t: T; say: Say; lang: string; na: string }) {
  const hasRevenue = rows.some((r) => r.revenueActual !== null);
  const head = "pb-2 text-left text-[11px] font-normal text-content-tertiary";
  const cell = cn(NUM, "py-2 text-[12.5px] text-content-primary");
  return (
    <div className="mt-7">
      <p className="mb-2 text-[12px] font-medium text-content-secondary">
        {rows.length === 1 ? t("stocktab.earnings.last.one") : t("stocktab.earnings.last.other", { count: rows.length })}
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-edge-subtle">
            <th scope="col" className={head}>{t("stocktab.earnings.col.date")}</th>
            <th scope="col" className={head}>{t("stocktab.earnings.col.quarter")}</th>
            <th scope="col" className={cn(head, "text-right")}>{t("stocktab.earnings.col.eps")}</th>
            <th scope="col" className={cn(head, "text-right")}>{t("stocktab.earnings.col.estimate")}</th>
            <th scope="col" className={cn(head, "text-right")}>{t("stocktab.earnings.col.surprise")}</th>
            {hasRevenue ? <th scope="col" className={cn(head, "text-right")}>{t("stocktab.earnings.col.revenue")}</th> : null}
            <th scope="col" className={cn(head, "text-right")} title={t("stocktab.earnings.moveTitle")}>
              {t("stocktab.earnings.col.move")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {rows.map((r) => {
            const filingOnly = r.source.kind === "filing";
            const blank = filingOnly ? "" : na;
            return (
              <tr key={r.date} title={filingOnly ? t("stocktab.earnings.filingRow") : undefined}>
                <td className={cn(cell, "text-content-secondary")}>
                  {r.source.url ? (
                    <button
                      type="button"
                      onClick={() => void window.meridian?.openExternal?.(r.source.url!)}
                      className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
                    >
                      {fullDate(r.date, lang)}
                    </button>
                  ) : (
                    fullDate(r.date, lang)
                  )}
                </td>
                <td className={cn(cell, "text-content-secondary")}>{r.fiscalPeriod ? fiscalText(r.fiscalPeriod, say) : ""}</td>
                <td className={cn(cell, "text-right")}>{formatEps(r.epsActual, lang) ?? blank}</td>
                <td className={cn(cell, "text-right text-content-secondary")}>{formatEps(r.epsEstimate, lang) ?? blank}</td>
                <td className={cn(cell, "text-right", tone(r.surprisePct))}>{formatSurprise(r.surprisePct, lang) ?? blank}</td>
                {hasRevenue ? <td className={cn(cell, "text-right text-content-secondary")}>{formatRevenueIn(r.revenueActual, currency, lang) ?? blank}</td> : null}
                <td className={cn(cell, "text-right", tone(r.move))}>{formatMove(r.move, lang) ?? na}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Leads({ earnings, t, lang }: { earnings: StockEarnings; t: T; lang: string }) {
  if (earnings.leads.length === 0) return null;
  return (
    <div className="mt-7">
      <p className="text-[12px] font-medium text-content-secondary">{t("stocktab.earnings.leads")}</p>
      {earnings.leadSince ? (
        <p className="mt-0.5 text-[11.5px] text-content-tertiary">
          {t("stocktab.earnings.leadsNote", { ticker: earnings.ticker, date: fullDate(earnings.leadSince, lang) })}
        </p>
      ) : null}
      <ul className="mt-2 space-y-1.5">
        {earnings.leads.map((l) => {
          const k = categoryKey(l.category);
          const category = k ? t(`stocktab.changes.category.${k}` as MessageKey) : l.category;
          const actual = formatEps(l.epsActual, lang);
          const estimate = formatEps(l.epsEstimate, lang);
          const surprise = formatSurprise(l.surprisePct, lang);
          const move = formatMove(l.move, lang);
          return (
            <li key={l.ticker} className="text-[12.5px] leading-5 text-content-primary">
              <span>{t("stocktab.earnings.lead", { ticker: l.ticker, category, date: shortDate(l.date, lang) })}</span>
              {actual && estimate ? (
                <span className="text-content-secondary">
                  {": "}
                  <span className={NUM}>{t("stocktab.earnings.leadEps", { actual, estimate })}</span>
                  {surprise ? <span className={cn(NUM, tone(l.surprisePct))}> ({surprise})</span> : null}
                </span>
              ) : null}
              {move ? (
                <span className="text-content-secondary">
                  {", "}
                  <span className={cn(NUM, tone(l.move))}>{t("stocktab.earnings.leadMove", { move })}</span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function EarningsSection({ ticker }: StockSectionProps) {
  const { t, language } = useI18n();
  const na = useNa();
  const say = useCallback<Say>((key, params) => t(key as MessageKey, params), [t]);
  const earnings = useStockEarnings(ticker);
  const next = earnings?.next ?? null;
  const today = earnings?.today ?? null;
  const impliedAsk = useMemo<ImpliedRequestItem[]>(
    () => (next && today && next.date >= today && next.date <= addDaysYmd(today, IMPLIED_WITHIN_DAYS) ? [{ ticker, date: next.date, time: next.time }] : []),
    [ticker, next, today],
  );
  const implied = useImpliedMoves(impliedAsk)[ticker] ?? null;
  if (!earnings || (!earnings.next && earnings.reports.length === 0 && earnings.leads.length === 0)) return null;
  return (
    <div>
      {earnings.next ? <NextBlock next={earnings.next} today={earnings.today} t={t} say={say} lang={language} na={na} /> : null}
      {earnings.next && implied ? (
        <p className="mt-4 text-[12.5px] leading-5 text-content-secondary" title={impliedHint(implied, say, language)}>
          {impliedLine(implied, say, language)}
        </p>
      ) : null}
      {earnings.reports.length > 0 ? <ReportsTable rows={earnings.reports} currency={earnings.revenueCurrency} t={t} say={say} lang={language} na={na} /> : null}
      <Leads earnings={earnings} t={t} lang={language} />
    </div>
  );
}
