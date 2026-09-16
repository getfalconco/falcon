import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { getOpportunitiesData, type Opportunity } from "@/lib/admin-signals";
import { CARD, MICRO_LABEL, formatNumber, formatRelativeTime } from "../../components/overview/helpers";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL } from "../../admin-theme";

export const dynamic = "force-dynamic";

function DirectionBadge({ direction }: { direction: Opportunity["direction"] }) {
  if (direction === "positive") {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} /> long
      </span>
    );
  }
  if (direction === "negative") {
    return (
      <span className="inline-flex items-center gap-1 text-red-700">
        <ArrowDownRight className="h-3.5 w-3.5" strokeWidth={2} /> short
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[#9a9a9a]">
      <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} /> unclear
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${CARD} px-4 py-3`}>
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1.5 text-[24px] font-medium leading-none tabular-nums text-[#1d1b1b]">{value}</p>
    </div>
  );
}

export default async function SignalsTabPage() {
  const data = await getOpportunitiesData({ days: 14 });

  const lastUpdated = new Date(data.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Engine"
        title="Signals"
        description={`Second-order opportunities · last 14 days · updated ${lastUpdated}`}
      />

      {data.missingTable ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          The <code className="rounded bg-black/[0.04] px-1">second_order_signals</code> table does
          not exist yet. Run{" "}
          <code className="rounded bg-black/[0.04] px-1">apps/desktop/supabase/second_order_signals.sql</code>{" "}
          in the Supabase SQL editor to start syncing opportunities.
        </p>
      ) : data.degraded ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          Live data is unavailable right now — showing placeholders.
        </p>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total" value={formatNumber(data.total)} />
        <StatCard label="Window open" value={formatNumber(data.windowOpen)} />
        <StatCard label="Last 24h" value={formatNumber(data.last24h)} />
        <StatCard label="Long / short" value={`${data.positive} / ${data.negative}`} />
      </div>

      <div className={`${CARD} mt-3 overflow-hidden`}>
        <div className="flex items-center justify-between border-b-[0.5px] border-black/[0.08] px-4 py-3">
          <h2 className="text-[13px] font-medium text-[#1d1b1b]">Opportunities</h2>
          <span className="text-[11px] text-[#9a9a9a]">{data.signals.length} shown</span>
        </div>

        {data.signals.length === 0 ? (
          <div className="flex items-center justify-center px-4 py-16 text-[12px] text-[#9a9a9a]">
            {data.missingTable
              ? "No table to read from yet."
              : "No opportunities synced yet. They appear here after the desktop engine runs propagation."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left">
              <thead>
                <tr className="border-b-[0.5px] border-black/[0.06] text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">
                  <th className="px-4 py-2.5 font-medium">Ticker</th>
                  <th className="px-4 py-2.5 font-medium">Side</th>
                  <th className="px-4 py-2.5 font-medium">Mechanism</th>
                  <th className="px-4 py-2.5 font-medium">Mag</th>
                  <th className="px-4 py-2.5 font-medium">Conf</th>
                  <th className="px-4 py-2.5 font-medium">Est. move → target</th>
                  <th className="px-4 py-2.5 font-medium">Horizon</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Priced in</th>
                  <th className="px-4 py-2.5 font-medium">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.05]">
                {data.signals.map((s) => (
                  <tr key={s.id} className="align-top text-[13px] text-[#1d1b1b]">
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="font-medium text-[#1d1b1b]">{s.terminalTicker}</span>
                      <span className="ml-1.5 text-[11px] text-[#9a9a9a]">via {s.rootTicker}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <DirectionBadge direction={s.direction} />
                    </td>
                    <td className="max-w-[340px] px-4 py-3">
                      <p className="truncate text-[#4b4b48]" title={s.mechanism}>
                        {s.mechanism || s.eventType}
                      </p>
                      <p className="truncate text-[11px] text-[#9a9a9a]" title={s.reasoning || s.eventSummary}>
                        {s.reasoning || s.eventSummary}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[#1d1b1b]/60">{s.magnitude}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#1d1b1b]/60">
                      {Math.round(s.pathConfidence * 100)}%
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#1d1b1b]/70">
                      {s.expectedMovePct != null ? (
                        <>
                          <span
                            className={
                              s.direction === "negative" ? "text-red-700/90" : "text-emerald-700/90"
                            }
                          >
                            {s.direction === "negative" ? "−" : "+"}
                            {s.expectedMovePct}%
                          </span>
                          {s.targetPrice != null ? (
                            <span className="text-[#9a9a9a]">
                              {" "}
                              → ${s.targetPrice.toFixed(2)}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[#1d1b1b]/25">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#1d1b1b]/60">
                      {s.expectedDays != null ? `~${s.expectedDays}d` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className={
                          s.windowOpen
                            ? "rounded px-1.5 py-0.5 text-[11px] text-emerald-700/90 bg-emerald-400/10"
                            : "rounded px-1.5 py-0.5 text-[11px] text-amber-700/90 bg-amber-400/10"
                        }
                      >
                        {s.pricedInLabel}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#1d1b1b]/60">
                      {s.pricedInPct != null ? `${s.pricedInPct}%` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#9a9a9a]">
                      {formatRelativeTime(s.generatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
