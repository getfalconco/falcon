import { LineChart } from "lucide-react";
import {
  formatPct,
  formatUsd,
  getCompetitionDashboard,
  toneForPnl,
  type CompetitionSnapshot,
} from "@/lib/admin-competition";
import LiveRefresh from "./LiveRefresh";
import { CARD, MICRO_LABEL, formatRelativeTime } from "../../components/overview/helpers";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL } from "../../admin-theme";

export const dynamic = "force-dynamic";

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className={`${CARD} px-4 py-3`}>
      <p className={MICRO_LABEL}>{label}</p>
      <p className={`mt-1.5 text-[22px] font-medium leading-none tabular-nums ${tone ?? "text-[#1d1b1b]"}`}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-[11px] text-[#9a9a9a]">{hint}</p> : null}
    </div>
  );
}

function Side({ direction }: { direction: string }) {
  if (direction === "positive") return <span className="text-emerald-700">long</span>;
  if (direction === "negative") return <span className="text-red-700">short</span>;
  return <span className="text-[#9a9a9a]">—</span>;
}

function EquityChart({ snapshots }: { snapshots: CompetitionSnapshot[] }) {
  if (snapshots.length < 2) {
    return (
      <p className="px-4 py-8 text-center text-[12px] text-[#9a9a9a]">
        Equity curve appears after the first two worker ticks.
      </p>
    );
  }
  const w = 720;
  const h = 180;
  const pad = 8;
  const navs = snapshots.map((s) => s.nav);
  const spies = snapshots.map((s) => s.spyNav).filter((v): v is number => v != null);
  const lo = Math.min(...navs, ...(spies.length ? spies : navs)) * 0.998;
  const hi = Math.max(...navs, ...(spies.length ? spies : navs)) * 1.002;
  const span = Math.max(1e-6, hi - lo);
  const x = (i: number) => pad + (i / (snapshots.length - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (h - pad * 2);
  const navLine = snapshots.map((s, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(s.nav)}`).join(" ");
  const spyPts = snapshots
    .map((s, i) => (s.spyNav != null ? `${i === 0 || snapshots[i - 1]?.spyNav == null ? "M" : "L"}${x(i)} ${y(s.spyNav)}` : null))
    .filter(Boolean)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[180px] w-full">
      <path d={navLine} fill="none" stroke="white" strokeWidth="1.5" />
      {spyPts ? (
        <path d={spyPts} fill="none" stroke="rgb(52 211 153 / 0.7)" strokeWidth="1.25" strokeDasharray="4 3" />
      ) : null}
    </svg>
  );
}

export default async function CompetitionPage() {
  const data = await getCompetitionDashboard();
  const lastUpdated = new Date(data.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const p = data.policy;

  return (
    <div className={`${ADMIN_SHELL} max-w-[1280px] space-y-6`}>
      <LiveRefresh seconds={30} />

      <AdminPageHeader
        eyebrow="Engine"
        title="Live paper book"
        description={`60-day Falcon $10,000 test · same second-order signals as the product · no extra model · refreshes every 30s · ${lastUpdated}`}
        actions={
          data.run ? (
            <span className="rounded-md border border-black/15 px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] text-[#6b7280]">
              {data.run.status} · day {data.daysElapsed + 1}/{data.durationDays} · {data.daysLeft}d left
            </span>
          ) : null
        }
      />

      {data.missingTable ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          Competition tables are not on this project yet.
        </p>
      ) : data.degraded ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          Live ledger is unavailable right now.
        </p>
      ) : null}

      {!data.run ? (
        <p className="mt-6 text-[13px] text-[#6b7280]">No active paper run.</p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="NAV"
              value={formatUsd(data.latest?.nav ?? data.run.cash)}
              hint={`cash ${formatUsd(data.run.cash)} · peak ${formatUsd(data.run.peakNav)}`}
            />
            <Stat
              label="Falcon P&L"
              value={formatPct(data.falconReturnPct)}
              tone={toneForPnl(data.falconReturnPct)}
              hint={`vs $10,000 start · DD ${data.latest ? formatPct(-data.latest.drawdownPct) : "—"}`}
            />
            <Stat
              label="SPY (same $10k)"
              value={formatPct(data.spyReturnPct)}
              tone={toneForPnl(data.spyReturnPct)}
              hint={data.run.spyStart ? `SPY start ${data.run.spyStart.toFixed(2)}` : "seeded on first tick"}
            />
            <Stat
              label="Excess vs SPY"
              value={formatPct(data.vsSpyPct)}
              tone={toneForPnl(data.vsSpyPct)}
              hint="Falcon return minus SPY buy-and-hold"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Open" value={String(data.openCount)} />
            <Stat label="Closed" value={String(data.closedCount)} />
            <Stat label="Wins / losses" value={`${data.winCount} / ${data.lossCount}`} />
            <Stat label="Filled" value={String(data.filledCount)} />
            <Stat label="Skipped" value={String(data.skippedCount)} />
            <Stat label="Quote fails" value={String(data.fillFailedCount)} />
          </div>

          <section className={`${CARD} mt-3 p-4`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <LineChart className="h-3.5 w-3.5 text-[#9a9a9a]" strokeWidth={1.75} />
                <span className={MICRO_LABEL}>Equity vs SPY</span>
              </div>
              <span className="text-[11px] text-[#9a9a9a]">
                white = Falcon · dashed green = SPY · {data.snapshots.length} marks
              </span>
            </div>
            <div className="mt-3">
              <EquityChart snapshots={data.snapshots} />
            </div>
            <p className="mt-2 text-[11px] text-[#9a9a9a]">
              Last tick {data.run.lastTickAt ? formatRelativeTime(data.run.lastTickAt) : "—"}
              {data.run.lastTickSummary ? ` · ${data.run.lastTickSummary}` : ""}
            </p>
          </section>

          <section className={`${CARD} mt-3 p-4`}>
            <p className={MICRO_LABEL}>Frozen policy (paper-60d-v1)</p>
            <p className="mt-2 text-[12px] leading-relaxed text-[#1d1b1b]/65">
              Same open-signal bar as the apps: confidence ≥ {p.minConfidence}, window still open, not
              low magnitude, direction taken as shown (paper short if negative). 24h freshness.{" "}
              {p.positionFraction * 100}% of NAV per name, max {p.maxConcurrentPositions} names,{" "}
              {p.holdWeekdays} weekday hold, no leverage, fill at live last/extended quote. Benchmark{" "}
              {p.benchmark}. No extra model.
            </p>
            {data.run.notes ? (
              <p className="mt-2 text-[12px] text-[#9a9a9a]">{data.run.notes}</p>
            ) : null}
          </section>

          <section className={`${CARD} mt-3 overflow-hidden`}>
            <div className="border-b-[0.5px] border-black/[0.08] px-4 py-3">
              <h2 className="text-[13px] font-medium text-[#1d1b1b]">Open positions</h2>
            </div>
            {data.openPositions.length === 0 ? (
              <p className="px-4 py-6 text-[12px] text-[#9a9a9a]">No open paper positions yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-left text-[12px]">
                  <thead className="text-[11px] uppercase tracking-[0.05em] text-[#9a9a9a]">
                    <tr className="border-b-[0.5px] border-black/[0.06]">
                      <th className="px-4 py-2 font-medium">Ticker</th>
                      <th className="px-4 py-2 font-medium">Side</th>
                      <th className="px-4 py-2 font-medium">Conf</th>
                      <th className="px-4 py-2 font-medium">Shares</th>
                      <th className="px-4 py-2 font-medium">Entry</th>
                      <th className="px-4 py-2 font-medium">Notional</th>
                      <th className="px-4 py-2 font-medium">Exit due</th>
                      <th className="px-4 py-2 font-medium">Source</th>
                      <th className="px-4 py-2 font-medium">Thesis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.openPositions.map((pos) => (
                      <tr key={pos.id} className="border-b-[0.5px] border-black/[0.04] align-top">
                        <td className="px-4 py-2 font-medium text-[#1d1b1b]">{pos.ticker}</td>
                        <td className="px-4 py-2">
                          <Side direction={pos.direction} />
                        </td>
                        <td className="px-4 py-2 tabular-nums text-[#1d1b1b]/70">
                          {pos.pathConfidence.toFixed(2)}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-[#1d1b1b]/70">
                          {pos.shares.toFixed(4)}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-[#1d1b1b]/70">
                          {formatUsd(pos.entryPrice)}
                          <div className="text-[10px] text-[#9a9a9a]">{formatRelativeTime(pos.entryAt)}</div>
                        </td>
                        <td className="px-4 py-2 tabular-nums text-[#1d1b1b]/70">
                          {formatUsd(pos.notionalUsd)}
                        </td>
                        <td className="px-4 py-2 text-[#1d1b1b]/60">{formatRelativeTime(pos.plannedExitAt)}</td>
                        <td className="px-4 py-2 text-[#9a9a9a]">{pos.entrySource ?? "—"}</td>
                        <td className="max-w-[320px] px-4 py-2 text-[#1d1b1b]/55">
                          <div>{pos.headline}</div>
                          <div className="mt-1 line-clamp-3 text-[11px] text-[#9a9a9a]">
                            {pos.reasoning || pos.eventSummary}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={`${CARD} mt-3 overflow-hidden`}>
            <div className="border-b-[0.5px] border-black/[0.08] px-4 py-3">
              <h2 className="text-[13px] font-medium text-[#1d1b1b]">Closed trades</h2>
            </div>
            {data.closedPositions.length === 0 ? (
              <p className="px-4 py-6 text-[12px] text-[#9a9a9a]">No closed trades yet (5 weekday hold).</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-[12px]">
                  <thead className="text-[11px] uppercase tracking-[0.05em] text-[#9a9a9a]">
                    <tr className="border-b-[0.5px] border-black/[0.06]">
                      <th className="px-4 py-2 font-medium">Ticker</th>
                      <th className="px-4 py-2 font-medium">Side</th>
                      <th className="px-4 py-2 font-medium">Entry → exit</th>
                      <th className="px-4 py-2 font-medium">P&L</th>
                      <th className="px-4 py-2 font-medium">Return</th>
                      <th className="px-4 py-2 font-medium">Why exit</th>
                      <th className="px-4 py-2 font-medium">Thesis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.closedPositions.map((pos) => (
                      <tr key={pos.id} className="border-b-[0.5px] border-black/[0.04] align-top">
                        <td className="px-4 py-2 font-medium text-[#1d1b1b]">{pos.ticker}</td>
                        <td className="px-4 py-2">
                          <Side direction={pos.direction} />
                        </td>
                        <td className="px-4 py-2 tabular-nums text-[#1d1b1b]/70">
                          {formatUsd(pos.entryPrice)} → {formatUsd(pos.exitPrice)}
                          <div className="text-[10px] text-[#9a9a9a]">
                            {formatRelativeTime(pos.entryAt)}
                            {pos.exitAt ? ` → ${formatRelativeTime(pos.exitAt)}` : ""}
                          </div>
                        </td>
                        <td className={`px-4 py-2 tabular-nums ${toneForPnl(pos.pnlUsd)}`}>
                          {formatUsd(pos.pnlUsd)}
                        </td>
                        <td className={`px-4 py-2 tabular-nums ${toneForPnl(pos.returnPct)}`}>
                          {formatPct(pos.returnPct)}
                        </td>
                        <td className="px-4 py-2 text-[#6b7280]">{pos.exitReason ?? "—"}</td>
                        <td className="max-w-[280px] px-4 py-2 text-[#6b7280]">{pos.headline}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={`${CARD} mt-3 p-4`}>
            <p className={MICRO_LABEL}>Skip reasons</p>
            {data.skipBreakdown.length === 0 ? (
              <p className="mt-2 text-[12px] text-[#9a9a9a]">No skips recorded yet.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {data.skipBreakdown.map((row) => (
                  <li key={row.reason} className="flex justify-between gap-4 text-[12px]">
                    <span className="text-[#1d1b1b]/60">{row.label}</span>
                    <span className="tabular-nums text-[#4b4b48]">{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${CARD} mt-3 overflow-hidden`}>
            <div className="border-b-[0.5px] border-black/[0.08] px-4 py-3">
              <h2 className="text-[13px] font-medium text-[#1d1b1b]">Every signal decision</h2>
              <p className="mt-0.5 text-[11px] text-[#9a9a9a]">
                Each second-order signal id is judged once — take, skip, or quote fail — with the same
                fields the user card shows.
              </p>
            </div>
            {data.decisions.length === 0 ? (
              <p className="px-4 py-6 text-[12px] text-[#9a9a9a]">
                Waiting for the news-worker to ingest live signals.
              </p>
            ) : (
              <div className="divide-y divide-black/[0.05]">
                {data.decisions.map((d) => (
                  <article key={d.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[13px] text-[#1d1b1b]">
                        {d.ticker} · <Side direction={d.direction} /> ·{" "}
                        <span className="text-[#6b7280]">{d.verdict}</span>
                        {d.skipLabel ? (
                          <span className="text-amber-300/80"> — {d.skipLabel}</span>
                        ) : null}
                      </p>
                      <p className="text-[11px] text-[#9a9a9a]">
                        conf {d.pathConfidence.toFixed(2)} · {d.magnitude} · {d.pricedInStatus} ·{" "}
                        {formatRelativeTime(d.createdAt)}
                      </p>
                    </div>
                    <p className="mt-1 text-[12px] text-[#1d1b1b]/70">{d.headline}</p>
                    {d.reasoning ? (
                      <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-[#9a9a9a]">
                        {d.reasoning}
                      </p>
                    ) : null}
                    <p className="mt-1 font-mono text-[10px] text-[#1d1b1b]/25">
                      signal {d.signalId}
                      {d.expectedMovePct != null
                        ? ` · expected ${d.expectedMovePct.toFixed(1)}% / ${d.expectedDays ?? "—"}d`
                        : ""}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className={`${CARD} mt-3 overflow-hidden`}>
            <div className="border-b-[0.5px] border-black/[0.08] px-4 py-3">
              <h2 className="text-[13px] font-medium text-[#1d1b1b]">Stage log</h2>
              <p className="mt-0.5 text-[11px] text-[#9a9a9a]">
                tick → ingest → eval → intended → fill/skip → MTM snapshot → complete
              </p>
            </div>
            {data.events.length === 0 ? (
              <p className="px-4 py-6 text-[12px] text-[#9a9a9a]">No stage events yet.</p>
            ) : (
              <ol className="max-h-[640px] overflow-y-auto divide-y divide-black/[0.04]">
                {data.events.map((e) => (
                  <li key={e.id} className="px-4 py-2.5 text-[12px]">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-mono text-[11px] text-emerald-700/80">{e.stage}</span>
                      <span className="text-[11px] text-[#1d1b1b]/30">{formatRelativeTime(e.ts)}</span>
                    </div>
                    <p className="mt-0.5 text-[#1d1b1b]/70">{e.message}</p>
                    {e.ticker || e.signalId ? (
                      <p className="mt-0.5 font-mono text-[10px] text-[#1d1b1b]/30">
                        {e.ticker ?? ""} {e.signalId ?? ""}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}
