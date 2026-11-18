"use client";

import { useEffect, useState } from "react";

/**
 * Local development only: clears this browser's copy of the portfolio ticker list and the
 * setup card's holdings/demo flags, so a reset done in the database shows up. Production
 * renders nothing and touches nothing.
 */
const PREFIXES = ["falcon.focus.v1:", "falcon.setup.holdings-added.v1:", "falcon.demo-focus.v1:"];

export default function ResetLocalPage() {
  const dev = process.env.NODE_ENV !== "production";
  const [removed, setRemoved] = useState<string[] | null>(null);

  useEffect(() => {
    if (!dev) return;
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {
      // Storage blocked: nothing to clear.
    }
    setRemoved(keys);
  }, [dev]);

  if (!dev) return null;
  return (
    <main className="mx-auto max-w-[520px] px-6 py-16 text-fore">
      <h1 className="text-fs-22 font-semibold">Local portfolio copy cleared</h1>
      <p className="mt-2 text-fs-14 text-quiet">
        {removed === null ? "Clearing…" : removed.length ? `Removed ${removed.length} saved item${removed.length === 1 ? "" : "s"} from this browser.` : "Nothing was saved in this browser."}
      </p>
      <a href="/app" className="mt-6 inline-flex h-9 items-center rounded-lg bg-solid px-4 text-fs-13 text-solid-ink hover:bg-solid-hover">
        Back to Falcon
      </a>
    </main>
  );
}
