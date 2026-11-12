"use client";

import { RotateCw } from "lucide-react";
import { useWorkspace } from "./context";

/** One quiet line when the feed is missing or failed; nothing when it is fine. */
export function FeedNotice() {
  const { feedStatus, refreshFeed } = useWorkspace();
  if (feedStatus !== "unavailable" && feedStatus !== "error") return null;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-black/[0.08] bg-[#f6f6f3] px-4 py-2.5">
      <p className="text-[13px] text-[#4b4b48]">
        {feedStatus === "unavailable" ? "Sightings are not available yet" : "Sightings could not load"}
      </p>
      <button
        type="button"
        onClick={refreshFeed}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-[#767676] outline-none transition-colors hover:bg-[#efefec] hover:text-[#1d1b1b] focus-visible:bg-[#efefec]"
      >
        <RotateCw width={12} height={12} aria-hidden />
        Retry
      </button>
    </div>
  );
}
