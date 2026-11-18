"use client";

import { askFalconAI } from "./app-bridge";
import { FalconMark } from "./FalconMark";

/**
 * "Ask Falcon AI": opens Falcon AI on a new session with `prompt` in the
 * composer (lab/app-bridge.ts). Small on purpose; it sits in a tab's header
 * or over the Graph.
 */
export function AskFalconButton({ prompt, label = "Ask Falcon AI", className = "" }: { prompt: string; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => askFalconAI(prompt)}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line/10 bg-surface px-2.5 text-fs-12.5 text-fore-3 outline-none transition-colors hover:bg-surface-hover hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20 ${className}`}
    >
      <FalconMark size={13} strokeWidth={1.8} />
      {label}
    </button>
  );
}
