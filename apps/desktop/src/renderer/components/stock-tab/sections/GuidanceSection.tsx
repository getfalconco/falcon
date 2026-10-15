import { useCallback, useState } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SKELETON } from "@/components/earnings/earnings-ui";
import type { GuidanceRow, GuidanceTrack } from "../../../../shared/guidance-types";
import {
  guideText,
  metricText,
  patternText,
  shownPatterns,
  periodText,
  resultKey,
  ROWS_SHOWN,
  visibleRows,
  figureText,
  type Say,
} from "../../../../shared/guidance-view";
import { periodKey } from "../../../../shared/guidance-verify";
import { useGuidanceTrack } from "../use-guidance";
import { useTabActive } from "../use-tab-active";
import type { StockSectionProps } from "./types";
import { fullDate } from "./stock-data-format";

/**
 * Stock tab: what the company guided against what it then reported, quarter
 * by quarter, from the earnings releases on EDGAR (main/guidance).
 *
 *   pattern lines  per guided figure with three or more quarters on record:
 *                  where it landed most often, how often at or above the
 *                  midpoint, the median gap (shared/guidance-view.ts)
 *   table          quarter, figure, guide, reported, result. Hovering a
 *                  figure shows the release sentence it was read from; a
 *                  press opens that release on SEC.gov
 *
 * Asked only while the tab is in front. Renders nothing for a company whose
 * releases give no figures, so the heading goes with it.
 */

const NUM = "font-['Geist_Mono'] tabular-nums";

function open(url: string) {
  void window.meridian?.openExternal?.(url);
}

function hoverText(quote: string, line: string): string {
  return `“${quote}”\n${line}`;
}

function Row({ row, first, say, lang }: { row: GuidanceRow; first: boolean; say: Say; lang: string }) {
  const cell = "py-1.5 pr-3 text-[12.5px] align-top";
  const guideHover = [
    hoverText(row.guide.quote, say("guidance.hover.guide", { date: fullDate(row.guide.filedAt, lang) })),
    row.prior
      ? say("guidance.hover.prior", { range: guideText({ ...row, low: row.prior.low, high: row.prior.high }, lang, say), date: fullDate(row.prior.filedAt, lang) })
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const changed = row.revision === "raised" || row.revision === "cut";
  return (
    <tr className={first ? "border-t border-edge-subtle" : undefined}>
      <td className={cn(cell, "whitespace-nowrap text-content-secondary")}>{first ? periodText(row.period, say) : ""}</td>
      <td className={cn(cell, "text-content-primary")}>{metricText(row.metric, row.basis, say)}</td>
      <td className={cn(cell, NUM, "whitespace-nowrap text-content-secondary")}>
        <button
          type="button"
          title={guideHover}
          onClick={() => open(row.guide.url)}
          className="rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
        >
          {guideText(row, lang, say)}
        </button>
        {changed ? <span className="ml-1.5 font-sans text-[11px] text-content-tertiary">{say(`guidance.revision.${row.revision}`)}</span> : null}
      </td>
      <td className={cn(cell, NUM, "whitespace-nowrap text-right text-content-primary")}>
        {row.actual !== null && row.reported ? (
          <button
            type="button"
            title={hoverText(row.reported.quote, say("guidance.hover.reported", { date: fullDate(row.reported.filedAt, lang) }))}
            onClick={() => open(row.reported!.url)}
            className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
          >
            {figureText(row.actual, row.unit, row.currency, lang)}
          </button>
        ) : null}
      </td>
      <td className={cn(cell, "whitespace-nowrap pl-3", row.state === "resolved" ? "text-content-primary" : "text-content-tertiary")}>
        {say(resultKey(row))}
      </td>
    </tr>
  );
}

function Track({ track, say, lang }: { track: GuidanceTrack; say: Say; lang: string }) {
  const [all, setAll] = useState(false);
  const rows = visibleRows(track.rows);
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  const head = "pb-2 pr-3 text-left text-[11px] font-normal text-content-tertiary";
  return (
    <div>
      {track.patterns.length > 0 ? (
        <ul className="mb-5 space-y-1">
          {shownPatterns(track.patterns).map((p) => (
            <li key={`${p.metric}|${p.basis}`} className="text-[12.5px] leading-5 text-content-primary">
              {patternText(p, lang, say)}
            </li>
          ))}
        </ul>
      ) : null}
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th scope="col" className={head}>{say("guidance.col.period")}</th>
            <th scope="col" className={head}>{say("guidance.col.metric")}</th>
            <th scope="col" className={head}>{say("guidance.col.guide")}</th>
            <th scope="col" className={cn(head, "text-right")}>{say("guidance.col.actual")}</th>
            <th scope="col" className={cn(head, "pl-3")}>{say("guidance.col.result")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <Row
              key={`${periodKey(r.period)}|${r.metric}|${r.basis}`}
              row={r}
              first={i === 0 || periodKey(shown[i - 1]!.period) !== periodKey(r.period)}
              say={say}
              lang={lang}
            />
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
        {track.latest ? (
          <p className="text-[11px] leading-[1.45] text-content-tertiary">
            {say("guidance.note", { count: track.releases, date: fullDate(track.latest, lang) })}
          </p>
        ) : null}
        {rows.length > ROWS_SHOWN ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="rounded-sm text-[11.5px] text-content-secondary underline-offset-2 outline-none hover:text-content-primary hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
          >
            {all ? say("guidance.showFewer") : say("guidance.showAll", { count: rows.length })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function GuidanceSection({ ticker }: StockSectionProps) {
  const { t, language } = useI18n();
  const say = useCallback<Say>((key, params) => t(key as MessageKey, params), [t]);
  const active = useTabActive();
  // Asked only while the tab is in front; hidden, what was drawn stays and nothing is fetched.
  const state = useGuidanceTrack(active ? ticker.trim().toUpperCase() : null);
  if (state.status === "none") return null;
  if (state.status === "loading") {
    if (!active) return null;
    return (
      <div className="space-y-2" role="status" aria-label={say("guidance.loading")}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn(SKELETON, "h-4", i % 2 ? "w-3/4" : "w-5/6")} />
        ))}
      </div>
    );
  }
  if (visibleRows(state.track.rows).length === 0) return null;
  return <Track track={state.track} say={say} lang={language} />;
}
