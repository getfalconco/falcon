"use client";

import { useEffect, useRef } from "react";

/**
 * The composer's "/" menu: typing "/" at the start of a message lists the
 * Falcon AI commands (the same names the tool rows show, lib/desk/tools/command.ts).
 * Picking one puts "/quote " in the composer; Falcon AI reads the command and
 * its ticker like any other message. Arrow keys move, Enter or Tab picks,
 * Escape closes. The textarea keeps focus (aria-activedescendant).
 */

export type SlashCommand = { name: string; args: string; hint: string };

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "quote", args: "TICKER", hint: "Latest price, change and volume" },
  { name: "history", args: "TICKER", hint: "Daily price history over a date range" },
  { name: "fundamentals", args: "TICKER", hint: "Revenue, margins and balance sheet from SEC filings" },
  { name: "earnings", args: "TICKER", hint: "Earnings record: reported versus expected" },
  { name: "filings", args: "TICKER", hint: "Search 10-K, 10-Q and 8-K filings" },
  { name: "insiders", args: "TICKER", hint: "Recent insider buys and sells" },
  { name: "news", args: "[TICKER]", hint: "Latest company news, or one stock's" },
  { name: "events", args: "TICKER", hint: "Past earnings reactions versus the sector ETF" },
  { name: "load_events", args: "--min-return 10% --since 2016", hint: "Load every matching event into a strategy test" },
  { name: "load_graph", args: "--as-of 2018-06-30", hint: "Load the filing links known on a date into a strategy test" },
  { name: "flow", args: "TICKER", hint: "Options flow and unusual activity" },
  { name: "chart", args: "TICKER", hint: "Draw a price chart in the chat" },
];

/** The commands matching what is typed, or null when the menu should not show ("/qu" -> quote). */
export function slashMatches(text: string): SlashCommand[] | null {
  const m = /^\/(\w*)$/.exec(text);
  if (!m) return null;
  const q = m[1]!.toLowerCase();
  const list = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  return list.length ? list : null;
}

export const SLASH_MENU_ID = "falcon-slash-menu";
export const slashOptionId = (name: string) => `falcon-slash-${name}`;

export function SlashMenu({ items, active, onPick, onHover }: { items: SlashCommand[]; active: number; onPick: (c: SlashCommand) => void; onHover: (i: number) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-2xl border border-line/[0.1] bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
      <p className="px-3.5 pb-1 pt-2.5 text-fs-11.5 font-medium uppercase tracking-[0.06em] text-faint">Commands</p>
      <ul ref={listRef} id={SLASH_MENU_ID} role="listbox" aria-label="Commands" className="max-h-[264px] overflow-y-auto px-1.5 pb-1.5">
        {items.map((c, i) => (
          <li
            key={c.name}
            id={slashOptionId(c.name)}
            data-index={i}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => {
              // Keep focus in the composer.
              e.preventDefault();
              onPick(c);
            }}
            onMouseMove={() => onHover(i)}
            className={`flex min-w-0 cursor-pointer items-baseline gap-3 rounded-xl px-2.5 py-2 ${i === active ? "bg-line/[0.07]" : ""}`}
          >
            <span className="shrink-0 font-mono text-fs-13.5 text-fore">
              /{c.name}
              <span className="ml-1.5 text-faint">{c.args}</span>
            </span>
            <span className="min-w-0 truncate text-fs-13 text-quiet">{c.hint}</span>
          </li>
        ))}
      </ul>
      <p className="hidden border-t border-line/[0.07] px-3.5 py-1.5 text-fs-11.5 text-faint sm:block">
        <kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> to move · <kbd className="font-sans">Enter</kbd> or <kbd className="font-sans">Tab</kbd> to pick · <kbd className="font-sans">Esc</kbd> to close
      </p>
    </div>
  );
}
