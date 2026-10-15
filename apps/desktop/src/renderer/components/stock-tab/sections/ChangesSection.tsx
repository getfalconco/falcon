import { useCallback, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ChangeItem, ChangeTag, SourceRef } from "../../../../shared/stock-tab-data";
import { formatEps } from "../../../../shared/earnings-view";
import { useThesis } from "../thesis-store";
import { useChangeTags, useStockChanges } from "../use-stock-tab-data";
import type { StockSectionProps } from "./types";
import { categoryKey, changePct, compactCount, compactUsd, fullDate, periodKey, price, sharePct, wholeCount } from "./stock-data-format";
import { useInsiderActivity } from "@/lib/insiders-store";
import type { Say } from "../../../../shared/earnings-view";
import type { InsiderEvent } from "../../../../shared/insider-types";
import { changesInsiderEvents, eventSource, eventSpan, eventTitle, insidersLine } from "../../../../shared/insider-view";

/**
 * Stock tab: what changed on the stock since the reader last opened it, or
 * over the last seven days, whichever is longer (main/stock-tab-data). Each
 * line is a dated fact with its source: estimate revisions, short interest,
 * the analysts' mean price estimate, open market insider trades, links added
 * to the filing graph. With a thesis written, each line also carries how it
 * reads against it (supports, weakens, neutral) and a short reason.
 *
 * Nothing sourced, nothing shown: the section renders null and the tab hides
 * its heading.
 */

type T = ReturnType<typeof useI18n>["t"];

const TAG_TONE: Record<ChangeTag["tag"], string> = {
  supports: "bg-tone-positive-soft text-tone-positive",
  weakens: "bg-tone-negative-soft text-tone-negative",
  neutral: "bg-fill-selected text-content-secondary",
};

function SourceLink({ source, label, t }: { source: SourceRef; label: string; t: T }) {
  if (!source.url) return <span>{label}</span>;
  return (
    <button
      type="button"
      onClick={() => void window.meridian?.openExternal?.(source.url!)}
      aria-label={`${t("stocktab.changes.openSource")}: ${label}`}
      className="inline-flex items-center gap-1 rounded-sm underline-offset-2 outline-none hover:text-content-primary hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
    >
      {label}
      <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function sourceLabel(item: ChangeItem, t: T): string {
  if (item.source.kind === "form4") return t("stocktab.changes.source.form4");
  if (item.source.kind === "filing") return t("stocktab.changes.source.filing");
  return t("stocktab.changes.source.yahoo");
}

function categoryText(category: string, t: T): string {
  const k = categoryKey(category);
  return k ? t(`stocktab.changes.category.${k}` as MessageKey) : category;
}

/** The line and its detail, in the reader's language, from the item's own figures. */
function lines(item: ChangeItem, ticker: string, t: T, lang: string): { main: string; detail: string | null; badge: ReactNode } {
  switch (item.kind) {
    case "estimate_revision": {
      const before = formatEps(item.epsBefore, lang);
      const now = formatEps(item.epsNow, lang);
      return {
        main: t("stocktab.changes.revision", {
          period: t(`stocktab.changes.period.${periodKey(item.period)}` as MessageKey),
          up: item.up,
          down: item.down,
          days: item.days,
        }),
        // The mean is shown only when it moved at the precision printed.
        detail: before && now && before !== now ? t("stocktab.changes.revisionMean", { before, now }) : null,
        badge: null,
      };
    }
    case "short_interest": {
      const detail = item.previousDate
        ? t("stocktab.changes.shortInterestDetail", { previous: compactCount(item.previousShares, lang), previousDate: fullDate(item.previousDate, lang) })
        : null;
      const float = item.floatShare !== null ? t("stocktab.changes.floatShare", { pct: sharePct(item.floatShare, lang) }) : null;
      return {
        main: t("stocktab.changes.shortInterest", { change: changePct(item.shares, item.previousShares, lang), shares: compactCount(item.shares, lang) }),
        detail: [detail, float].filter(Boolean).join(", ") || null,
        badge: null,
      };
    }
    case "price_estimate": {
      const parts = [
        t("stocktab.changes.priceEstimateDetail", { previous: price(item.previous, item.currency, lang), previousDate: fullDate(item.previousDate, lang) }),
        item.analysts !== null ? t("stocktab.changes.analysts", { count: item.analysts }) : null,
      ];
      return {
        main: t("stocktab.changes.priceEstimate", { change: changePct(item.value, item.previous, lang), value: price(item.value, item.currency, lang) }),
        detail: parts.filter(Boolean).join(", "),
        badge: null,
      };
    }
    case "insider":
      return {
        main: t(item.code === "P" ? "stocktab.changes.insider.P" : "stocktab.changes.insider.S", {
          name: item.name,
          role: item.role,
          shares: wholeCount(item.shares, lang),
        }),
        detail: item.value !== null ? compactUsd(item.value, lang) : null,
        badge: item.plan ? (
          <span title={t("stocktab.changes.planTitle")} className="rounded-full bg-fill-selected px-1.5 py-px text-[10.5px] text-content-secondary">
            {t("stocktab.changes.plan")}
          </span>
        ) : null,
      };
    case "link_added": {
      const company = item.counterpartyName ? `${item.counterpartyName} (${item.counterparty})` : item.counterparty;
      const filer = item.direction === "names" ? ticker : item.counterparty;
      return {
        main: t("stocktab.changes.link", { company, category: categoryText(item.category, t) }),
        detail: item.filingDate ? t("stocktab.changes.linkDetail", { filer, form: item.form ?? "10-K", date: fullDate(item.filingDate, lang) }) : null,
        badge: null,
      };
    }
  }
}

function TagPill({ tag, t }: { tag: ChangeTag; t: T }) {
  const title = tag.reason ? t("stocktab.changes.tagTitle", { reason: tag.reason }) : t("stocktab.changes.tagTitleBare");
  return (
    <span title={title} className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", TAG_TONE[tag.tag])}>
      {t(`stocktab.changes.tag.${tag.tag}` as MessageKey)}
    </span>
  );
}

/**
 * An insider pattern from main/insiders (a cluster of purchases, an unplanned
 * sale, a 13D or 13G), set like the section's other lines.
 */
function InsiderEventRow({ event, t, say, lang }: { event: InsiderEvent; t: T; say: Say; lang: string }) {
  const source = eventSource(event);
  const who = insidersLine(event, say);
  return (
    <li className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-start gap-x-4 py-3">
      <span className="pt-px font-['Geist_Mono'] text-[11.5px] tabular-nums text-content-tertiary">{fullDate(event.date, lang)}</span>
      <div className="min-w-0">
        <p className="text-[13px] leading-5 text-content-primary">{eventTitle(event, say, lang)}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-4 text-content-secondary">
          <span className="tabular-nums">{who ? `${who} · ${eventSpan(event, say, lang)}` : eventSpan(event, say, lang)}</span>
          <span className="text-content-tertiary">
            <SourceLink source={{ kind: event.filing ? "filing" : "form4", url: source.url }} label={source.label} t={t} />
          </span>
        </p>
      </div>
      <div />
    </li>
  );
}

export default function ChangesSection({ ticker }: StockSectionProps) {
  const { t, language } = useI18n();
  const changes = useStockChanges(ticker);
  const thesis = useThesis(ticker);
  const tags = useChangeTags(ticker, thesis.text, changes);
  const insiders = useInsiderActivity(ticker);
  const say = useCallback<Say>((key, params) => t(key as MessageKey, params), [t]);

  if (!changes) return null;
  // Insider patterns in the window (main/insiders) stand in for the plain
  // Form 4 lines; with none, the Form 4 lines stay.
  const events = changesInsiderEvents(insiders.value?.events, ticker, changes.since);
  const items = events.length > 0 ? changes.items.filter((item) => item.kind !== "insider") : changes.items;
  if (items.length === 0 && events.length === 0) return null;
  // Where the Form 4 lines sat: after the figures, before the graph links.
  const linksAt = items.findIndex((item) => item.kind === "link_added");
  const head = linksAt < 0 ? items : items.slice(0, linksAt);
  const tail = linksAt < 0 ? [] : items.slice(linksAt);

  const since = fullDate(changes.since, language);
  return (
    <div>
      <p className="mb-3 text-[12px] text-content-tertiary">
        {changes.sinceVisit ? t("stocktab.changes.sinceVisit", { date: since }) : t("stocktab.changes.since", { date: since })}
      </p>
      <ul className="divide-y divide-edge-subtle border-y border-edge-subtle">
        {[...head.map((item) => ({ item })), ...events.map((event) => ({ event })), ...tail.map((item) => ({ item }))].map((row) => {
          if ("event" in row) return <InsiderEventRow key={row.event.id} event={row.event} t={t} say={say} lang={language} />;
          const { item } = row;
          const { main, detail, badge } = lines(item, ticker, t, language);
          const tag = tags?.get(item.id) ?? null;
          return (
            <li key={item.id} className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-start gap-x-4 py-3">
              <span className="pt-px font-['Geist_Mono'] text-[11.5px] tabular-nums text-content-tertiary">{fullDate(item.date, language)}</span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-content-primary">
                  <span className="min-w-0">{main}</span>
                  {badge}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-4 text-content-secondary">
                  {detail ? <span className="tabular-nums">{detail}</span> : null}
                  <span className="text-content-tertiary">
                    <SourceLink source={item.source} label={sourceLabel(item, t)} t={t} />
                  </span>
                </p>
                {tag?.reason ? <p className="mt-1 text-[11.5px] leading-4 text-content-secondary">{tag.reason}</p> : null}
              </div>
              <div className="pt-px">{tag ? <TagPill tag={tag} t={t} /> : null}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
