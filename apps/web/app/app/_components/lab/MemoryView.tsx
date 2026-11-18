"use client";

import { useEffect, useRef, useState } from "react";
import { clearMemory, forgetMemory, useDeskMemory } from "./memory-store";

/**
 * "Memory" in the Desk header: what Falcon AI remembers across sessions
 * (lab/memory-store.ts), with a button to forget each item. Items are added by
 * asking in the chat ("remember that I prefer short answers").
 */
export function MemoryButton({ scope }: { scope: string }) {
  const items = useDeskMemory(scope);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-fs-13.5 font-medium text-fore-3 transition-colors hover:bg-line/[0.05] hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/15 ${open ? "bg-line/[0.06] text-fore" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5c-2.6 0-4.5 1.9-4.5 4.3 0 1.5.7 2.6 1.7 3.4v2.3h5.6v-2.3c1-.8 1.7-1.9 1.7-3.4 0-2.4-1.9-4.3-4.5-4.3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M6.3 14h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        Memory
        {items.length ? <span className="rounded-full bg-line/[0.07] px-1.5 text-fs-12 leading-fs-16 text-quiet">{items.length}</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Falcon AI memory" className="absolute right-0 top-10 z-50 w-[min(340px,calc(100vw-32px))] rounded-xl border border-line/[0.1] bg-surface p-3 shadow-lg">
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <p className="text-fs-14 font-medium text-fore">Memory</p>
            {items.length ? (
              <button type="button" onClick={() => clearMemory(scope)} className="rounded-md px-1.5 text-fs-12.5 text-quiet hover:bg-line/[0.05] hover:text-fore">
                Forget all
              </button>
            ) : null}
          </div>
          {items.length ? (
            <ul className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
              {items.map((m) => (
                <li key={m.id} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-line/[0.04]">
                  <span className="min-w-0 flex-1 text-fs-13.5 leading-fs-20 text-fore-2">{m.text}</span>
                  <button
                    type="button"
                    aria-label={`Forget: ${m.text}`}
                    onClick={() => forgetMemory(scope, m.id)}
                    className="mt-0.5 shrink-0 rounded-md p-0.5 text-faint hover:bg-line/[0.06] hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/15"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 pb-1 text-fs-13.5 leading-fs-20 text-quiet">Nothing saved yet. Tell Falcon AI what to remember, like &ldquo;always answer briefly&rdquo;, and it applies it in every session.</p>
          )}
          <p className="px-1 pt-2 text-fs-12 leading-fs-16 text-faint">Kept in this browser.</p>
        </div>
      ) : null}
    </div>
  );
}
