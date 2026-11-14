"use client";

import type { HistoryStudy } from "@falcon/backtest";
import { MONO, Panel, SectionTitle } from "../parts";
import { pct } from "./EquityChart";

/**
 * "Backtest this" as a measured event study from the card's own record
 * (history.events): N past events, G separate dates, moves the implied way,
 * the same numbers the card shows. Never an evidence label (design 7.6).
 */
export function HistoryStudyView({ studies, eventTicker }: { studies: HistoryStudy[]; eventTicker: string }) {
  return (
    <section>
      <SectionTitle>Measured move (from the close before the news)</SectionTitle>
      <div className="mt-2 flex flex-col gap-3">
        {studies.map((s) => (
          <Panel key={s.ticker} className="px-5 py-4">
            <p className="text-[13px] leading-[20px] text-[#1d1b1b]">
              In {s.wins} of {s.n} past {eventTicker} events, on {s.g} separate {s.g === 1 ? "date" : "dates"}, {s.ticker} moved {s.direction} against {s.benchmark} over{" "}
              {s.windowDays} {s.windowDays === 1 ? "session" : "sessions"}.
            </p>
            <p className="mt-1 text-[12px] leading-[18px] text-[#767676]">
              Average move vs {s.benchmark} {pct(s.meanAdjustedPct, 2)}, median {pct(s.medianAdjustedPct, 2)}
              {s.from && s.to ? `, ${s.from} to ${s.to}` : ""}. Range for the share of moves the implied way (90%): {Math.round(s.winRange[0] * 100)}% to {Math.round(s.winRange[1] * 100)}%.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-[12px] text-[#767676] outline-none hover:text-[#1d1b1b] focus-visible:underline">The {s.n} events</summary>
              <table className="mt-2 w-full text-right text-[12px] tabular-nums" style={{ fontFamily: MONO }}>
                <thead className="text-[11.5px] text-[#767676]">
                  <tr>
                    <th className="py-1 text-left font-normal">Event</th>
                    <th className="text-left font-normal">Reaction day</th>
                    <th className="font-normal">{s.ticker}</th>
                    <th className="font-normal">{s.benchmark}</th>
                    <th className="font-normal">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {s.events.map((e) => (
                    <tr key={`${e.eventDate}-${e.reactionDate}`} className="border-t border-black/[0.05]">
                      <td className="py-1 text-left">{e.eventDate}</td>
                      <td className="text-left">{e.reactionDate}</td>
                      <td>{pct(e.movePct, 2)}</td>
                      <td className="text-[#767676]">{pct(e.benchmarkPct, 2)}</td>
                      <td>{pct(e.adjustedPct, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Panel>
        ))}
        <p className="text-[11.5px] leading-[17px] text-[#9a9a9a]">
          A record of past events, not a probability for this one. Measured with the same method as the card: the move minus the move of {studies[0]?.benchmark ?? "SPY"} over the same closes. Only
          companies listed today are measured.
        </p>
      </div>
    </section>
  );
}
