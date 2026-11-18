/**
 * `show_chart`: the Desk AI draws a chart inside its answer, where it calls the
 * tool. The spec is checked with lib/desk/chart-spec.ts and sent to the client
 * with the tool's "done" activity line (`chart`); the model gets a short result
 * ("chart shown" and what it shows) so the loop carries on. Server-only.
 *
 * A series can carry `prices: { ticker, range, as }` instead of points: the
 * server loads every daily close itself (Databento, Yahoo before mid 2024, the
 * same sources as `history`), so a price chart costs the model a few tokens,
 * not hundreds of copied closes.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { CHART_KINDS, CHART_LIMITS, COLOR_BY, describeChart, normalizeChart, type ChartCandle, type ChartPoint, type ChartSpec } from "../chart-spec";
import { DATABENTO_LABEL, databentoBars } from "./databento";
import { HISTORY_RANGES, barsFromChart, rangeStartDate, type HistoryRange } from "./history";
import { yahooChart } from "./yahoo";
import { DEFAULT_TOOL_TIMEOUT_MS, ToolError, deadline, downsample, normalizeTicker, round, type DeskToolContext } from "./util";

export const CHART_TOOL_NAME = "show_chart";

const axisSchema = {
  type: "object",
  properties: { label: { type: "string", maxLength: CHART_LIMITS.label }, unit: { type: "string", maxLength: CHART_LIMITS.unit, description: 'e.g. "$", "%", "x", "days". With "%", give values in percent (12.5 = 12.5%).' } },
  additionalProperties: false,
} as const;

export const CHART_TOOL = {
  name: CHART_TOOL_NAME,
  description:
    "Draws a chart inside your answer, at the point where you call it (the member sees it between your paragraphs; it is kept with the conversation). " +
    "Kinds: line, area, bar, scatter, candlestick, surface3d (an interactive 3D surface the member can rotate and zoom) and scatter3d (interactive 3D points: three measures across many tickers or test runs). " +
    "2D: series [{ name, points: [[x, y], ...] }] where x is a date \"YYYY-MM-DD\", a number, or a short label (bar categories); y a number or null for a gap. " +
    "Price charts: give a series `prices: { ticker, range, as }` instead of points and the server loads every daily close (as: \"price\" or \"return\", % change from the start, to compare tickers on one axis); candlestick takes one prices series (or points [[date, open, high, low, close], ...]). " +
    `surface3d: grid { x: number[], y: number[], z: number[][] } with x and y ascending and z[i][j] the value at y[i], x[j] (null for a cell with no value), at most ${CHART_LIMITS.grid} values per side. ` +
    `scatter3d: points [{ x, y, z, label (ticker, at most ${CHART_LIMITS.pointLabel} chars), group (e.g. sector), size (optional relative weight), value (optional number) }], at most ${CHART_LIMITS.points3d} points and ${CHART_LIMITS.groups} groups; colorBy "group" (default with groups), "z" or "value" (with value: { label, unit }); highlight: up to ${CHART_LIMITS.highlight} labels always shown. ` +
    `Limits: ${CHART_LIMITS.series} series, ${CHART_LIMITS.points} points in all. Use only numbers from tools or code output, never invented ones.`,
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...CHART_KINDS] },
      title: { type: "string", maxLength: CHART_LIMITS.title, description: "Short, says what is shown, e.g. \"NVDA close, last 12 months\"." },
      subtitle: { type: "string", maxLength: CHART_LIMITS.subtitle, description: "Optional: period, method or what to look at." },
      source: { type: "string", maxLength: CHART_LIMITS.source, description: "Where the numbers come from and their as-of date. Filled in for prices series." },
      axes: { type: "object", properties: { x: axisSchema, y: axisSchema, z: axisSchema }, additionalProperties: false, description: "Axis labels and units (z: surface3d's height)." },
      series: {
        type: "array",
        maxItems: CHART_LIMITS.series,
        items: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: CHART_LIMITS.label },
            points: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } }, description: "[[x, y], ...]; candlestick: [[date, open, high, low, close], ...]." },
            prices: {
              type: "object",
              properties: {
                ticker: { type: "string", maxLength: 10 },
                range: { type: "string", enum: [...HISTORY_RANGES], description: "Period ending today. Default 1y." },
                as: { type: "string", enum: ["price", "return"], description: "price (default): the close; return: % change from the first close." },
              },
              required: ["ticker"],
              additionalProperties: false,
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      points: {
        type: "array",
        maxItems: CHART_LIMITS.points3d,
        description: "scatter3d only.",
        items: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
            label: { type: "string", maxLength: CHART_LIMITS.pointLabel },
            group: { type: "string", maxLength: CHART_LIMITS.pointLabel },
            size: { type: "number", description: "Relative weight, above 0 (e.g. market cap); bigger points." },
            value: { type: "number", description: "A fourth measure shown as colour with colorBy \"value\"." },
          },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
      },
      colorBy: { type: "string", enum: [...COLOR_BY], description: "scatter3d: colour by group (categorical), z, or each point's value (continuous)." },
      value: { ...axisSchema, description: "scatter3d with colorBy \"value\": what the value is." },
      highlight: { type: "array", maxItems: CHART_LIMITS.highlight, items: { type: "string" }, description: "scatter3d: labels of points to label permanently (the few that matter)." },
      grid: {
        type: "object",
        properties: {
          x: { type: "array", items: { type: "number" } },
          y: { type: "array", items: { type: "number" } },
          z: { type: "array", items: { type: "array", items: { type: ["number", "null"] } } },
        },
        required: ["x", "y", "z"],
        additionalProperties: false,
      },
    },
    required: ["kind", "title"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

const YAHOO: Record<HistoryRange, { range: string; interval: "1d" | "1wk" }> = {
  "1m": { range: "1mo", interval: "1d" },
  "3m": { range: "3mo", interval: "1d" },
  "6m": { range: "6mo", interval: "1d" },
  ytd: { range: "ytd", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "2y": { range: "2y", interval: "1d" },
  "5y": { range: "5y", interval: "1d" },
  "10y": { range: "10y", interval: "1wk" },
  max: { range: "max", interval: "1wk" },
};

type Bar = { date: string; open: number; high: number; low: number; close: number };

/** Split-adjusted daily (weekly for 10y and max from Yahoo) bars of a range, oldest first, and their source. */
export async function loadBars(ticker: string, range: HistoryRange, signal: AbortSignal): Promise<{ bars: Bar[]; source: string }> {
  const d = await databentoBars(ticker, "max");
  if (d) {
    const start = rangeStartDate(range, d.asOf);
    // Databento starts 2024-07-01: a longer range comes whole from Yahoo (never mixed), as in `history`.
    if (start !== null && start >= d.from) {
      const bars = d.bars.filter((b) => b[0] >= start).map((b) => ({ date: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));
      if (bars.length >= 2) return { bars, source: `${DATABENTO_LABEL}, as of ${bars[bars.length - 1]!.date}` };
    }
  }
  const y = YAHOO[range];
  const chart = await yahooChart(ticker, y.range, y.interval, signal);
  if (!chart) throw new ToolError(`No price history found for ${ticker}. Check the ticker (US listings only).`);
  const bars = barsFromChart(chart);
  if (bars.length < 2) throw new ToolError(`Not enough price history for ${ticker} over ${range}.`);
  return { bars, source: `Yahoo Finance chart (split-adjusted${y.interval === "1wk" ? ", weekly" : ""})` };
}

/** Candles merged `k` at a time (first open, highest high, lowest low, last close), so a long range still fits. */
export function mergeCandles(c: ChartCandle[], max: number): ChartCandle[] {
  if (c.length <= max) return c;
  const k = Math.ceil(c.length / max);
  const out: ChartCandle[] = [];
  // Groups end on the newest bar, so the last candle is complete.
  for (let end = c.length; end > 0; end -= k) {
    const g = c.slice(Math.max(0, end - k), end);
    out.unshift([g[0]![0], g[0]![1], Math.max(...g.map((x) => x[2])), Math.min(...g.map((x) => x[3])), g[g.length - 1]![4]]);
  }
  return out;
}

type Input = Record<string, unknown>;
const isObj = (v: unknown): v is Input => !!v && typeof v === "object" && !Array.isArray(v);

/** Replaces `prices` series with their points (and fills in the source). */
async function resolvePrices(input: Input, signal: AbortSignal): Promise<Input> {
  if (!Array.isArray(input.series) || !input.series.some((s) => isObj(s) && isObj(s.prices))) return input;
  const kind = input.kind;
  const sources = new Set<string>();
  const list = input.series as unknown[];
  // Price series share the point budget evenly.
  const per = Math.max(50, Math.floor(CHART_LIMITS.points / Math.max(1, list.length)));
  const series = await Promise.all(
    list.map(async (s) => {
      if (!isObj(s) || !isObj(s.prices)) return s;
      const p = s.prices;
      const ticker = normalizeTicker(p.ticker);
      const range = (typeof p.range === "string" ? p.range.toLowerCase() : "1y") as HistoryRange;
      if (!(HISTORY_RANGES as readonly string[]).includes(range)) throw new ToolError(`prices.range must be one of ${HISTORY_RANGES.join(", ")}.`);
      const { bars, source } = await loadBars(ticker, range, signal);
      sources.add(source);
      const name = typeof s.name === "string" && s.name.trim() ? s.name : ticker.replace("-", ".");
      if (kind === "candlestick") {
        return { name, points: mergeCandles(bars.map((b): ChartCandle => [b.date, round(b.open, 4)!, round(b.high, 4)!, round(b.low, 4)!, round(b.close, 4)!]), CHART_LIMITS.candles) };
      }
      const base = bars[0]!.close;
      const asReturn = p.as === "return";
      const points = downsample(bars, per).map((b): ChartPoint => [b.date, asReturn ? round((b.close / base - 1) * 100, 2) : round(b.close, 4)]);
      return { name, points };
    }),
  );
  const out: Input = { ...input, series };
  if (!(typeof input.source === "string" && input.source.trim())) out.source = Array.from(sources).join("; ");
  // A return chart's y axis is in percent unless the model said otherwise.
  const allReturn = list.every((s) => isObj(s) && isObj(s.prices) && s.prices.as === "return");
  if (allReturn && kind !== "candlestick") {
    const axes = isObj(input.axes) ? input.axes : {};
    const y = isObj(axes.y) ? axes.y : {};
    if (!y.unit) out.axes = { ...axes, y: { label: "Change from start", ...y, unit: "%" } };
  }
  return out;
}

/** Labels for the tool row (shown only when the chart fails): "Drawing chart" / "Drew chart". */
export function chartLabel(input: unknown, phase: "running" | "done"): string {
  const t = isObj(input) && typeof input.title === "string" ? input.title.trim().slice(0, 60) : "";
  return `${phase === "running" ? "Drawing" : "Drew"} chart${t ? `: ${t}` : ""}`;
}

export type ChartOutcome = { name: string; ok: boolean; content: string; label: string; ms: number; chart?: ChartSpec };

/** Checks (and for prices series, loads) a chart. Never throws: failures come back as `{ error }` with ok false. */
export async function runChartTool(input: unknown, ctx: DeskToolContext = {}): Promise<ChartOutcome> {
  const started = Date.now();
  const label = chartLabel(input, "done");
  const fail = (error: string): ChartOutcome => ({ name: CHART_TOOL_NAME, ok: false, content: JSON.stringify({ error }), label, ms: Date.now() - started });
  try {
    const signal = deadline(ctx, ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
    const resolved = isObj(input) ? await resolvePrices(input, signal) : input;
    const r = normalizeChart(resolved);
    if (!r.ok) return fail(r.error);
    const content = JSON.stringify({ shown: true, note: "The member now sees this chart in your answer, where you called the tool. Refer to it; do not repeat its data.", summary: describeChart(r.spec), ...(r.spec.source ? { source: r.spec.source } : {}) });
    return { name: CHART_TOOL_NAME, ok: true, content, label, ms: Date.now() - started, chart: r.spec };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message);
    console.error("[desk/tools]", JSON.stringify({ tool: CHART_TOOL_NAME, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    return fail("The price data for this chart is unavailable right now. Answer without the chart and say so.");
  }
}
