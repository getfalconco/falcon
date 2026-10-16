import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { todayView, webUrl, whenOf, type TodayLine } from "../../../../shared/today-move";
import { nyToday, useStockToday, useTodayFormat } from "../use-stock-today";
import type { StockSectionProps } from "./types";

/**
 * Stock tab, under the header: the session's move when it is unusual for
 * this stock (its move beyond the market at least twice its usual day, over
 * the last sixty sessions), and what is on record since the close before it:
 * the company's own SEC filings, filing-linked companies that reported or
 * filed an 8-K, material company news, competitors that moved the same way,
 * the market and the sector fund. Each line names its source and links it.
 * None says why the stock moved. With nothing on record, that is said: the
 * absence is information too.
 *
 * An ordinary session shows nothing at all. shared/today-move.ts has the
 * rules; main/stock-tab-data/today.ts the reads.
 */

function SourceLink({ line, label }: { line: TodayLine; label: string }) {
  const url = webUrl(line.url);
  if (!url || !line.source) return null;
  return (
    <button
      type="button"
      onClick={() => void window.meridian?.openExternal?.(url)}
      aria-label={label}
      title={url}
      className="ml-2 inline-flex shrink-0 translate-y-[1px] items-center gap-1 rounded-sm text-[11.5px] text-content-tertiary underline-offset-2 outline-none hover:text-content-primary hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
    >
      <span>{line.source}</span>
      <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export default function TodaySection({ ticker }: StockSectionProps) {
  const { t, tNodes } = useI18n();
  const fmt = useTodayFormat();
  const data = useStockToday(ticker);
  if (!data || !data.unusual) return null;

  const today = nyToday();
  const view = todayView(data, today, fmt);
  const tone = data.move > 0 ? "text-tone-positive" : data.move < 0 ? "text-tone-negative" : "text-content-primary";

  return (
    <section aria-label={t("today.aria")} className="mt-7 rounded-xl border border-edge-subtle px-5 py-4">
      <p className="text-[14px] leading-[1.5] text-content-primary">
        {tNodes("today.headline", {
          ticker: (
            <span lang="en" className="font-medium">
              {data.ticker}
            </span>
          ),
          move: <span className={cn("font-medium tabular-nums", tone)}>{fmt.move(data.move)}</span>,
          when: whenOf(data.day, today, fmt),
          ratio: <span className="tabular-nums">{fmt.ratio(data.ratio)}</span>,
        })}
      </p>
      <p className="mt-1 text-[12px] leading-[1.5] text-content-tertiary">{view.context}</p>

      {view.lines.length > 0 ? (
        <p className="mt-4 text-[12px] font-medium text-content-secondary">{t("today.onRecord", { since: view.since })}</p>
      ) : null}
      <ul className="mt-1.5 divide-y divide-edge-subtle">
        {view.lines.map((line, i) => (
          <li key={`${line.group}:${i}`} className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-x-4 py-2">
            <span className="flex flex-col font-['Geist_Mono'] text-[11px] leading-[1.5] tabular-nums text-content-tertiary">
              <span>{line.time ?? ""}</span>
              {line.afterClose ? <span className="font-sans text-[10.5px]">{t("today.time.afterClose")}</span> : null}
            </span>
            <span className="min-w-0 text-[13px] leading-[1.5] text-content-primary">
              <span>{line.text}</span>
              <SourceLink line={line} label={t("today.openSource", { source: line.source })} />
            </span>
          </li>
        ))}
      </ul>
      {view.empty ? <p className={cn("text-[13px] text-content-secondary", view.lines.length > 0 ? "mt-1" : "mt-3")}>{view.empty}</p> : null}
      {view.note ? <p className="mt-2 text-[11px] text-content-tertiary">{view.note}</p> : null}
    </section>
  );
}
