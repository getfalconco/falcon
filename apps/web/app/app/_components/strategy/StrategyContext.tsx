"use client";

import { Plus } from "lucide-react";
import { CAVEATS } from "@falcon/backtest";
import { useWorkspace } from "../context";
import { SectionTitle, timeAgo } from "../parts";

/** Right panel for a Strategy tab: saved strategies and what results can and cannot say. */
export function StrategyContext({ strategyId }: { strategyId: string }) {
  const { strategies, openStrategy, newStrategy } = useWorkspace();
  const self = strategies.find((s) => s.id === strategyId);
  const notes = self?.origin.kind === "sighting" ? self.origin.notes : [];
  return (
    <>
      {notes.length ? (
        <section>
          <SectionTitle>From the sighting</SectionTitle>
          <ul className="flex flex-col gap-1.5 pt-1">
            {notes.map((n) => (
              <li key={n} className="text-fs-12 leading-fs-18 text-fore-4">
                {n}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <SectionTitle
          count={strategies.length}
          action={
            <button
              type="button"
              onClick={() => newStrategy()}
              aria-label="New strategy"
              title="New strategy"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-quiet outline-none transition-colors hover:bg-line/[0.05] hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20"
            >
              <Plus width={13} height={13} aria-hidden />
            </button>
          }
        >
          Saved strategies
        </SectionTitle>
        <ul className="flex flex-col pt-1">
          {strategies.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => openStrategy(s.id)}
                aria-current={s.id === strategyId ? "page" : undefined}
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-line/[0.04] focus-visible:ring-2 focus-visible:ring-line/20 ${
                  s.id === strategyId ? "bg-line/[0.05]" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-fs-12.5 text-fore">{s.rules.name.trim() || "Untitled strategy"}</span>
                <span className="shrink-0 text-fs-11 text-faint">{timeAgo(new Date(s.updatedAt).toISOString())}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="pt-1 text-fs-11 leading-fs-16 text-faint-2">Saved in this browser.</p>
      </section>
      <section>
        <SectionTitle>About these results</SectionTitle>
        <ul className="flex flex-col gap-1.5 pt-1">
          {CAVEATS.map((c) => (
            <li key={c} className="text-fs-11.5 leading-fs-17 text-quiet">
              {c}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
