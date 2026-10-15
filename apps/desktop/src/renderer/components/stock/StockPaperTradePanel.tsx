import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useI18n, type MessageKey } from "@/lib/i18n";
import {
  executePaperTrade,
  paperTradeErrorText,
  paperBuyingPower,
  positionFor,
  positionSide,
  readPaperAccount,
  subscribePaperAccount,
  type PaperAccount,
  type PaperTradeSide,
} from "@/lib/paper-account";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatShares(shares: number): string {
  return shares.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

const LABEL: Record<PaperTradeSide, MessageKey> = {
  buy: "stock.paper.side.buy",
  sell: "stock.paper.side.sell",
  short: "stock.paper.side.short",
  cover: "stock.paper.side.cover",
};

/** The confirmation after a fill, one whole sentence per side. */
const DONE: Record<PaperTradeSide, MessageKey> = {
  buy: "stock.paper.done.buy",
  sell: "stock.paper.done.sell",
  short: "stock.paper.done.short",
  cover: "stock.paper.done.cover",
};

/**
 * Buy / sell for the Falcon paper account, shown on the stock screen. Orders
 * are entered in dollars and filled at the live price, so fractional shares
 * are expected.
 */
export default function StockPaperTradePanel({
  symbol,
  price,
  variant = "card",
  className,
}: {
  symbol: string;
  /** Live price; `null` while the first quote is still loading. */
  price: number | null;
  /** `card` for the pre-analysis screen, `bar` for the results header. */
  variant?: "card" | "bar";
  className?: string;
}) {
  const bar = variant === "bar";
  const { t, locale } = useI18n();
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);

  // A different ticker is a different order.
  useEffect(() => {
    setAmount("");
    setError(null);
    setConfirmation(null);
  }, [symbol]);

  const position = positionFor(account, symbol);
  const side = positionSide(position);
  const openShares = position ? Math.abs(position.shares) : 0;
  const positionValue = position && price != null ? openShares * price : 0;
  const buyingPower = Math.max(0, paperBuyingPower(account));
  const locked = account.cash - buyingPower;
  const buyingPowerTitle =
    locked > 0.005
      ? t("stock.paper.cashCollateralTitle", { cash: USD.format(account.cash), locked: USD.format(locked) })
      : t("stock.paper.cashTitle", { cash: USD.format(account.cash) });

  const amountUsd = Number(amount);
  const amountValid = Number.isFinite(amountUsd) && amountUsd > 0;
  const canTrade = amountValid && price != null && price > 0;
  const estimatedShares = canTrade ? amountUsd / price : 0;
  const estimateText = t(
    new Intl.PluralRules(locale).select(estimatedShares) === "one"
      ? "stock.paper.estimate.one"
      : "stock.paper.estimate.other",
    { shares: formatShares(estimatedShares) },
  );
  const amountLabel = t("stock.paper.amountLabel", { symbol });
  // The blue button always buys (opening a long, or covering a short); the red
  // one always sells (closing a long, or opening a short).
  const buySide: PaperTradeSide = side === "short" ? "cover" : "buy";
  const sellSide: PaperTradeSide = side === "long" ? "sell" : "short";

  function submit(tradeSide: PaperTradeSide) {
    if (price == null) {
      setError(t("stock.paper.waitingPrice"));
      return;
    }
    const result = executePaperTrade({ side: tradeSide, symbol, amountUsd, price });
    if (!result.ok) {
      setConfirmation(null);
      setError(paperTradeErrorText(result, t));
      return;
    }
    setError(null);
    setConfirmation(
      t(DONE[tradeSide], {
        shares: formatShares(result.shares),
        symbol,
        price: USD.format(price),
        total: USD.format(result.amountUsd),
      }),
    );
    setAmount("");
  }

  const amountField = (
    <label className={cn("block", bar && "min-w-0 flex-1")}>
      <span className="sr-only">{amountLabel}</span>
      <div
        className={cn(
          "flex items-center gap-1 rounded-md border-[0.5px] border-white/[0.12] bg-black/20 focus-within:border-white/[0.28]",
          bar ? "px-2.5 py-1.5" : "px-3 py-2",
        )}
      >
        <span className="text-fg-faint">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            // digits with at most one decimal point
            const next = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
            setAmount(next);
            setError(null);
            setConfirmation(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canTrade) submit(buySide);
          }}
          placeholder="0.00"
          aria-label={amountLabel}
          className={cn(
            "w-full bg-transparent tabular-nums text-foreground outline-none placeholder:text-fg-faint",
            bar ? "text-sm" : "text-lg",
          )}
        />
        <button
          type="button"
          // With a position open, "Max" means close it; otherwise spend it all.
          onClick={() =>
            setAmount(
              String(
                Math.floor((side === "flat" ? buyingPower : positionValue) * 100) / 100,
              ),
            )
          }
          disabled={(side === "flat" ? buyingPower : positionValue) <= 0}
          className="app-no-drag shrink-0 text-[11px] uppercase tracking-wide text-fg-faint transition-colors hover:text-foreground disabled:opacity-40"
        >
          {t("stock.paper.max")}
        </button>
      </div>
    </label>
  );

  const actions = (
    <>
      <button
        type="button"
        onClick={() => submit(buySide)}
        disabled={!canTrade}
        title={buySide === "cover" ? t("stock.paper.coverTitle", { symbol }) : undefined}
        className={cn(
          "app-no-drag rounded-md bg-blue-600 font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40",
          bar ? "whitespace-nowrap px-4 py-1.5 text-xs" : "px-2 py-2 text-sm leading-tight",
        )}
      >
        {t(LABEL[buySide])}
      </button>
      <button
        type="button"
        onClick={() => submit(sellSide)}
        disabled={!canTrade}
        title={sellSide === "short" ? t("stock.paper.shortTitle", { symbol }) : undefined}
        className={cn(
          "app-no-drag rounded-md bg-red-600 font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40",
          bar ? "whitespace-nowrap px-4 py-1.5 text-xs" : "px-2 py-2 text-sm leading-tight",
        )}
      >
        {t(LABEL[sellSide])}
      </button>
    </>
  );

  const status = error ? (
    <span className="text-loss">{error}</span>
  ) : confirmation ? (
    <span className="text-gain">{confirmation}</span>
  ) : position ? (
    <span className="tabular-nums text-fg-muted">
      {side === "short" ? (
        <span className="mr-1 rounded bg-red-500/15 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-300">
          {t("stock.paper.shortChip")}
        </span>
      ) : null}
      {price != null
        ? t(side === "short" ? "stock.paper.shortPositionValue" : "stock.paper.holdingValue", {
            shares: formatShares(openShares),
            symbol,
            value: USD.format(positionValue),
          })
        : t(side === "short" ? "stock.paper.shortPosition" : "stock.paper.holding", {
            shares: formatShares(openShares),
            symbol,
          })}
    </span>
  ) : (
    <span className="text-fg-faint">{t("stock.paper.noPosition", { symbol })}</span>
  );

  if (bar) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-[0.5px] border-white/[0.08] bg-white/[0.02] px-3 py-2",
          className,
        )}
      >
        <span className="text-[11px] uppercase tracking-[0.06em] text-fg-faint">{t("stock.paper.title")}</span>
        <span className="text-[11px] tabular-nums text-fg-muted" title={buyingPowerTitle}>
          {t("stock.paper.buyingPower", { amount: USD.format(buyingPower) })}
        </span>
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          {amountField}
          {actions}
        </div>
        <p className="min-w-0 flex-1 truncate text-right text-[11px] leading-tight">
          {canTrade ? (
            <span className="tabular-nums text-fg-faint">{estimateText} · </span>
          ) : null}
          {status}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-full max-w-xs rounded-lg border-[0.5px] border-white/[0.08] bg-white/[0.02] p-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]">
        <span className="uppercase tracking-[0.06em] text-fg-faint">{t("stock.paper.title")}</span>
        <span className="tabular-nums text-fg-muted" title={buyingPowerTitle}>
          {t("stock.paper.buyingPower", { amount: USD.format(buyingPower) })}
        </span>
      </div>

      <div className="mt-3">{amountField}</div>

      <p className="mt-1.5 h-4 text-[11px] tabular-nums text-fg-faint">
        {canTrade ? estimateText : ""}
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2">{actions}</div>

      <p className="mt-2.5 min-h-[16px] text-center text-[11px] leading-tight">{status}</p>
    </div>
  );
}
