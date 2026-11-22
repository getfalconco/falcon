"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { PAPER_ACCOUNT_ID } from "@/lib/portfolio-holdings";
import { CAP_DEFAULT, readCap, subscribeCap } from "@/lib/workspace/position-cap";
import { marketStatus } from "@/lib/workspace/market-status";
import {
  MISSING,
  capText,
  compactMoney,
  compactNumber,
  cashRows,
  holdingsSummary,
  money,
  overviewModel,
  pctText,
  positionRows,
  priceText,
  signedMoney,
  nextSort,
  overviewColumns,
  sortRows,
  tone,
  weightText,
  type CashRow,
  type Cols,
  type GroupId,
  type Indicator,
  type LinePart,
  type Sort,
  type SortKey,
  type OverviewRow,
} from "@/lib/workspace/positions-view";
import { useSparks } from "@/lib/workspace/spark";
import { useWorkspace } from "../context";
import { CurrencyFlag } from "./CurrencyFlag";
import { EquityCard } from "./EquityCard";
import { FlatMark } from "./FlatMark";
import { PositionLogo } from "./PositionLogo";

/**
 * The Dashboard's Portfolio Overview card, under the market strip: half the
 * row (left-aligned) on panes 900px and wider, full width below. No title or
 * buttons: top left, "Positions" with how many (cash counts once per
 * currency) and what they are under it (holdingsSummary), then the total live value (positions plus cash) with its
 * change beside it (always shown with a total: the gain since cost, else
 * today's change in grey, else $0.00 · 0.00%), and one line built from the numbers
 * (positions-view.ts: never by AI), each naming its period (since you bought, today).
 * Under it the holdings, grouped by kind (collapsible; headers sort within
 * each group, Cash last): Stock, Value, Weight (of the whole account, cash
 * included; red above the member's position cap), Change (today: % and the
 * position's $ move in fixed sub-columns), then Price, Market Cap, Volume and
 * the last 7 days as a sparkline (lib/workspace/spark.ts) as room allows.
 * Every figure is the
 * member's own or market data, live (lib/workspace/holdings.ts), held in
 * memory only; a missing one shows "—", a missing line an empty slot.
 *
 * Cash is the last group, one row per currency. Ticker-only: no total, a day
 * line, the full table. Paper cash-only: the cash as the total, a line and
 * only the Cash group, in a compact left-aligned card (360 to 440px). The
 * table area stays tall (360px) so it is ready to fill and scrolls past 420px.
 * Narrow cards drop Market Cap, then Volume, Price, Last 7 Days and the $
 * move (overviewColumns); Stock, Value, Weight and Change % always stay. In
 * development ⌘P swaps a random portfolio in (lib/workspace/holdings.ts); it
 * reads exactly like a real one, with no label.
 */

const TONE_CLASS = { up: "text-up", down: "text-down", flat: "text-quiet" } as const;
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/25";
/** Row widths (px) from which the card takes half the row. */
const HALF_FROM = 900;
const GAP = 12;

type GroupKey = GroupId | "cash";

/** The element's width, re-read when it changes. */
function useWidth(): { ref: (el: HTMLElement | null) => void; width: number | null } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? null));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

function gridTemplate(c: Cols): string {
  if (!c.market) return "minmax(0,1fr) minmax(96px,auto)";
  return [
    "minmax(120px,1fr)",
    "84px",
    "60px",
    c.dollar ? "136px" : "64px",
    c.price ? "84px" : null,
    c.cap ? "76px" : null,
    c.volume ? "64px" : null,
    c.spark ? "88px" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function PositionsCard() {
  const { holdings, portfolio, openTicker, userId } = useWorkspace();
  const cap = useSyncExternalStore(subscribeCap, () => readCap(userId), () => CAP_DEFAULT);
  const { ref, width } = useWidth();
  const { ref: rowRef, width: rowWidth } = useWidth();
  const half = rowWidth !== null && rowWidth >= HALF_FROM;
  const [collapsed, setCollapsed] = useState<ReadonlySet<GroupKey>>(new Set());
  // The table's order, for this visit only (never stored).
  const [sort, setSort] = useState<Sort>(null);
  const onSort = (k: SortKey) => setSort((s) => nextSort(s, k));

  const test = holdings.test;
  const data = holdings.data;
  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  // The ⌘P portfolio stands alone: the real ticker list stays out of it.
  const names = useMemo(() => (test ? {} : Object.fromEntries(portfolio.map((p) => [p.ticker, p.name]))), [portfolio, test]);
  const tickers = useMemo(() => (test ? [] : portfolio.map((p) => p.ticker)), [portfolio, test]);
  const rows = useMemo(() => positionRows(data?.positions ?? [], { tickers, quotes: data?.quotes ?? {}, names }), [data?.positions, data?.quotes, names, tickers]);
  const mainCurrency = data?.weightCurrency ?? accounts.find((a) => a.cash !== null)?.currency ?? null;
  const cash = useMemo(() => {
    const cur = mainCurrency ?? "USD";
    const withCash = accounts.filter((a) => a.cash !== null && (a.currency ?? "USD") === cur);
    return withCash.length ? withCash.reduce((s, a) => s + (a.cash ?? 0), 0) : null;
  }, [accounts, mainCurrency]);
  const cashByCurrency = useMemo(() => cashRows(accounts, mainCurrency), [accounts, mainCurrency]);
  const paper = accounts.some((a) => a.id === PAPER_ACCOUNT_ID);
  // "Today" and whether the market is open are judged at the answer's time, so the line follows the quotes.
  const model = useMemo(() => {
    const at = data?.at ?? Date.now();
    return overviewModel({ rows, cash, cashByCurrency, mainCurrency, paper, market: data?.market ?? {}, cap, marketOpen: marketStatus(at).state === "open", nowMs: at });
  }, [cap, cash, cashByCurrency, data?.at, data?.market, mainCurrency, paper, rows]);
  const symbols = useMemo(() => model.groups.flatMap((g) => g.rows.map((r) => r.quoteSymbol).filter((s): s is string => s !== null)), [model.groups]);
  const sparks = useSparks(symbols);
  const summary = useMemo(() => holdingsSummary(model.groups, model.cash), [model.groups, model.cash]);

  // Nothing at all: the setup card offers Get started.
  if (!rows.length && !holdings.paper && !(cash !== null && cash !== 0)) return null;

  const compact = model.cashOnly && !test;
  // Until measured, the fewest columns: a wide guess would widen the row it is measured in.
  const w = width ?? 0;
  const cols: Cols = compact ? { market: false, dollar: false, spark: false, price: false, cap: false, volume: false } : overviewColumns(w);
  const template = gridTemplate(cols);
  const toggle = (id: GroupKey) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    // Positions on the left, Equity on the right at the same height on panes 900px and wider; stacked below that.
    <div ref={rowRef} className={`flex w-full min-w-0 pl-1.5 ${half ? "flex-row items-stretch" : "flex-col"}`} style={{ gap: GAP }}>
      <section
        ref={ref}
        aria-label="Portfolio Overview"
        // Cash only (a fresh paper account): a small card, as wide as its content. Otherwise half the row on wide panes, full width below.
        style={compact ? undefined : { width: half ? `calc(50% - ${GAP / 2}px)` : "100%" }}
        className={`relative min-w-0 shrink-0 overflow-hidden rounded-2xl border border-line/[0.08] bg-raised shadow-[0_1px_2px_rgba(0,0,0,0.05),0_8px_24px_-6px_rgba(0,0,0,0.10)] ${
          compact ? "w-fit min-w-[min(360px,100%)] max-w-[min(440px,100%)] px-4 pb-2 pt-4" : "px-5 pb-3 pt-4"
        }`}
      >
        {/* The balance lives in the Equity card beside this one; here the big number is how many positions (cash is not one), and under it what they are. With none, a plain empty state with the cash on hand. */}
        <p className="mb-2 text-fs-13 text-quiet">Positions</p>
        {summary.count ? (
          <>
            <span className="block text-fs-17 font-semibold leading-fs-24 text-fore tabular-nums">{summary.count}</span>
            {summary.text ? <p className="mt-0.5 text-fs-13 leading-fs-20 text-quiet">{summary.text}</p> : null}
          </>
        ) : (
          <>
            <p className="text-fs-17 font-semibold leading-fs-24 text-fore">No positions yet</p>
            {cash !== null && cash !== 0 ? (
              <p className="mt-0.5 text-fs-13 leading-fs-20 text-quiet tabular-nums">
                {money(cash, mainCurrency ?? "USD", { digits: Math.abs(cash) >= 1000 && Number.isInteger(cash) ? 0 : 2 })} {paper ? "paper cash ready" : "in cash"}
              </p>
            ) : null}
          </>
        )}

        {summary.count && (model.groups.length || model.cash.length) ? (
          // Tall even when nearly empty, so it is ready to fill; long lists scroll under a sticky header.
          <div role="table" aria-label="Holdings" className="-mx-2 mt-4 flex max-h-[420px] min-h-[360px] flex-col overflow-y-auto px-2 text-fs-13 leading-fs-20">
            <div role="row" className="sticky top-0 z-[1] grid items-center gap-x-4 bg-raised pb-1.5 text-fs-12 text-quiet" style={{ gridTemplateColumns: template }}>
              {cols.market ? (
                <>
                  <SortHeader label="Stock" k="stock" sort={sort} onSort={onSort} align="left" />
                  <SortHeader label="Value" k="value" sort={sort} onSort={onSort} />
                  <SortHeader label="Weight" k="weight" sort={sort} onSort={onSort} />
                  <SortHeader label="Change" k="change" sort={sort} onSort={onSort} />
                  {cols.price ? <SortHeader label="Price" k="price" sort={sort} onSort={onSort} /> : null}
                  {cols.cap ? <SortHeader label="Market Cap" k="cap" sort={sort} onSort={onSort} /> : null}
                  {cols.volume ? <SortHeader label="Volume" k="volume" sort={sort} onSort={onSort} /> : null}
                  {cols.spark ? (
                    <span role="columnheader" className="text-right">
                      Last 7 Days
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <span role="columnheader">Stock</span>
                  <span role="columnheader" className="text-right">
                    Amount
                  </span>
                </>
              )}
            </div>
            {model.groups.map((g) => (
              <GroupRows key={g.id} label={g.label} count={g.rows.length} open={!collapsed.has(g.id)} onToggle={() => toggle(g.id)}>
                {sortRows(g.rows, sort).map((r) => (
                  <Row key={r.key} r={r} cols={cols} template={template} spark={r.quoteSymbol ? sparks[r.quoteSymbol] ?? null : null} cap={cap} openTicker={openTicker} />
                ))}
              </GroupRows>
            ))}
            {model.cash.length ? (
              <GroupRows label="Cash" count={model.cash.length} open={!collapsed.has("cash")} onToggle={() => toggle("cash")}>
                {model.cash.map((c) => (
                  <CashRowView key={c.currency} row={c} cols={cols} template={template} />
                ))}
              </GroupRows>
            ) : null}
          </div>
        ) : null}
      </section>
      <EquityCard currency={model.currency} total={model.total} hasSizes={model.sized} className={half ? "flex-1" : "h-[380px] w-full"} />
    </div>
  );
}

/**
 * Beside the total, each period named: the gain since cost ("+$X ↗ +Y% since
 * you bought", green up, red down, grey at zero) with today's move muted after it;
 * without a cost, today's move alone in grey; with neither, $0.00 · 0.00%.
 */
function Change({ indicator: c, currency }: { indicator: Indicator; currency: string }) {
  const day = c.today;
  const dayLabel = day?.when === "last session" ? "Last session" : "Today";
  if (c.sinceBought) {
    const t = c.sinceBought.tone;
    const Arrow = t === "down" ? ArrowDownRight : ArrowUpRight;
    return (
      <>
        <span className={`inline-flex items-center gap-1 text-fs-13 font-medium ${TONE_CLASS[t]}`} title="Since what you paid">
          {signedMoney(t === "flat" ? 0 : c.sinceBought.amount, currency)}
          {t === "flat" ? <FlatMark /> : <Arrow width={13} height={13} strokeWidth={2.25} aria-hidden />}
          {pctText(t === "flat" ? 0 : c.sinceBought.pct, 2)}
          <span className="font-normal">since you bought</span>
        </span>
        {day ? (
          <span className="text-fs-12 text-quiet">
            {dayLabel} {signedMoney(day.amount, currency, 0)} · {pctText(day.pct, 2)}
          </span>
        ) : null}
      </>
    );
  }
  if (day) {
    return (
      <span className="inline-flex items-center gap-1 text-fs-13 font-medium text-quiet">
        {signedMoney(day.amount, currency)} · {pctText(day.pct, 2)}
        <span className="font-normal">{day.when}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-fs-13 font-medium text-quiet">
      {signedMoney(0, currency)}
      <FlatMark />
      {pctText(0, 2)}
    </span>
  );
}

function Line({ parts }: { parts: readonly LinePart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.em ? (
          <span key={i} className={`font-medium ${p.tone ? TONE_CLASS[p.tone] : "text-fore"}`}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** A sortable column header: a real button; the faint double chevron when inactive, one arrow for the active direction. */
function SortHeader({ label, k, sort, onSort, align = "right" }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; align?: "left" | "right" }) {
  const dir = sort?.key === k ? sort.dir : null;
  const Icon = dir === "asc" ? ChevronUp : dir === "desc" ? ChevronDown : ChevronsUpDown;
  return (
    <span role="columnheader" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"} className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`-mx-1 inline-flex items-center gap-0.5 rounded px-1 transition-colors hover:text-fore ${dir ? "font-medium text-fore" : ""} ${FOCUS}`}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <Icon width={12} height={12} strokeWidth={2.25} aria-hidden className={dir ? "" : "opacity-50"} />
      </button>
    </span>
  );
}

function GroupRows({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div role="rowgroup">
      <div role="row" className="mt-1">
        <span role="cell" className="block">
          <button type="button" onClick={onToggle} aria-expanded={open} className={`-mx-1 inline-flex items-center gap-1.5 rounded px-1 py-1 text-fs-12 font-medium text-fore-4 transition-colors hover:text-fore ${FOCUS}`}>
            <ChevronDown width={13} height={13} strokeWidth={2.25} aria-hidden className={`transition-transform ${open ? "" : "-rotate-90"}`} />
            {label}
            <span className="font-normal text-quiet tabular-nums">{count}</span>
          </button>
        </span>
      </div>
      {open ? children : null}
    </div>
  );
}

/** Cash in one currency: its flag and code, the amount as its value and its share of the account; the market columns stay empty. */
function CashRowView({ row, cols, template }: { row: CashRow; cols: Cols; template: string }) {
  const empty = (k: string) => <span key={k} role="cell" aria-hidden />;
  return (
    <div role="row" className="-mx-2 grid min-h-[34px] items-center gap-x-4 rounded-lg px-2 py-0.5 tabular-nums" style={{ gridTemplateColumns: template }}>
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <CurrencyFlag currency={row.currency} size={16} />
        <span className="font-semibold text-fore">{row.currency}</span>
      </span>
      <span role="cell" className="text-right text-fore">
        {cols.market ? money(row.amount, row.currency, { digits: 0 }) : money(row.amount, row.currency)}
      </span>
      {cols.market ? (
        <span role="cell" className="text-right text-fore-4">
          {row.weight == null ? MISSING : weightText(row.weight)}
        </span>
      ) : null}
      {cols.market ? empty("change") : null}
      {cols.price ? empty("price") : null}
      {cols.cap ? empty("cap") : null}
      {cols.volume ? empty("volume") : null}
      {cols.spark ? empty("spark") : null}
    </div>
  );
}

function Row({ r, cols, template, spark, cap, openTicker }: { r: OverviewRow; cols: Cols; template: string; spark: number[] | null; cap: number; openTicker: (t: string) => void }) {
  const onOpen = r.ticker ? () => openTicker(r.ticker!) : null;
  const pctTone = r.changePct === null ? "text-quiet" : TONE_CLASS[tone(r.changePct)];
  return (
    <div
      role="row"
      onClick={onOpen ?? undefined}
      className={`-mx-2 grid min-h-[34px] items-center gap-x-4 rounded-lg px-2 py-0.5 tabular-nums ${onOpen ? "cursor-pointer hover:bg-line/[0.035]" : ""}`}
      style={{ gridTemplateColumns: template }}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <PositionLogo row={r} size={16} />
        {onOpen ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className={`shrink-0 rounded font-semibold text-fore ${FOCUS}`}
            title={`Open ${r.ticker}`}
          >
            {r.label}
          </button>
        ) : (
          <span className="shrink-0 font-semibold text-fore">{r.label}</span>
        )}
        {r.name ? <span className="min-w-0 truncate text-quiet">{r.name}</span> : null}
      </span>
      <span role="cell" className={`text-right ${r.value === null ? "text-quiet" : "text-fore"}`}>
        {r.value === null ? MISSING : money(r.value, r.currency, { digits: 0 })}
      </span>
      <span role="cell" className={`text-right ${r.weight === null ? "text-quiet" : r.overCap ? "text-down" : "text-fore-4"}`} title={capText(r.overCap ? r.weight : null, cap) ?? undefined}>
        {r.weight === null ? MISSING : weightText(r.weight)}
      </span>
      {/* Two fixed sub-columns, so every row's % and the position's $ move line up under the header. */}
      <span role="cell" className="flex items-baseline justify-end gap-2">
        <span className={`w-[64px] text-right ${pctTone}`}>{r.changePct === null ? MISSING : pctText(r.changePct, 2)}</span>
        {cols.dollar ? <span className="w-[64px] text-right text-fs-12 text-quiet">{r.dayMove === null ? "" : signedMoney(r.dayMove, r.currency, 0)}</span> : null}
      </span>
      {cols.price ? (
        <span role="cell" className="text-right text-fore-4">
          {r.price === null ? <span className="text-quiet">{MISSING}</span> : priceText(r.price, r.priceCurrency)}
        </span>
      ) : null}
      {cols.cap ? (
        <span role="cell" className={`text-right ${r.marketCap === null ? "text-quiet" : "text-fore-4"}`}>
          {r.marketCap === null ? MISSING : compactMoney(r.marketCap, r.priceCurrency)}
        </span>
      ) : null}
      {cols.volume ? (
        <span role="cell" className={`text-right ${r.volume === null ? "text-quiet" : "text-fore-4"}`}>
          {r.volume === null ? MISSING : compactNumber(r.volume)}
        </span>
      ) : null}
      {cols.spark ? (
        <span role="cell" className="flex justify-end">
          <Sparkline points={spark} label={r.label} />
        </span>
      ) : null}
    </div>
  );
}

const SPARK_W = 80;
const SPARK_H = 24;

/** The last 7 days as a line, green when it ended up, red when down; no axes. An empty slot without data. */
function Sparkline({ points, label }: { points: number[] | null; label: string }) {
  if (!points || points.length < 2) return <span className="block" style={{ width: SPARK_W, height: SPARK_H }} aria-hidden />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const pad = 2;
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (SPARK_W - pad * 2);
  const y = (v: number) => (max === min ? SPARK_H / 2 : pad + (1 - (v - min) / span) * (SPARK_H - pad * 2));
  const d = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const change = ((points[points.length - 1]! - points[0]!) / points[0]!) * 100;
  const t = tone(Math.abs(change) < 0.005 ? 0 : change);
  return (
    <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={`${label}, last 7 days: ${pctText(change, 1)}`} className={TONE_CLASS[t]}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
