import { useEffect, useMemo, useState } from "react";
import StockIcon from "@/components/stock/StockIcon";
import StockLivePrice from "@/components/stock/StockLivePrice";
import { useLiveQuote } from "@/hooks/useLiveQuote";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useRiskSnapshot } from "@/hooks/useRiskSnapshot";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import { subscribeDemoMode } from "@/lib/demo-mode";
import { openStock } from "@/lib/stock-open";
import { useStockTab } from "@/lib/stock-tab-store";
import { cn } from "@/lib/utils";
import type { StockContextLink } from "../../../../shared/stock-context";
import { heldContext } from "../header-context";
import { useStockOverview } from "../use-stock-overview";
import { useTabActive } from "../use-tab-active";
import type { StockSectionProps } from "./types";

/**
 * Stock tab, 1: the company and the reader's own context. Logo, name and
 * exchange; the live price and the session's move; then, for a held name,
 * its weight, size, cost basis, P&L and share of the portfolio's risk, and
 * for a name not held, which holdings stand one filing hop from it.
 *
 * Sources: the live quote (main's quote cache), the paper account (the demo
 * book while Ctrl+P is on), the book's prints for the weights
 * (useLivePrices, the Positions card's own), the Risk Engine's latest
 * snapshot, and `stock:context` over the filing graph. Nothing is drawn that
 * was not measured.
 */

const CATEGORY_KEY: Record<string, MessageKey> = {
  supplier: "earnings.category.supplier",
  customer: "earnings.category.customer",
  partner: "earnings.category.partner",
  competitor: "earnings.category.competitor",
  dependency: "earnings.category.dependency",
};

function usePaperBook(): PaperAccount {
  const [book, setBook] = useState<PaperAccount>(readPaperAccount);
  useEffect(() => {
    const read = () => setBook(readPaperAccount());
    const offPaper = subscribePaperAccount(read);
    const offDemo = subscribeDemoMode(read);
    return () => {
      offPaper();
      offDemo();
    };
  }, []);
  return book;
}

function heldSymbols(book: PaperAccount): string[] {
  return Object.values(book.positions ?? {})
    .filter((p) => p && typeof p.symbol === "string" && Number.isFinite(p.shares) && p.shares !== 0)
    .map((p) => p.symbol.toUpperCase())
    .sort();
}

/** Holdings one filing hop away, for a name the reader does not hold. */
function useNearbyHoldings(ticker: string, held: string[], enabled: boolean): StockContextLink[] {
  const [links, setLinks] = useState<StockContextLink[]>([]);
  const heldKey = held.join(",");
  useEffect(() => {
    const api = window.meridian;
    if (!enabled || !heldKey || !api?.getStockContext) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    api
      .getStockContext({ ticker, held: heldKey.split(",") })
      .then((res) => {
        if (!cancelled) setLinks(res.ok ? res.links : []);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, heldKey, enabled]);
  return links;
}

function Figure({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: "up" | "down" | null }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="select-none text-[11px] font-medium tracking-[0.02em] text-content-tertiary">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-[15px] font-medium tabular-nums",
          tone === "up" ? "text-tone-positive" : tone === "down" ? "text-tone-negative" : "text-content-primary",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export default function HeaderSection({ ticker }: StockSectionProps) {
  const { t, locale } = useI18n();
  const active = useTabActive();
  const { recent } = useStockTab();
  const entry = recent.find((r) => r.symbol === ticker);
  const live = useLiveQuote(ticker, { enabled: active });
  const overview = useStockOverview(ticker);
  const book = usePaperBook();
  const held = useMemo(() => heldSymbols(book), [book]);
  const prices = useLivePrices(active ? held.join(",") : "");
  const risk = useRiskSnapshot();
  const price = live.quote?.price ?? null;
  const context = heldContext(book, ticker, price, prices, risk.latest?.snapshot);
  const nearby = useNearbyHoldings(ticker, held, context == null);

  const name =
    (entry && entry.companyName !== entry.symbol ? entry.companyName : null) ||
    live.quote?.companyName?.trim() ||
    overview.data?.quote.companyName?.trim() ||
    ticker;
  const exchange = entry?.exchange || overview.data?.company.exchange || null;

  const usd = useMemo(
    () => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [locale],
  );
  const signedUsd = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        signDisplay: "exceptZero",
      }),
    [locale],
  );
  const shares = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }), [locale]);
  // Percents through Intl, so the sign sits where the language puts it ("23.3%", "%23,3"), at the shared rules' decimals.
  const pct = useMemo(() => {
    const make = (digits: number, signed = false) =>
      new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: signed ? "exceptZero" : "auto" });
    const one = make(1);
    const whole = make(0);
    const signed = make(1, true);
    return {
      weight: (fraction: number) => one.format(fraction),
      // As formatRiskShare: one decimal under 10%, whole points from there.
      share: (fraction: number) => (Math.abs(fraction) < 0.1 ? one : whole).format(fraction),
      signed: (points: number) => signed.format(points / 100),
    };
  }, [locale]);

  const linkTitle = (l: StockContextLink) => {
    const category = t(CATEGORY_KEY[l.category] ?? "earnings.category.related");
    return l.form
      ? t("earnings.link.namedIn", { filer: l.namedBy, form: l.form, named: l.named, category })
      : t("earnings.link.namedInFiling", { filer: l.namedBy, named: l.named, category });
  };

  return (
    <section aria-label={name} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2">
          <StockIcon symbol={ticker} size="md" className="h-7 w-7 object-contain" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-baskerville text-[26px] leading-tight text-content-primary" title={name}>
            {name}
          </h2>
          <p className="mt-1 flex items-center gap-2 text-[12.5px] text-content-secondary">
            <span lang="en" className="font-medium text-content-body">
              {ticker}
            </span>
            {exchange ? <span>{exchange}</span> : null}
          </p>
        </div>
        <StockLivePrice state={live} variant="inline" className="ml-auto" />
      </div>

      {context ? (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
          {context.weightValue != null ? <Figure label={t("stocktab.header.weight")} value={pct.weight(context.weightValue)} /> : null}
          <Figure label={t("stocktab.header.shares")} value={shares.format(context.shares)} />
          <Figure
            label={t("stocktab.header.cost")}
            value={usd.format(context.costUsd)}
            title={context.costPerShare != null ? usd.format(context.costPerShare) : undefined}
          />
          {context.pnlUsd != null ? (
            <Figure
              label={t("stocktab.header.pnl")}
              value={
                context.pnlPct != null
                  ? `${signedUsd.format(context.pnlUsd)}  ${pct.signed(context.pnlPct)}`
                  : signedUsd.format(context.pnlUsd)
              }
              tone={context.pnlUsd > 0 ? "up" : context.pnlUsd < 0 ? "down" : null}
            />
          ) : null}
          {context.riskShareValue != null ? <Figure label={t("stocktab.header.riskShare")} value={pct.share(context.riskShareValue)} /> : null}
        </dl>
      ) : nearby.length > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-content-secondary">
          <span>
            {t(new Intl.PluralRules(locale).select(nearby.length) === "one" ? "stocktab.header.nearby.one" : "stocktab.header.nearby.other", {
              count: nearby.length,
            })}
          </span>
          {nearby.map((l) => (
            <button
              key={l.ticker}
              type="button"
              lang="en"
              title={linkTitle(l)}
              aria-label={`${l.ticker}. ${linkTitle(l)}`}
              onClick={() => openStock(l.ticker)}
              className="font-medium text-content-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              {l.ticker}
            </button>
          ))}
        </p>
      ) : null}
    </section>
  );
}
