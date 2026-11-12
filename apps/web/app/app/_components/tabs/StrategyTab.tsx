"use client";

import { MONO, SERIF } from "../parts";

/** Placeholder for the backtester (vault: Backtesting). */
export function StrategyTab() {
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-7 py-6">
      <header>
        <span className="text-[11px] uppercase tracking-[0.16em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
          Backtest
        </span>
        <h1 className="mt-1 text-[28px] leading-[36px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          Strategy
        </h1>
      </header>
      <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed border-black/[0.12]">
        <p className="text-[13px] text-[#9a9a9a]">Coming soon</p>
      </div>
    </div>
  );
}
