"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ADMIN_TAB_LIST } from "../../admin-theme";

const RANGES = ["24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

export default function TimeRangeSelect() {
  const [range, setRange] = useState<Range>("7d");

  return (
    <div className={ADMIN_TAB_LIST}>
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => setRange(r)}
          className={cn(
            "rounded-lg px-2.5 py-1 text-[12px] tabular-nums transition-colors",
            range === r
              ? "bg-[#1c1917] text-white"
              : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
