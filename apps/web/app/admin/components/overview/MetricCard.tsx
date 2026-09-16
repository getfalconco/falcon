import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MetricChange } from "@/lib/admin-overview";
import { CARD, MICRO_LABEL } from "./helpers";

type Props = {
  label: string;
  value?: string;
  change?: MetricChange;
  subtitle?: string;
  href?: string;
  notTracked?: boolean;
};

const CHANGE_TONE: Record<NonNullable<MetricChange>["direction"], string> = {
  up: "text-emerald-700",
  down: "text-red-700",
  neutral: "text-[#9a9a9a]",
};

export default function MetricCard({
  label,
  value,
  change,
  subtitle,
  href,
  notTracked = false,
}: Props) {
  const body = (
    <div className={cn(CARD, "group relative flex h-full flex-col p-4", href && "hover:border-black/20")}>
      <div className="flex items-center justify-between">
        <span className={MICRO_LABEL}>{label}</span>
        {href ? (
          <ArrowUpRight
            className="h-3.5 w-3.5 text-[#c4c4c0] transition-colors group-hover:text-[#6b7280]"
            strokeWidth={1.75}
          />
        ) : null}
      </div>

      {notTracked ? (
        <>
          <span className="mt-3 text-[26px] font-medium leading-none tabular-nums text-[#c4c4c0]">—</span>
          <span className="mt-2 text-[11px] text-[#9a9a9a]">not tracked yet</span>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-[26px] font-medium leading-none tabular-nums text-[#1d1b1b]">
              {value}
            </span>
            {change ? (
              <span className={cn("text-[12px] tabular-nums", CHANGE_TONE[change.direction])}>
                {change.label}
              </span>
            ) : null}
          </div>
          <span className="mt-2 text-[12px] text-[#9a9a9a]">{subtitle ?? " "}</span>
        </>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block h-full">
        {body}
      </Link>
    );
  }
  return body;
}
