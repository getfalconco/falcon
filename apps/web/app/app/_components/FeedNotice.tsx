"use client";

import { useWorkspace } from "./context";

/** One quiet line when the feed is missing or failed; nothing when it is fine. */
export function FeedNotice() {
  const { feedStatus, refreshFeed } = useWorkspace();
  if (feedStatus !== "unavailable" && feedStatus !== "error") return null;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-line/[0.08] bg-surface-2 px-4 py-2.5">
      <p className="text-fs-13 text-fore-4">
        {feedStatus === "unavailable" ? "Sightings are not available yet" : "Sightings could not load"}
      </p>
      <button
        type="button"
        onClick={refreshFeed}
        className="inline-flex h-7 items-center rounded-md px-2 text-fs-12 text-quiet outline-none transition-colors hover:bg-surface-hover hover:text-fore focus-visible:bg-surface-hover"
      >
        Retry
      </button>
    </div>
  );
}
