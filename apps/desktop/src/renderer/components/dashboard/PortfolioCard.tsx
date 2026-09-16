import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import AddAssetModal from "@/components/dashboard/AddAssetModal";
import DashboardCta from "@/components/dashboard/DashboardCta";
import type { BrokerageAccount } from "../../../shared/snaptrade";
import logoBlack from "@/assets/brand/logo-black.png";
import StockIcon from "@/components/stock/StockIcon";
import {
  createPaperAccount,
  readPaperAccount,
  subscribePaperAccount,
  type PaperAccount,
} from "@/lib/paper-account";
import { clearCloudSnapshots } from "@/lib/portfolio-sync";
import { useLivePrices } from "@/hooks/useLivePrices";
import { cn } from "@/lib/utils";

/**
 * Portfolio card in the Growth Forecast card's exact frame: every open
 * position with live-priced PnL in dollars and percent, plus the total
 * PnL and overall income % up top. Colored text only — no badges.
 */

function pnlTone(v: number): string {
  if (v > 0) return "text-[#16A34A]";
  if (v < 0) return "text-[#DC2626]";
  return "text-[#6b7280]";
}

function fmtUsd(v: number, sign = false): string {
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : sign && v > 0 ? "+" : ""}$${s}`;
}

/**
 * Line under the PnL, tiered by move size so coaching only appears when it
 * means something. Below ±1% it's plain fact (daily noise deserves no
 * drama); ±1–5% acknowledges the move; past ±5% the coaching voice is
 * earned. Rotates daily within a tier; returned in parts so the dollar
 * amount can render colored.
 */
function pnlMessageParts(
  pnl: number,
  pct: number,
): { before: string; amount: string | null; after: string } {
  const amt = fmtUsd(Math.abs(pnl));
  const day = Math.floor(Date.now() / 86_400_000);
  if (Math.abs(pnl) < 0.005) {
    const flat = [
      "Flat for now — watching the tape.",
      "No meaningful move yet.",
    ];
    return { before: flat[day % flat.length], amount: null, after: "" };
  }

  const mag = Math.abs(pct);
  let variants: Array<[string, string]>;
  if (pnl > 0) {
    if (mag < 1) {
      variants = [
        ["Up ", " — ordinary drift, nothing more."],
        ["", " ahead today. A quiet green day."],
      ];
    } else if (mag < 5) {
      variants = [
        ["Up ", " — the book is moving your way."],
        ["", " in the green today. Good tape."],
      ];
    } else {
      variants = [
        ["Sitting on ", " of gains — a real run. Protect it."],
        ["Up ", " — the thesis is paying off in size."],
      ];
    }
  } else {
    if (mag < 1) {
      variants = [
        ["Down ", " — within normal daily noise."],
        ["", " off today. Nothing that needs a decision."],
      ];
    } else if (mag < 5) {
      variants = [
        ["Down ", " today — softer, still inside the plan."],
        ["", " off — worth watching, not reacting."],
      ];
    } else {
      variants = [
        ["Down ", " — big enough to matter. Re-check the thesis, not the ticker."],
        ["", " drawdown — review sizing and the original case."],
      ];
    }
  }
  const [before, after] = variants[day % variants.length];
  return { before, amount: amt, after };
}

/** Privacy mask: always five stars, no digits, no separators. */
const MASKED_MONEY = "$*****";

export default function PortfolioCard({
  masked = false,
  onToggleMasked,
}: {
  masked?: boolean;
  onToggleMasked?: () => void;
}) {
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  const [brokerAccounts, setBrokerAccounts] = useState<BrokerageAccount[]>([]);
  const [brokeragesOpen, setBrokeragesOpen] = useState(true);
  const [falconOpen, setFalconOpen] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);

  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);

  // Connected real brokerages (SnapTrade) appear as sibling nodes.
  useEffect(() => {
    let cancelled = false;
    void window.meridian
      ?.getBrokerageNetWorth?.()
      .then((res) => {
        if (!cancelled && res?.ok && res.networth.connected) {
          setBrokerAccounts(res.networth.accounts);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Shared price source — the same quotes the headline and the chart use, so
  // this card can't report a loss the net-worth number doesn't show.
  const prices = useLivePrices(Object.keys(account.positions).sort().join(","));

  const rows = useMemo(() => {
    return Object.values(account.positions)
      .filter((p) => {
        // Float residue from an old "sell everything" — worth nothing, listed
        // as nothing.
        const price = prices[p.symbol];
        const value = price != null ? p.shares * price : p.costUsd;
        return Math.abs(value) >= 0.01;
      })
      .map((p) => {
      const price = prices[p.symbol];
      const value = price != null ? p.shares * price : p.costUsd;
      const pnl = value - p.costUsd;
      return {
        symbol: p.symbol,
        side: p.shares > 0 ? "long" : "short",
        shares: Math.abs(p.shares),
        price,
        /** Live market value of the holding — cost basis until a quote lands. */
        value,
        pnl,
        pnlPct: Math.abs(p.costUsd) > 1e-9 ? (pnl / Math.abs(p.costUsd)) * 100 : 0,
      };
    });
  }, [account, prices]);

  // Money hides behind a fixed five-star mask; percentages stay visible.
  const money = (s: string) => (masked ? MASKED_MONEY : s);

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  // Falcon node value: cash + live-priced positions.
  const paperValue =
    account.cash +
    Object.values(account.positions).reduce((s, p) => {
      const price = prices[p.symbol];
      return s + (price != null ? p.shares * price : p.costUsd);
    }, 0);
  const totalBasis = Object.values(account.positions).reduce(
    (s, p) => s + Math.abs(p.costUsd),
    0,
  );
  const pnlPct = totalBasis > 1e-9 ? (totalPnl / totalBasis) * 100 : 0;
  // Everything the card lists: the Falcon account plus any connected broker.
  const assetsValue =
    paperValue +
    brokerAccounts.reduce((s, a) => s + (Number.isFinite(a.totalValue ?? NaN) ? (a.totalValue as number) : 0), 0);

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
          ASSETS
        </span>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onToggleMasked}
            aria-label={masked ? "Show values" : "Hide values"}
            aria-pressed={masked}
            className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
          >
            {masked ? (
              <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            ) : (
              <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label="Portfolio settings"
            className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
          >
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>

      {/* What the book is worth, with the move on it alongside. */}
      <div className="mt-5">
        <div className="flex items-end gap-1.5">
          <span className="text-[30px] font-medium leading-none tabular-nums text-[#1d1b1b]">
            {money(fmtUsd(assetsValue))}
          </span>
          <span
            className={cn(
              "mb-0.5 flex items-center gap-0.5 text-[12.5px] font-medium tabular-nums",
              pnlTone(pnlPct),
            )}
          >
            <span>{money(fmtUsd(totalPnl, true))}</span>
            {pnlPct >= 0 ? (
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            )}
            {pnlPct >= 0 ? "+" : ""}
            {pnlPct.toFixed(2)}%
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-[#9CA3AF]">
          {(() => {
            const msg = pnlMessageParts(totalPnl, pnlPct);
            return (
              <>
                {msg.before}
                {msg.amount ? (
                  <span className={cn("font-medium tabular-nums", pnlTone(totalPnl))}>
                    {money(msg.amount)}
                  </span>
                ) : null}
                {msg.after}
              </>
            );
          })()}
        </p>
      </div>

      {/* Hierarchy: Brokerages → connected accounts → their holdings */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setBrokeragesOpen((v) => !v)}
          aria-expanded={brokeragesOpen}
          className="app-no-drag flex items-center gap-1 text-[11.5px] font-medium text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", brokeragesOpen && "rotate-90")}
            strokeWidth={2}
            aria-hidden
          />
          Brokerages
        </button>

        {brokeragesOpen ? (
          <>
        {/* Falcon (paper account) node */}
        <button
          type="button"
          onClick={() => setFalconOpen((v) => !v)}
          aria-expanded={falconOpen}
          className="app-no-drag mt-1 flex w-full items-center gap-2 py-1 text-left"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-[#9CA3AF] transition-transform",
              falconOpen && "rotate-90",
            )}
            strokeWidth={2}
            aria-hidden
          />
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white">
            <img src={logoBlack} alt="" className="h-2.5 w-2.5 opacity-[0.89]" aria-hidden />
          </span>
          <span className="text-[13px] font-semibold text-[#1d1b1b]">Falcon</span>
          <span className="ml-auto text-[12px] tabular-nums text-[#6b7280]">
            {money(fmtUsd(paperValue))}
          </span>
        </button>

        {/* Holdings, indented under Falcon with a tree guide line */}
        {falconOpen ? (
        <div className="ml-[21px] border-l-[0.5px] border-black/[0.1] pl-3.5">
          {rows.length === 0 ? (
            <p className="py-1.5 text-[12.5px] text-[#9CA3AF]">No open positions.</p>
          ) : (
            <>
              {rows.map((row) => (
                <div key={row.symbol} className="flex items-center gap-2.5 py-1.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#E3E3E0]">
                    <StockIcon symbol={row.symbol} size="sm" className="h-3.5 w-3.5 object-contain" />
                  </span>
                  <span className="text-[13px] font-semibold text-[#1d1b1b]">{row.symbol}</span>
                  {/* A short reads the opposite way round from everything else
                      in this list — the dot says so before the numbers do. */}
                  {row.side === "short" && (
                    <span
                      role="img"
                      className="h-[5px] w-[5px] shrink-0 rounded-full bg-[#DC2626]"
                      title={`${row.symbol} — short position`}
                      aria-label={`${row.symbol} short position`}
                    />
                  )}
                  <span className="ml-auto flex items-center gap-3">
                    <span
                      className="text-[12.5px] tabular-nums text-[#374151]"
                      title={
                        row.price != null
                          ? `${row.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })} @ ${fmtUsd(row.price)}`
                          : undefined
                      }
                    >
                      {money(fmtUsd(row.value))}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-0.5 text-[12.5px] font-semibold tabular-nums",
                        pnlTone(row.pnlPct),
                      )}
                    >
                      {row.pnlPct >= 0 ? "↑" : "↓"} {Math.abs(row.pnlPct).toFixed(2)}%
                    </span>
                  </span>
                </div>
              ))}
              <div className="flex justify-end pt-2">
                <DashboardCta className="flex items-center gap-0.5 text-[12px] text-[#9CA3AF] transition-colors hover:text-[#1d1b1b]">
                  See all
                  <ChevronRight className="h-3 w-3" strokeWidth={2} aria-hidden />
                </DashboardCta>
              </div>
            </>
          )}
        </div>
        ) : null}

        {/* Connected real brokerages (no per-holding data from SnapTrade yet) */}
        {brokerAccounts.map((acct) => (
          <div key={acct.id} className="flex items-center gap-2 py-1 pl-5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[9px] font-semibold text-[#6b7280]">
              {acct.institution.slice(0, 1).toUpperCase()}
            </span>
            <span className="text-[13px] font-semibold text-[#1d1b1b]">{acct.institution}</span>
            <span className="text-[10.5px] text-[#9CA3AF]">{acct.name}</span>
            <span className="ml-auto text-[12px] tabular-nums text-[#6b7280]">
              {acct.totalValue != null ? money(fmtUsd(acct.totalValue)) : "—"}
            </span>
          </div>
        ))}
          </>
        ) : null}
      </div>

      {/* Connect an asset — pinned to the card's bottom edge, with breathing
          room above so it never crowds the list */}
      <div className="mt-auto pt-6">
        <button
          type="button"
          onClick={() => setConnectOpen(true)}
          className="glass-cta app-no-drag flex w-full items-center justify-center gap-1.5 py-2 text-[12.5px] font-medium"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Connect an asset
        </button>
      </div>

      {connectOpen ? (
        <AddAssetModal
          onClose={() => setConnectOpen(false)}
          onCreatePaperAccount={(balance) => {
            // Fresh account, fresh chart: lib wipes local series keys; the
            // cloud series is cleared too so old movement can't leak back.
            setAccount(createPaperAccount(balance));
            void clearCloudSnapshots();
          }}
        />
      ) : null}
    </div>
  );
}
