"use client";

import { useEffect, useRef, useState } from "react";
import type { LabMessage } from "./sessions";
import { toolCommand } from "./ToolRun";

/**
 * A polite status line for screen readers, following the latest reply:
 * "Thinking", "Running /quote AAPL", "Answer ready" (or "Stopped", "Reply
 * failed"). The streaming text itself is not announced word by word.
 */

function status(m: LabMessage | undefined): string {
  if (!m || m.role !== "assistant") return "";
  const tools = m.tools ?? [];
  if (m.status === "streaming") {
    const running = tools.filter((t) => t.state === "running");
    if (running.length) return `Running ${running.map((t) => toolCommand(t, tools)).join(", ")}`;
    const after = tools.length ? Math.max(...tools.map((t) => t.at)) : 0;
    return m.text.slice(after).trim() ? "" : "Thinking";
  }
  if (m.status === "error") return `Reply failed. ${m.error ?? ""}`.trim();
  if (m.status === "stopped") return "Stopped";
  return "Answer ready";
}

export function DeskAnnouncer({ last }: { last: LabMessage | undefined }) {
  const now = status(last);
  const [said, setSaid] = useState(() => (last?.status === "streaming" ? now : ""));
  const prev = useRef(now);
  useEffect(() => {
    if (now === prev.current) return;
    prev.current = now;
    if (now) setSaid(now);
  }, [now]);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {said}
    </div>
  );
}
