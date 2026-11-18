"use client";

import { Activity, FlaskConical, LineChart, ScrollText, Search, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ASSISTANT_NAME, FalconBadge } from "./FalconMark";

/**
 * A new session before the first message: the Falcon AI greeting, prompt
 * cards across research, strategy tests, charts and options flow (a click
 * sends the prompt), and a line on what else it can do.
 */

type Suggestion = { kind: string; icon: LucideIcon; title: string; prompt: string };

export const SUGGESTIONS: Suggestion[] = [
  { kind: "Research", icon: Search, title: "Break down NVIDIA's last quarter", prompt: "Break down NVIDIA's latest quarter: revenue by segment, margins, guidance, and how the stock reacted." },
  { kind: "Strategy test", icon: FlaskConical, title: "Test a 50/200-day crossover on SPY", prompt: "Backtest a 50/200-day moving average crossover on SPY since 2010 and compare it with buy and hold." },
  { kind: "Chart", icon: LineChart, title: "Chart AAPL against MSFT this year", prompt: "Chart AAPL and MSFT year to date on one chart, as percent change." },
  { kind: "Options flow", icon: Activity, title: "Unusual options activity in TSLA", prompt: "Show me today's unusual options flow in TSLA and what it might be signalling." },
  { kind: "Filings", icon: ScrollText, title: "What changed in Apple's latest 10-K", prompt: "Summarise the most important changes in Apple's latest 10-K versus the year before, especially risk factors." },
  { kind: "Strategy test", icon: TrendingUp, title: "Buy after insider purchases", prompt: "Test a strategy that buys S&P 500 stocks after a cluster of insider purchases and holds for 60 days." },
];

export function EmptyState({ onPick, disabled }: { onPick: (prompt: string) => void; disabled?: boolean }) {
  // A CSS entrance (lab/motion.tsx .desk-rise), cut by reduced motion.
  const rise = (i: number) => ({ className: "desk-rise", style: { animationDelay: `${40 * i}ms` } });
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center gap-7 px-4 py-8 sm:px-6">
      <div {...rise(0)}>
        <div className="flex flex-col items-start gap-3">
        <FalconBadge size={40} />
        <div className="flex flex-col gap-1">
          <h2 className="text-fs-22 font-medium leading-fs-28 tracking-[-0.015em] text-fore">What should we look into?</h2>
          <p className="max-w-[52ch] text-fs-14 leading-fs-22 text-quiet">
            {ASSISTANT_NAME} researches stocks with live market data and SEC filings, draws charts, reads options flow and tests trading strategies on real history.
          </p>
        </div>
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2" aria-label="Suggested prompts">
        {SUGGESTIONS.map((s, i) => {
          const Icon = s.icon;
          return (
            <li key={s.title} className="desk-rise min-w-0" style={{ animationDelay: `${40 * (i + 1)}ms` }}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(s.prompt)}
                title={s.prompt}
                className="group flex h-full w-full min-w-0 flex-col gap-1.5 rounded-xl border border-line/[0.1] bg-surface px-3.5 py-3 text-left transition-colors hover:border-line/[0.18] hover:bg-line/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25 disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex items-center gap-1.5 text-fs-11.5 font-medium uppercase tracking-[0.06em] text-faint">
                  <Icon width={13} height={13} strokeWidth={1.75} aria-hidden className="text-quiet transition-colors group-hover:text-fore-3" />
                  {s.kind}
                </span>
                <span className="text-fs-14 leading-fs-20 text-fore">{s.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p {...rise(SUGGESTIONS.length + 1)}>
        <span className="text-fs-12.5 leading-fs-18 text-faint">
        Type <kbd className="rounded border border-line/[0.12] px-1 font-mono text-[0.92em] text-quiet">/</kbd> for commands like /quote or /flow, or attach a chart screenshot.
        </span>
      </p>
    </div>
  );
}
