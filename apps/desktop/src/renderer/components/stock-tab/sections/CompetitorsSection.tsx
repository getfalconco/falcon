import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useNa } from "@/lib/i18n/na";
import { cn } from "@/lib/utils";
import { formatMove } from "../../../../shared/earnings-view";
import { useStockPeers } from "../use-stock-tab-data";
import type { StockSectionProps } from "./types";
import { correlation, fullDate } from "./stock-data-format";

/**
 * Stock tab: competitor dynamics (main/stock-tab-data, shared/peer-dynamics.ts).
 *
 *   Competitors   the companies the filings name as competitors (either
 *                 company's 10-K or 20-F), or, when the filings name none,
 *                 the largest companies in the same sector, labelled so; with
 *                 the correlation of daily returns over a year and three months
 *   Large moves   the stock's latest sessions of two standard deviations or
 *                 more in the last six months, each competitor's move that
 *                 session, and whether the move was shared (a sector shock)
 *                 or not (a share shift)
 */

const NUM = "font-['Geist_Mono'] tabular-nums";

function tone(v: number | null): string {
  return v === null ? "text-content-tertiary" : v > 0 ? "text-tone-positive" : v < 0 ? "text-tone-negative" : "text-content-secondary";
}

export default function CompetitorsSection({ ticker }: StockSectionProps) {
  const { t, language } = useI18n();
  const na = useNa();
  const data = useStockPeers(ticker);
  if (!data || data.peers.length === 0) return null;
  const sector = data.peers.every((p) => p.basis === "sector");
  const head = "pb-2 text-left text-[11px] font-normal text-content-tertiary";
  const cell = cn(NUM, "py-2 text-[12.5px] text-content-primary");

  return (
    <div>
      {sector ? <p className="mb-3 text-[12px] text-content-tertiary">{t("stocktab.peers.sectorNote")}</p> : null}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-edge-subtle">
            <th scope="col" className={head}>{t("stocktab.peers.col.company")}</th>
            <th scope="col" className={cn(head, "text-right")} title={t("stocktab.peers.coMove")}>
              {t("stocktab.peers.col.year")}
            </th>
            <th scope="col" className={cn(head, "text-right")} title={t("stocktab.peers.coMove")}>
              {t("stocktab.peers.col.quarter")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {data.peers.map((p) => (
            <tr key={p.ticker}>
              <td className="py-2 text-[12.5px] text-content-primary">
                <span className="font-medium" lang="en">
                  {p.ticker}
                </span>
                {p.name ? <span className="ml-2 text-content-secondary">{p.name}</span> : null}
                {p.basis === "filing" && p.filingUrl ? (
                  <button
                    type="button"
                    onClick={() => void window.meridian?.openExternal?.(p.filingUrl!)}
                    aria-label={t("stocktab.peers.openFiling")}
                    title={t("stocktab.peers.basis.filing")}
                    className="ml-2 inline-flex translate-y-[1px] items-center rounded-sm text-content-tertiary outline-none hover:text-content-primary focus-visible:ring-2 focus-visible:ring-edge-focus"
                  >
                    <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                  </button>
                ) : null}
              </td>
              <td className={cn(cell, "text-right")}>{p.corr1y !== null ? correlation(p.corr1y, language) : na}</td>
              <td className={cn(cell, "text-right")}>{p.corr3m !== null ? correlation(p.corr3m, language) : na}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11px] text-content-tertiary">{t("stocktab.peers.coMove")}</p>

      {data.moves.length > 0 ? (
        <div className="mt-7">
          <p className="text-[12px] font-medium text-content-secondary">{t("stocktab.peers.moves")}</p>
          <p className="mt-0.5 text-[11.5px] text-content-tertiary">{t("stocktab.peers.movesNote")}</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-edge-subtle">
                  <th scope="col" className={head}>{t("stocktab.peers.col.date")}</th>
                  <th scope="col" className={cn(head, "text-right font-medium text-content-secondary")} lang="en">
                    {ticker}
                  </th>
                  {data.peers.map((p) => (
                    <th key={p.ticker} scope="col" className={cn(head, "text-right")} lang="en">
                      {p.ticker}
                    </th>
                  ))}
                  <th scope="col" className={cn(head, "pl-4")}>{t("stocktab.peers.col.read")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {data.moves.map((m) => (
                  <tr key={m.date}>
                    <td className={cn(cell, "text-content-secondary")}>{fullDate(m.date, language)}</td>
                    <td className={cn(cell, "text-right font-medium", tone(m.move))}>{formatMove(m.move, language)}</td>
                    {data.peers.map((p) => {
                      const v = m.peerMoves[p.ticker] ?? null;
                      return (
                        <td key={p.ticker} className={cn(cell, "text-right", tone(v))}>
                          {v !== null ? formatMove(v, language) : na}
                        </td>
                      );
                    })}
                    <td className="py-2 pl-4 text-[12px] text-content-primary">
                      <span title={`${t(m.verdict === "sector" ? "stocktab.peers.verdictTitle.sector" : "stocktab.peers.verdictTitle.shift")}. ${t("stocktab.peers.counts", { same: m.same, opposite: m.opposite, flat: m.flat })}`}>
                        {t(m.verdict === "sector" ? "stocktab.peers.verdict.sector" : "stocktab.peers.verdict.shift")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
