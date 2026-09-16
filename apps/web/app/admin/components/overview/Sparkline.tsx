import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { SparkPoint } from "@/lib/admin-overview";
import { CARD, MICRO_LABEL, formatNumber } from "./helpers";

export default function Sparkline({ points }: { points: SparkPoint[] }) {
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const max = Math.max(1, ...points.map((p) => p.count));

  return (
    <section className={`${CARD} flex flex-col p-4`}>
      <div className="flex items-center justify-between">
        <span className={MICRO_LABEL}>Signups</span>
        <span className="text-[11px] text-[#9a9a9a]">last 14 days</span>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[22px] font-medium leading-none tabular-nums text-[#1d1b1b]">
          {formatNumber(total)}
        </span>
        <span className="text-[12px] text-[#9a9a9a]">total</span>
      </div>

      <div className="mt-4 flex h-16 items-end gap-[3px]">
        {points.map((p) => (
          <div
            key={p.date}
            title={`${p.date}: ${p.count}`}
            className="flex-1 rounded-sm bg-[#1c1917]/15"
            style={{ height: `${Math.max(3, (p.count / max) * 100)}%` }}
          />
        ))}
      </div>

      <Link
        href="/admin/dashboard/waitlist"
        className="mt-4 inline-flex items-center gap-1 self-start text-[12px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
      >
        View waitlist
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
      </Link>
    </section>
  );
}
