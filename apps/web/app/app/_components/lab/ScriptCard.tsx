"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { lineCount, scriptFileName } from "@/lib/desk/code-cards";
import { highlightPython } from "./highlight";
import { EASE_OUT, useCalmMotion } from "./motion";
import type { RunScript } from "./run";

/**
 * Code Falcon AI wrote, inline in the reply where it was written:
 *   Created pnl_by_regime.py +21 ⌄     (a file it created; the diff block lists its lines with +)
 *   Edited pnl_by_regime.py +3 −2 ⌄    (an edit: the lines replaced, then the new ones)
 *   Ran python3 pnl_by_regime.py ⌄     (a bash command, with its output)
 *   Ran falcon_event_backtest.py ⌄     (Falcon's generated event-test script)
 * Open while the code streams in and runs; once it has run (or the reply ended) it collapses to its row, which
 * opens and closes it. Finished cards from history load collapsed.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";

type Line = { mark: "+" | "-" | " "; node: ReactNode };

function linesOf(code: string, python: boolean, mark: Line["mark"]): Line[] {
  const text = code.replace(/\n$/, "");
  if (!text) return [];
  const nodes: ReactNode[] = python ? highlightPython(text).map((l) => (l.length ? l : " ")) : text.split("\n").map((l) => l || " ");
  return nodes.map((node) => ({ mark, node }));
}

export function ScriptCard({ s }: { s: RunScript }) {
  const still = useCalmMotion();
  const panelId = useId();
  const busy = !s.done;
  // The viewer's choice wins once made; until then the card is open only while the code is written and run.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? busy;
  const python = s.lang === "python";

  const name = s.kind === "falcon" ? "falcon_event_backtest.py" : s.kind === "command" ? "" : scriptFileName(s.path, s.code, s.lang);
  const added = s.kind === "created" || s.kind === "edited" ? lineCount(s.code) : 0;
  const removed = s.kind === "edited" ? lineCount(s.old ?? "") : 0;
  const command = s.kind === "command" ? s.code.trim().split("\n")[0] ?? "" : "";

  const lines = useMemo((): Line[] => {
    if (s.kind === "edited") return [...linesOf(s.old ?? "", python, "-"), ...linesOf(s.code, python, "+")];
    if (s.kind === "created") return linesOf(s.code, python, "+");
    return linesOf(s.code, s.kind === "falcon", " ");
  }, [s.kind, s.code, s.old, python]);

  // Streaming in: keep the newest line in view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (s.writing && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [s.writing, s.code]);

  const verb =
    s.kind === "command" || s.kind === "falcon"
      ? busy ? "Running" : "Ran"
      : s.kind === "edited"
        ? s.writing ? "Editing" : "Edited"
        : s.writing ? "Creating" : "Created";
  const state = s.writing ? "Writing…" : busy ? "Running…" : "";
  const tint = s.kind === "created" ? "bg-up/[0.07]" : "bg-line/[0.035]";

  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setChosen(!open)}
        className={`group -mx-1.5 flex min-w-0 max-w-full items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-left text-fs-13.5 leading-fs-20 transition-colors hover:bg-line/[0.04] ${FOCUS}`}
      >
        <span className="shrink-0 text-quiet">{verb}</span>
        {command ? (
          <code className="min-w-0 truncate font-mono text-fs-12.5 text-quiet-2">{command}</code>
        ) : (
          <span className="min-w-0 truncate text-quiet-2">{name}</span>
        )}
        {added ? <span className="shrink-0 font-mono text-fs-12.5 tabular-nums text-up">+{added}</span> : null}
        {removed ? <span className="shrink-0 font-mono text-fs-12.5 tabular-nums text-down">−{removed}</span> : null}
        {s.kind === "falcon" ? <span className="shrink-0 text-fs-12.5 tabular-nums text-faint">{lineCount(s.code)} lines</span> : null}
        {s.kind === "command" && !busy && typeof s.rc === "number" && s.rc !== 0 ? <span className="shrink-0 text-fs-12.5 text-down">exit {s.rc}</span> : null}
        {state ? <span className="desk-shimmer shrink-0 text-fs-12.5 text-faint">{state}</span> : null}
        <ChevronDown
          width={14}
          height={14}
          strokeWidth={1.75}
          aria-hidden
          className={`shrink-0 text-faint transition-transform duration-200 group-hover:text-fore-3 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            key="code"
            initial={still ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={still ? { height: 0, opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div
              ref={box}
              tabIndex={0}
              role="region"
              aria-label={s.kind === "command" ? "Command and output" : `${name}, ${lines.length} lines`}
              className={`mt-1.5 max-h-[340px] overflow-auto rounded-lg ${tint} py-2 ${FOCUS}`}
            >
              <pre className="min-w-max font-mono text-fs-12.5 leading-fs-20">
                <code>
                  {lines.map((l, i) => (
                    <div key={i} className={`flex ${l.mark === "-" ? "bg-down/[0.08]" : s.kind === "edited" ? "bg-up/[0.07]" : ""}`}>
                      <span className="w-10 shrink-0 select-none pr-3 text-right tabular-nums text-faint-2" aria-hidden>
                        {i + 1}
                      </span>
                      {l.mark !== " " ? (
                        <span className={`w-4 shrink-0 select-none ${l.mark === "+" ? "text-up/70" : "text-down/70"}`} aria-hidden>
                          {l.mark}
                        </span>
                      ) : s.kind === "command" ? (
                        <span className="w-4 shrink-0 select-none text-faint" aria-hidden>
                          {i === 0 ? "$" : ""}
                        </span>
                      ) : null}
                      <span className="pr-6 text-fore-2">{l.node}</span>
                    </div>
                  ))}
                </code>
              </pre>
              {s.kind === "command" && s.out ? (
                <pre
                  className={`mx-3 mt-2 whitespace-pre-wrap break-words border-t border-line/[0.08] pt-2 font-mono text-fs-12 leading-fs-18 ${
                    s.rc ? "text-down" : "text-quiet"
                  }`}
                >
                  {s.out}
                </pre>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
