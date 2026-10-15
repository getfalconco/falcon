import { ExternalLink } from "lucide-react";
import { useI18n, type MessageKey, type TFunction } from "@/lib/i18n";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import { shortCompanyName } from "../../../shared/earnings-view";
import type { ExposureHeadline, ExposureScope, ExposureSource, ExposureVia, SharedDependency } from "../../../shared/exposure";
import { exposurePct } from "../../../shared/exposure";

/**
 * The pieces the Exposure tab and the Exposure card share. Written in the
 * app's own class vocabulary (the plain ticker of the agent rows, the quiet
 * greys of the Earnings tab), so the dark theme's translation in globals.css
 * covers them without new rules.
 */

export const NUM = "text-right font-['Geist_Mono'] text-[12px] tabular-nums";

const TICKER =
  "app-no-drag inline-flex h-[18px] shrink-0 cursor-pointer items-center text-[12px] font-medium text-[#1d1b1b] underline-offset-2 outline-none hover:underline focus-visible:underline";

/** A name short enough for a row: "NVIDIA Corporation" reads "NVIDIA" (earnings-view's rule). */
export function displayName(name: string): string {
  return shortCompanyName(name) ?? name;
}

/** "Feb 2026": the month a filing went in, in the reader's language. */
export function filedMonth(date: string | null, locale: string): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(d);
  } catch {
    return date.slice(0, 7);
  }
}

/** "Per NVDA 10-K, filed Feb 2026". */
export function sourceText(t: TFunction, source: ExposureSource, locale: string): string {
  const date = filedMonth(source.filingDate, locale);
  if (source.form && date) return t("exposure.source.formDate", { filer: source.filer, form: source.form, date });
  if (source.form) return t("exposure.source.form", { filer: source.filer, form: source.form });
  if (date) return t("exposure.source.date", { filer: source.filer, date });
  return t("exposure.source.plain", { filer: source.filer });
}

/** The filing behind a row, opened in the browser; plain text when it has no address. */
export function SourceLink({ source, className }: { source: ExposureSource; className?: string }) {
  const { t, locale } = useI18n();
  const text = sourceText(t, source, locale);
  if (!/^https:\/\//i.test(source.url)) return <span className={cn("truncate text-[12px] text-[#6b7280]", className)}>{text}</span>;
  return (
    <button
      type="button"
      onClick={() => void window.meridian?.openExternal(source.url)}
      aria-label={t("exposure.row.openFiling", { filer: source.filer })}
      title={text}
      className={cn(
        "app-no-drag inline-flex min-w-0 items-center gap-1 text-left text-[12px] text-[#4b5563] underline decoration-[#cfcfc8] underline-offset-[3px] transition-colors hover:text-[#1d1b1b] hover:decoration-[#1d1b1b]",
        className,
      )}
    >
      <span className="truncate">{text}</span>
      <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** A ticker set as plain text; a press opens the stock. */
export function TickerLink({ ticker, name, className }: { ticker: string; name?: string; className?: string }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => openStock(ticker, name)} aria-label={t("exposure.row.open", { ticker })} className={cn(TICKER, className)}>
      {ticker}
    </button>
  );
}

/** The company a row is about: its ticker (a door to the stock when the app lists it) and its name. */
export function CompanyCell({
  row,
  compact = false,
  className,
}: {
  row: Pick<SharedDependency, "ticker" | "name" | "listed">;
  /** A narrow card: the ticker alone when there is one, the name in its tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const name = displayName(row.name);
  const sameAsTicker = row.ticker !== null && (compact || name.toUpperCase() === row.ticker);
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)} title={compact ? row.name : undefined}>
      {row.ticker ? (
        row.listed ? (
          <TickerLink ticker={row.ticker} name={name} />
        ) : (
          <span className="shrink-0 text-[12px] font-medium text-[#1d1b1b]">{row.ticker}</span>
        )
      ) : null}
      {sameAsTicker ? null : (
        <span className={cn("truncate text-[12.5px]", row.ticker ? "text-[#6b7280]" : "text-[#1d1b1b]")} title={row.name}>
          {name}
        </span>
      )}
    </span>
  );
}

const RELATION_KEY: Record<ExposureVia["relation"], MessageKey> = {
  supplier: "exposure.relation.supplier",
  customer: "exposure.relation.customer",
  partner: "exposure.relation.partner",
  dependency: "exposure.relation.dependency",
};

const TIER_KEY: Record<ExposureVia["tier"], MessageKey> = {
  critical: "exposure.tier.critical",
  important: "exposure.tier.important",
  marginal: "exposure.tier.marginal",
};

/** "NVDA: supplier, important link in its own filing". */
export function viaTitle(t: TFunction, via: ExposureVia, filer: string): string {
  const relation = t(RELATION_KEY[via.relation]);
  return via.own
    ? t("exposure.via.own", { ticker: via.ticker, relation, tier: t(TIER_KEY[via.tier]) })
    : t("exposure.via.theirs", { ticker: via.ticker, relation, filer });
}

/** The holdings a company sits under, as plain tickers, the strongest first; the rest as "+2". */
export function ViaTickers({ row, max, className }: { row: SharedDependency; max: number; className?: string }) {
  const { t } = useI18n();
  const shown = row.via.slice(0, max);
  const rest = row.via.slice(max);
  // A link only the other company's filing carries names that company as the filer.
  const filer = row.ticker ?? row.name;
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      {shown.map((v) => (
        <span key={v.ticker} title={viaTitle(t, v, filer)} className="inline-flex h-[18px] shrink-0 items-center text-[12px] font-medium text-[#4b5563]">
          {v.ticker}
        </span>
      ))}
      {rest.length > 0 ? (
        <span title={rest.map((v) => viaTitle(t, v, filer)).join("\n")} className="shrink-0 text-[11.5px] text-[#9CA3AF]">
          {t("exposure.more", { count: rest.length })}
        </span>
      ) : null}
    </span>
  );
}

/** The line over the tab and the card, or null when no company passes a fifth of the book. */
export function headlineText(t: TFunction, headline: ExposureHeadline | null, scope: ExposureScope): string | null {
  if (!headline) return null;
  const watch = scope === "watchlist";
  if (headline.count === 1 && headline.name && headline.exposure !== null) {
    return t(watch ? "exposure.headline.oneWatch" : "exposure.headline.one", {
      name: displayName(headline.name),
      pct: exposurePct(headline.exposure),
    });
  }
  return t(watch ? "exposure.headline.manyWatch" : "exposure.headline.many", {
    count: headline.count,
    pct: exposurePct(headline.threshold),
  });
}
