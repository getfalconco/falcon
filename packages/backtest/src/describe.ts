/**
 * Plain-English summary of a strategy, generated from the rules themselves
 * (never from model text), so what the user reads is exactly what runs.
 * Pure; safe to call in the browser after the user edits the rules.
 */

import type { Condition, Strategy } from "./schema";

const MA_NAME = { sma: "simple", ema: "exponential" } as const;

function signed(n: number): string {
  const v = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return n > 0 ? `+${v}%` : `${v}%`;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function sessions(n: number): string {
  return n === 1 ? "1 trading day" : `${n} trading days`;
}

function relWord(op: "above" | "below" | "crosses_above" | "crosses_below"): string {
  return { above: "is above", below: "is below", crosses_above: "crosses above", crosses_below: "crosses below" }[op];
}

/** One condition as a clause. `subject` names the traded ticker ("SPY" or "the stock"). */
export function describeCondition(c: Condition, subject: string): string {
  const who = "ticker" in c && c.ticker ? c.ticker : subject;
  switch (c.type) {
    case "price_vs_ma": {
      const verb = { above: "closes above", below: "closes below", crosses_above: "closes back above", crosses_below: "closes back below" }[c.op];
      return `${who} ${verb} its ${c.period}-day ${MA_NAME[c.ma]} moving average`;
    }
    case "ma_cross":
      return `${who}'s ${c.fastPeriod}-day ${MA_NAME[c.fastMa]} average ${relWord(c.op)} its ${c.slowPeriod}-day ${MA_NAME[c.slowMa]} average`;
    case "rsi":
      return `${who}'s ${c.period}-day RSI ${relWord(c.op)} ${num(c.value)}`;
    case "n_day_return":
      return `${who}'s ${c.days}-day return is ${c.op} ${signed(c.pct)}`;
    case "gap":
      return `${who} opens with a gap ${c.op} ${signed(c.pct)} vs the previous close`;
    case "breakout":
      return `${who} closes at a new ${c.days}-day ${c.op === "new_high" ? "high" : "low"}`;
    case "earnings_surprise":
      return `${sessions(c.daysAfter)} after ${who} reports earnings with an EPS surprise ${c.op} ${signed(c.pct)}`;
    case "ripple_event": {
      const parts = [
        c.relation ? `as a ${c.relation}` : null,
        c.direction ? `direction ${c.direction}` : null,
        c.minConfidence ? `confidence ${c.minConfidence} or higher` : null,
        c.maxDegree === 1 ? "direct links only" : null,
      ].filter(Boolean);
      return `${sessions(c.daysAfter)} after a Sighting reaches ${who}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    }
  }
}

function joinConditions(cs: readonly Condition[], subject: string, mode: "all" | "any"): string {
  const parts = cs.map((c) => describeCondition(c, subject));
  if (parts.length === 1) return parts[0]!;
  return `${mode === "all" ? "all of these hold" : "any of these holds"}: ${parts.join("; ")}`;
}

export function describeStrategy(s: Strategy): string[] {
  const subject = s.universe.length === 1 ? s.universe[0]! : "the stock";
  const lines: string[] = [];
  lines.push(
    s.universe.length === 1 ? `Trades ${s.universe[0]}.` : `Trades any of ${s.universe.length} tickers: ${s.universe.join(", ")}.`,
  );
  lines.push(`Enters at the next open when, on the close, ${joinConditions(s.entry.conditions, subject, s.entry.mode)}.`);

  const exits: string[] = [];
  if (s.exit.conditions.length) {
    exits.push(`Exits at the next open when, on the close, ${joinConditions(s.exit.conditions, subject, "any")}.`);
  }
  if (s.exit.maxHoldingDays !== null) exits.push(`Exits at the open after ${sessions(s.exit.maxHoldingDays)} held.`);
  if (s.exit.stopLossPct !== null) exits.push(`Stop loss ${num(s.exit.stopLossPct)}% below the entry price.`);
  if (s.exit.takeProfitPct !== null) exits.push(`Take profit ${num(s.exit.takeProfitPct)}% above the entry price.`);
  if (!exits.length) exits.push("No exit rule: positions stay open until the end of the test.");
  lines.push(...exits);

  const pct = s.sizing.positionPct ?? 100 / s.sizing.maxPositions;
  lines.push(
    s.sizing.maxPositions === 1
      ? `One position at a time, ${num(Math.round(pct * 100) / 100)}% of equity.`
      : `Up to ${s.sizing.maxPositions} positions at once, ${num(Math.round(pct * 100) / 100)}% of equity each.`,
  );
  if (s.rebalance !== "none") lines.push(`Open positions go back to that weight every ${s.rebalance === "weekly" ? "week" : "month"}.`);
  return lines;
}
