import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { EngineHealth } from "@/lib/admin-overview";
import { CARD, formatNumber, formatRelativeTime } from "./helpers";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-black/[0.05] py-2.5 last:border-0">
      <span className="text-[12px] text-[#9a9a9a]">{label}</span>
      <span className="text-right text-[12px] tabular-nums text-[#1d1b1b]">{children}</span>
    </div>
  );
}

function NotTracked() {
  return (
    <span className="text-[11px] text-[#9a9a9a]">
      <span className="text-[#c4c4c0]">—</span> not tracked yet
    </span>
  );
}

export default function EngineHealthCard({ engine }: { engine: EngineHealth }) {
  return (
    <section className={`${CARD} flex flex-col p-4`}>
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-[#1d1b1b]">Engine health</h2>
        <Link
          href="/admin/dashboard/engine-health"
          className="inline-flex items-center gap-1 text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
        >
          Open
          <ArrowRight className="h-3 w-3" strokeWidth={1.75} />
        </Link>
      </div>

      <div className="mt-2">
        <Row label="Signals today">
          {engine.signalsToday === null ? <NotTracked /> : formatNumber(engine.signalsToday)}
        </Row>
        <Row label="Latest signal">
          {engine.latestSignal ? (
            formatRelativeTime(engine.latestSignal.generatedAt)
          ) : (
            <NotTracked />
          )}
        </Row>
        <Row label="Propagation run">
          {engine.propagationRun ? (
            <>
              {formatRelativeTime(engine.propagationRun.at)} · {engine.propagationRun.status}
            </>
          ) : (
            <NotTracked />
          )}
        </Row>
        <Row label="News poller">
          {engine.pollerStatus ? (
            <span className={engine.pollerStatus === "healthy" ? "text-emerald-700" : "text-red-700"}>
              {engine.pollerStatus}
            </span>
          ) : (
            <NotTracked />
          )}
        </Row>
        <Row label="Graph size">
          {engine.graphCounts ? (
            <>
              {formatNumber(engine.graphCounts.nodes)} nodes · {formatNumber(engine.graphCounts.edges)} edges
            </>
          ) : (
            <NotTracked />
          )}
        </Row>
      </div>
    </section>
  );
}
