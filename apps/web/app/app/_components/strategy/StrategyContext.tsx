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
              <li key={n} className="text-[12px] leading-[18px] text-[#4b4b48]">
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
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
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
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-black/20 ${
                  s.id === strategyId ? "bg-black/[0.05]" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#1d1b1b]">{s.rules.name.trim() || "Untitled strategy"}</span>
                <span className="shrink-0 text-[11px] text-[#9a9a9a]">{timeAgo(new Date(s.updatedAt).toISOString())}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="pt-1 text-[11px] leading-[16px] text-[#b0b0ab]">Saved in this browser.</p>
      </section>
      <section>
        <SectionTitle>About these results</SectionTitle>
        <ul className="flex flex-col gap-1.5 pt-1">
          {CAVEATS.map((c) => (
            <li key={c} className="text-[11.5px] leading-[17px] text-[#767676]">
              {c}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
