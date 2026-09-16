import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  executePaperTrade,
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

const LABEL: Record<PaperTradeSide, string> = {
  buy: "Buy",
  sell: "Sell",
  short: "Short",
  cover: "Cover",
};

const VERB: Record<PaperTradeSide, string> = {
  buy: "Bought",
  sell: "Sold",
  short: "Shorted",
  cover: "Covered",
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
      ? `${USD.format(account.cash)} cash · ${USD.format(locked)} held as short collateral`
      : `${USD.format(account.cash)} cash`;

  const amountUsd = Number(amount);
  const amountValid = Number.isFinite(amountUsd) && amountUsd > 0;
  const canTrade = amountValid && price != null && price > 0;
  const estimatedShares = canTrade ? amountUsd / price : 0;

  // The blue button always buys (opening a long, or covering a short); the red
  // one always sells (closing a long, or opening a short).
  const buySide: PaperTradeSide = side === "short" ? "cover" : "buy";
  const sellSide: PaperTradeSide = side === "long" ? "sell" : "short";

  function submit(tradeSide: PaperTradeSide) {
    if (price == null) {
      setError("Waiting for a live price…");
      return;
    }
    const result = executePaperTrade({ side: tradeSide, symbol, amountUsd, price });
    if (!result.ok) {
      setConfirmation(null);
      setError(result.error);
      return;
    }
    setError(null);
    setConfirmation(
      `${VERB[tradeSide]} ${formatShares(result.shares)} ${symbol} at ${USD.format(
        price,
      )} · ${USD.format(result.amountUsd)}`,
    );
    setAmount("");
  }

  const amountField = (
    <label className={cn("block", bar && "min-w-0 flex-1")}>
      <span className="sr-only">Amount to invest in {symbol}</span>
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
          aria-label={`Amount to invest in ${symbol}`}
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
          Max
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
        title={buySide === "cover" ? `Buy back your ${symbol} short` : undefined}
        className={cn(
          "app-no-drag rounded-md bg-blue-600 font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40",
          bar ? "px-4 py-1.5 text-xs" : "py-2 text-sm",
        )}
      >
        {LABEL[buySide]}
      </button>
      <button
        type="button"
        onClick={() => submit(sellSide)}
        disabled={!canTrade}
        title={sellSide === "short" ? `Sell ${symbol} short — profits when it falls` : undefined}
        className={cn(
          "app-no-drag rounded-md bg-red-600 font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40",
          bar ? "px-4 py-1.5 text-xs" : "py-2 text-sm",
        )}
      >
        {LABEL[sellSide]}
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
          short
        </span>
      ) : null}
      {side === "short" ? "Short" : "Holding"} {formatShares(openShares)} {symbol}
      {price != null ? ` · ${USD.format(positionValue)}` : ""}
    </span>
  ) : (
    <span className="text-fg-faint">No {symbol} position yet</span>
  );

  if (bar) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-[0.5px] border-white/[0.08] bg-white/[0.02] px-3 py-2",
          className,
        )}
      >
        <span className="text-[11px] uppercase tracking-[0.06em] text-fg-faint">Falcon paper</span>
        <span className="text-[11px] tabular-nums text-fg-muted" title={buyingPowerTitle}>
          {USD.format(buyingPower)} buying power
        </span>
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          {amountField}
          {actions}
        </div>
        <p className="min-w-0 flex-1 truncate text-right text-[11px] leading-tight">
          {canTrade ? (
            <span className="tabular-nums text-fg-faint">
              ≈ {formatShares(estimatedShares)} shares ·{" "}
            </span>
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
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="uppercase tracking-[0.06em] text-fg-faint">Falcon paper</span>
        <span className="tabular-nums text-fg-muted" title={buyingPowerTitle}>
          {USD.format(buyingPower)} buying power
        </span>
      </div>

      <div className="mt-3">{amountField}</div>

      <p className="mt-1.5 h-4 text-[11px] tabular-nums text-fg-faint">
        {canTrade ? `≈ ${formatShares(estimatedShares)} shares` : ""}
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2">{actions}</div>

      <p className="mt-2.5 min-h-[16px] text-center text-[11px] leading-tight">{status}</p>
    </div>
  );
}
