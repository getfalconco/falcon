import { useRef, useState } from "react";
import type { MessageKey } from "@/lib/i18n";
import { useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { SKELETON, useSay } from "@/components/earnings/earnings-ui";
import { useHeldPositions, useReadthroughFocus, type ReadthroughAnswer } from "@/lib/readthrough-store";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import {
  READTHROUGH_BENCHMARK,
  READTHROUGH_MAX_EVENTS,
  READTHROUGH_MIN_EVENTS,
  type ReadthroughRelation,
  type ReadthroughRow,
} from "../../../../shared/readthrough-types";
import { focusLine, focusRows, focusWhen, formatRatio, sourceHint } from "../../../../shared/readthrough-view";
import { useTabActive } from "../use-tab-active";
import type { StockSectionProps } from "./types";

/**
 * Stock tab: read-through. The open stock's filing-linked companies
 * (suppliers, customers, competitors, from either company's 10-K or 20-F),
 * each with how the stock moved on that company's past report days: how often
 * its move beyond the market had the company's sign, and its size against a
 * normal day. The figures are the read-through radar's own
 * (main/readthrough/event-study.ts), asked for this one name; the sample is
 * always printed, and below the minimum only the count is. A report inside
 * the radar's window (next four weeks, last week) is dated on the row.
 *
 * Measured rows first, by sensitivity. Nothing is asked for while the tab is
 * hidden behind another.
 */

const ROWS = 8;

const RELATION_KEY: Record<ReadthroughRelation, MessageKey> = {
  supplier: "stocktab.graph.role.supplier",
  customer: "stocktab.graph.role.customer",
  competitor: "stocktab.graph.role.competitor",
};

const PLAIN_TICKER =
  "app-no-drag w-[52px] shrink-0 cursor-pointer truncate text-left text-[13px] font-medium text-content-primary underline-offset-2 outline-none hover:underline focus-visible:underline";

function Row({ row, ticker, today }: { row: ReadthroughRow; ticker: string; today: string }) {
  const { say, lang, t } = useSay();
  const s = row.stats;
  const when = focusWhen(row, today, say, lang);
  const hint = s
    ? t("readthrough.focus.hint", {
        ticker,
        counterparty: row.counterparty,
        count: s.events,
        beta: formatRatio(s.beta, lang) ?? "1.0",
        benchmark: READTHROUGH_BENCHMARK,
      })
    : undefined;
  return (
    <li className="flex min-w-0 items-center gap-3 px-1 py-2">
      <button
        type="button"
        onClick={() => openStock(row.counterparty, row.counterpartyName ?? undefined)}
        aria-label={t("stocktab.tab.open", { ticker: row.counterparty })}
        title={row.counterpartyName ?? undefined}
        className={PLAIN_TICKER}
        lang="en"
      >
        {row.counterparty}
      </button>
      <span className="w-[92px] shrink-0 truncate text-[12px] text-content-tertiary" title={sourceHint(row, say, lang)}>
        {t(RELATION_KEY[row.relation])}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px] tabular-nums", s ? "text-content-primary" : "text-content-tertiary")} title={hint}>
        {focusLine(row, say, lang)}
      </span>
      {when ? (
        <span className="shrink-0 text-[12px] tabular-nums text-content-secondary" title={row.time !== "unknown" ? say(`readthrough.time.${row.time}`) : undefined}>
          {when}
        </span>
      ) : null}
    </li>
  );
}

/** The rows and their notes, drawn from one answer. Exported for the render test. */
export function ReadthroughRows({ answer, ticker, limit = ROWS }: { answer: ReadthroughAnswer; ticker: string; limit?: number }) {
  const { t } = useSay();
  const [all, setAll] = useState(false);
  const rows = focusRows(answer.rows.filter((r) => r.holding === ticker));
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, limit);
  const notes = [t("readthrough.focus.note", { max: READTHROUGH_MAX_EVENTS, min: READTHROUGH_MIN_EVENTS, benchmark: READTHROUGH_BENCHMARK })];
  if (answer.truncated) notes.push(t("readthrough.note.truncated"));
  if (answer.degraded.length > 0) notes.push(t("readthrough.note.degraded"));
  return (
    <div>
      <ul className="divide-y divide-edge-subtle">
        {shown.map((row) => (
          <Row key={row.id} row={row} ticker={ticker} today={answer.today} />
        ))}
      </ul>
      {rows.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="app-no-drag mt-1.5 text-[12px] text-content-secondary underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {t("readthrough.section.showMore", { count: rows.length - shown.length })}
        </button>
      ) : null}
      <div className="mt-2 space-y-0.5">
        {notes.map((n) => (
          <p key={n} className="text-[11px] leading-[1.45] text-content-tertiary">
            {n}
          </p>
        ))}
      </div>
    </div>
  );
}

export default function ReadthroughSection({ ticker }: StockSectionProps) {
  const symbol = ticker.trim().toUpperCase();
  const active = useTabActive();
  const held = useHeldPositions();
  const watchlist = useWatchlistTickers();
  // Asked only while the tab is in front; hidden, the last answer stays drawn and nothing is fetched.
  const state = useReadthroughFocus(active ? symbol : null, held, watchlist);
  const last = useRef<ReadthroughAnswer | null>(null);
  if (state.value) last.current = state.value;
  const answer = state.value ?? last.current;

  if (!answer) {
    // A failure, or a main process without the channel: nothing sourced to show.
    if (!active || state.error !== null || state.settled) return null;
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(SKELETON, "h-4", i === 1 ? "w-3/4" : "w-5/6")} />
        ))}
      </div>
    );
  }
  return <ReadthroughRows answer={answer} ticker={symbol} />;
}
