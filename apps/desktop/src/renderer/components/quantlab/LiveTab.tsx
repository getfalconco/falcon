import { na } from "@/lib/i18n/na";
import { useI18n } from "@/lib/i18n";
import type { LiveSignal, StrategyRow } from "../../../shared/quantlab-types";
import { plural } from "../base/plural";
import { pct } from "./quantlab-format";

/**
 * Live (§8) — enabled strategies, today's signals, and the accumulating
 * ledger with its forward returns filled in.
 *
 * This is the only performance evidence in the system that cannot be overfit,
 * because its contents were committed to before the outcome existed. It
 * records what the rule said and what happened; there are no orders, no
 * position sizes and no execution anywhere in this view.
 */
export default function LiveTab({
  strategies,
  ledger,
  onToggleLive,
  onSweep,
  busy,
}: {
  strategies: StrategyRow[];
  ledger: LiveSignal[];
  onToggleLive: (row: StrategyRow) => void;
  onSweep: () => void;
  busy: string | null;
}) {
  const { t, locale } = useI18n();
  const enabled = strategies.filter((s) => s.strategy.live_enabled);
  // Replayed rows are shown but never counted as evidence: the ledger's value
  // is that its contents were committed to before the outcome existed.
  const forward = ledger.filter((s) => !s.backfilled);
  const replayed = ledger.length - forward.length;
  const complete = forward.filter((s) => s.complete).length;

  return (
    <>
      <div className="w-[380px] shrink-0 overflow-y-auto border-r border-[#e0e0da]">
        <div className="border-b border-[#e0e0da] px-5 py-3">
          <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">{t("instruments.quantlab.liveEvaluation")}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-[#6b7280]">{t("instruments.quantlab.liveIntro")}</p>
        </div>
        {strategies.map((row) => (
          <div key={row.strategy.strategy_id} className="border-b border-[#e8e8e2] px-5 py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <div className="text-[13px] text-[#1d1b1b]">{row.strategy.name}</div>
                <div className="mt-0.5 text-[10px] text-[#9CA3AF] tabular-nums">
                  v{row.strategy.version} ·{" "}
                  {t("instruments.quantlab.ledgerRows", {
                    n: ledger.filter((s) => s.strategy_id === row.strategy.strategy_id).length,
                  })}
                </div>
              </div>
              <button
                onClick={() => onToggleLive(row)}
                disabled={!row.strategy.live_enabled && row.enable_blocked_reason != null}
                className={`ml-auto shrink-0 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                  row.strategy.live_enabled
                    ? "bg-[#189E9A] text-white"
                    : row.enable_blocked_reason
                      ? "cursor-not-allowed bg-[#eeeee8] text-[#c0c0ba]"
                      : "bg-[#1d1b1b] text-white"
                }`}
              >
                {row.strategy.live_enabled ? t("instruments.quantlab.enabled") : t("instruments.quantlab.enable")}
              </button>
            </div>
            {!row.strategy.live_enabled && row.enable_blocked_reason && (
              <p className="mt-1.5 text-[11px] text-[#b23b3b]">{row.enable_blocked_reason}</p>
            )}
          </div>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-[#e0e0da] px-6 py-3">
          <span className="text-[11px] text-[#6b7280] tabular-nums">
            {t("instruments.quantlab.enabledCount", { n: enabled.length })} ·{" "}
            {t(plural(locale, forward.length, "instruments.quantlab.forward.one", "instruments.quantlab.forward.other"), {
              n: forward.length,
            })}{" "}
            · {t("instruments.quantlab.resolved", { n: complete })}
            {replayed > 0 && (
              <span className="text-[#9CA3AF]"> · {t("instruments.quantlab.replayed", { n: replayed })}</span>
            )}
          </span>
          <button
            onClick={onSweep}
            disabled={busy === "sweep"}
            className="ml-auto rounded-md bg-[#1d1b1b] px-3 py-1.5 text-[12px] text-white disabled:bg-[#c8c8c2]"
          >
            {busy === "sweep" ? t("instruments.quantlab.sweeping") : t("instruments.quantlab.sweep")}
          </button>
        </div>

        {ledger.length === 0 ? (
          <div className="px-6 py-5 text-[12px] text-[#9CA3AF]">
            {t("instruments.quantlab.emptyLedger")}
          </div>
        ) : (
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#F4F4F0] text-[#9CA3AF]">
              <tr className="whitespace-nowrap border-b border-[#e0e0da]">
                <th className="px-3 py-2 text-left font-normal">{t("instruments.quantlab.col.session")}</th>
                <th className="px-2 py-2 text-left font-normal">{t("instruments.quantlab.col.ticker")}</th>
                <th className="px-2 py-2 text-right font-normal">{t("instruments.quantlab.col.side")}</th>
                <th className="px-2 py-2 text-right font-normal">{t("instruments.quantlab.col.entry")}</th>
                {[1, 3, 5, 10].map((h) => (
                  <th key={h} className="px-2 py-2 text-right font-normal">
                    {t("instruments.quantlab.days", { n: h })}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-normal">{t("instruments.quantlab.col.rule")}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((signal) => (
                <tr key={signal.id} className="border-b border-[#eeeee8] text-[#4b5563]">
                  <td className="whitespace-nowrap px-3 py-1.5 text-left">
                    {signal.session}
                    {signal.backfilled && (
                      <span
                        className="ml-1.5 whitespace-nowrap rounded bg-[#e8e8e2] px-1 py-0.5 text-[9px] tracking-wide text-[#9CA3AF]"
                        title={t("instruments.quantlab.replayHint")}
                      >
                        {t("instruments.quantlab.replayBadge")}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-left text-[#1d1b1b]">{signal.ticker}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">{signal.sign > 0 ? t("instruments.quantlab.sideUp") : t("instruments.quantlab.sideDown")}</td>
                  <td className="px-2 py-1.5 text-right">{signal.entry_price.toFixed(2)}</td>
                  {[1, 3, 5, 10].map((h) => {
                    const ret = signal.returns.find((r) => r.sessions === h);
                    if (!ret) return <td key={h} className="whitespace-nowrap px-2 py-1.5 text-right text-[#e0e0da]">{na()}</td>;
                    const value = ret.sector_relative ?? ret.market_adjusted ?? ret.raw;
                    return (
                      <td
                        key={h}
                        className={`whitespace-nowrap px-2 py-1.5 text-right ${
                          value == null ? "text-[#c0c0ba]" : value >= 0 ? "text-[#1d7a55]" : "text-[#b23b3b]"
                        }`}
                        title={
                          value == null
                            ? t("instruments.quantlab.pendingHint")
                            : t("instruments.quantlab.returnsHint", {
                                raw: pct(ret.raw),
                                market: pct(ret.market_adjusted),
                                sector: pct(ret.sector_relative),
                              })
                        }
                      >
                        {value == null ? "·" : pct(value)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-left text-[#9CA3AF]">{signal.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
