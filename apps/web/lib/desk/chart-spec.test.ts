// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/chart-spec.test.ts
// The chart tool's spec checks (lib/desk/chart-spec.ts) and its server side (lib/desk/tools/chart.ts), with no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_LIMITS, describeChart, normalizeChart, xKind, type ChartSpec } from "./chart-spec";
import { CHART_TOOL, mergeCandles, runChartTool } from "./tools/chart";
import { deskToolCommand } from "./tools/command";

const ok = (input: unknown): ChartSpec => {
  const r = normalizeChart(input);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.spec;
};
const err = (input: unknown): string => {
  const r = normalizeChart(input);
  assert.equal(r.ok, false);
  return r.ok ? "" : r.error;
};

test("a line chart is cleaned and sorted by date", () => {
  const s = ok({
    kind: "line",
    title: "  NVDA   close ",
    axes: { y: { label: "Close", unit: "$" }, x: {} },
    series: [{ name: "NVDA", points: [["2025-02-01", "120.5"], ["2025-01-01", 110], ["2025-03-01", null]] }],
  });
  assert.equal(s.title, "NVDA close");
  assert.deepEqual(s.series![0]!.points, [["2025-01-01", 110], ["2025-02-01", 120.5], ["2025-03-01", null]]);
  assert.deepEqual(s.axes, { y: { label: "Close", unit: "$" } });
  assert.equal(xKind(s.series!), "time");
});

test("normalizing twice is a no-op (stored specs re-validate unchanged)", () => {
  const inputs = [
    { kind: "bar", title: "Revenue", series: [{ name: "Q", points: [["Q1 25", 10], ["Q2 25", -2]] }] },
    { kind: "candlestick", title: "C", series: [{ name: "X", points: [["2025-01-02", 10, 9, 11, 10.5]] }] },
    { kind: "surface3d", title: "S", axes: { z: { label: "Sharpe" } }, grid: { x: [1, 2], y: [1, 2, 3], z: [[1, 2], [3, null], [5, 6]] } },
  ];
  for (const i of inputs) {
    const once = ok(i);
    assert.deepEqual(ok(JSON.parse(JSON.stringify(once))), once);
  }
});

test("candles get a consistent high and low", () => {
  const s = ok({ kind: "candlestick", title: "C", series: [{ name: "X", points: [["2025-01-02", 10, 9, 11, 10.5]] }] });
  // High and low swapped by mistake: the highest and lowest of the four prices.
  assert.deepEqual(s.series![0]!.points[0], ["2025-01-02", 10, 11, 9, 10.5]);
});

test("bad specs come back with an error the model can act on", () => {
  assert.match(err(null), /object/);
  assert.match(err({ kind: "pie", title: "x" }), /kind must be one of/);
  assert.match(err({ kind: "line", series: [{ name: "a", points: [[1, 2]] }] }), /title is required/);
  assert.match(err({ kind: "line", title: "t" }), /series is required/);
  assert.match(err({ kind: "line", title: "t", series: [{ name: "a", points: [[1, "abc"]] }] }), /number or null/);
  assert.match(err({ kind: "line", title: "t", series: [{ name: "a", points: [[1, Infinity]] }] }), /number or null/);
  assert.match(err({ kind: "line", title: "t", series: [{ name: "a", points: [[1, null]] }] }), /null/);
  assert.match(err({ kind: "scatter", title: "t", series: [{ name: "a", points: [["A", 1]] }] }), /numeric/);
  assert.match(err({ kind: "candlestick", title: "t", series: [{ name: "a", points: [] }, { name: "b", points: [] }] }), /exactly one/);
  const many = Array.from({ length: CHART_LIMITS.series + 1 }, (_, i) => ({ name: `s${i}`, points: [[1, 1]] }));
  assert.match(err({ kind: "line", title: "t", series: many }), /At most 8 series/);
  const long = Array.from({ length: CHART_LIMITS.points + 1 }, (_, i) => [i, i]);
  assert.match(err({ kind: "line", title: "t", series: [{ name: "a", points: long }] }), /at most 5000/);
});

test("surface grids are checked: shape, order, size, enough values", () => {
  const base = { kind: "surface3d", title: "Sweep" };
  assert.match(err({ ...base }), /grid/);
  assert.match(err({ ...base, grid: { x: [1, 2], y: [1, 2], z: [[1, 2]] } }), /one row per y/);
  assert.match(err({ ...base, grid: { x: [1, 2], y: [1, 2], z: [[1, 2], [3]] } }), /one value per x/);
  assert.match(err({ ...base, grid: { x: [2, 1], y: [1, 2], z: [[1, 2], [3, 4]] } }), /strictly increasing/);
  assert.match(err({ ...base, grid: { x: [1, 2], y: [1, 2], z: [[1, null], [3, 4]] } }), /at least 4/);
  const big = Array.from({ length: CHART_LIMITS.grid + 1 }, (_, i) => i);
  assert.match(err({ ...base, grid: { x: big, y: [1, 2], z: [big, big] } }), /at most 120/);
  const max = Array.from({ length: CHART_LIMITS.grid }, (_, i) => i);
  const s = ok({ ...base, grid: { x: max, y: max, z: max.map((r) => max.map((c) => r * c)) } });
  assert.equal(s.grid!.z.length, CHART_LIMITS.grid);
});

test("describeChart names the extremes of a surface and the ends of a series", () => {
  const s = ok({ kind: "surface3d", title: "S", axes: { x: { label: "fast" }, y: { label: "slow" }, z: { label: "Sharpe" } }, grid: { x: [10, 20], y: [50, 100], z: [[0.1, 0.4], [0.9, -0.2]] } });
  const d = describeChart(s);
  assert.match(d, /highest 0\.900 at fast 10, slow 100/);
  assert.match(d, /lowest -0\.200 at fast 20, slow 100/);
  const l = ok({ kind: "line", title: "L", series: [{ name: "A", points: [["2025-01-01", 1], ["2025-02-01", 2]] }] });
  assert.match(describeChart(l), /A: 2 points, from 1\.000 at 2025-01-01 to 2\.000 at 2025-02-01/);
});

test("mergeCandles keeps the newest bar whole and the range's extremes", () => {
  const c = Array.from({ length: 10 }, (_, i) => [`2025-01-${String(i + 1).padStart(2, "0")}`, i, i + 2, i - 1, i + 1] as [string, number, number, number, number]);
  const m = mergeCandles(c, 4);
  assert.equal(m.length, 4);
  assert.deepEqual(m[m.length - 1], ["2025-01-08", 7, 11, 6, 10]);
  assert.equal(Math.max(...m.map((x) => x[2])), 11);
  assert.equal(Math.min(...m.map((x) => x[3])), -1);
});

test("the tool returns a short result for the model and the spec for the client", async () => {
  const r = await runChartTool({ kind: "bar", title: "EPS", axes: { y: { unit: "$" } }, series: [{ name: "EPS", points: [["Q1", 1.2], ["Q2", 1.4]] }] });
  assert.equal(r.ok, true);
  assert.equal(r.chart?.kind, "bar");
  const content = JSON.parse(r.content) as { shown: boolean; summary: string };
  assert.equal(content.shown, true);
  assert.match(content.summary, /bar chart/);
  assert.ok(r.content.length < 600);
  const bad = await runChartTool({ kind: "bar", title: "EPS" });
  assert.equal(bad.ok, false);
  assert.equal(bad.chart, undefined);
  assert.match(JSON.parse(bad.content).error, /series is required/);
  const badTicker = await runChartTool({ kind: "line", title: "P", series: [{ name: "x", prices: { ticker: "not a ticker" } }] });
  assert.equal(badTicker.ok, false);
  assert.match(JSON.parse(badTicker.content).error, /not a US stock ticker/);
});

test("the tool definition and its command row", () => {
  assert.equal(CHART_TOOL.name, "show_chart");
  assert.deepEqual(CHART_TOOL.input_schema.required, ["kind", "title"]);
  assert.equal(deskToolCommand("show_chart", { kind: "surface3d", title: "Sharpe by MA lengths" }).cmd, '/chart surface3d "Sharpe by MA lengths"');
});

test("scatter3d: points are cleaned, groups and colour default, highlights match labels", () => {
  const s = ok({
    kind: "scatter3d",
    title: "Semis",
    axes: { x: { label: "IV 30d", unit: "%" }, y: { label: "3m return", unit: "%" }, z: { label: "Earnings reaction", unit: "%" } },
    points: [
      { x: "52.1", y: 30, z: 4.2, label: "NVDA", group: "Semis", size: 3400 },
      { x: 40, y: -5, z: -1.1, label: "INTC", group: "Semis" },
      { x: 35, y: 12, z: 2, label: "AMAT", group: "Equipment" },
      { x: 33, y: 8, z: 0.5, label: "Unlabelled company with a very long name" },
    ],
    highlight: ["nvda"],
  });
  assert.equal(s.points!.length, 4);
  assert.equal(s.points![0]!.x, 52.1);
  assert.equal(s.colorBy, "group");
  assert.deepEqual(s.highlight, ["NVDA"]);
  assert.equal(s.points![3]!.group, "Other");
  assert.ok(s.points![3]!.label!.length <= CHART_LIMITS.pointLabel);
  assert.equal(s.series, undefined);
  // Normalizing twice is a no-op.
  assert.deepEqual(ok(JSON.parse(JSON.stringify(s))), s);
  const d = describeChart(s);
  assert.match(d, /3D scatter of 4 points in 3 groups \(Semis 2, Equipment 1, Other 1\)/);
  assert.match(d, /highest Earnings reaction: NVDA 4\.200, lowest: INTC -1\.100/);
  assert.match(d, /coloured by group/);
});

test("scatter3d: series become groups; colorBy z and value", () => {
  const s = ok({ kind: "scatter3d", title: "Sweep", series: [{ name: "Fast", points: [[1, 2, 3, "a"], [2, 3, 4]] }, { name: "Slow", points: [{ x: 3, y: 4, z: 5 }] }] });
  assert.deepEqual(s.points!.map((p) => p.group), ["Fast", "Fast", "Slow"]);
  assert.equal(s.points![0]!.label, "a");
  const z = ok({ kind: "scatter3d", title: "Z", points: [{ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }, { x: 3, y: 3, z: 3 }] });
  assert.equal(z.colorBy, "z");
  const v = ok({ kind: "scatter3d", title: "V", colorBy: "value", value: { label: "Sharpe" }, points: [1, 2, 3].map((n) => ({ x: n, y: n, z: n, value: n / 10 })) });
  assert.equal(v.colorBy, "value");
  assert.deepEqual(v.value, { label: "Sharpe" });
  assert.match(describeChart(v), /coloured by Sharpe/);
});

test("scatter3d: bad specs come back with errors the model can act on", () => {
  const base = { kind: "scatter3d", title: "t" };
  const three = [1, 2, 3].map((n) => ({ x: n, y: n, z: n, label: `T${n}` }));
  assert.match(err({ ...base }), /needs points/);
  assert.match(err({ ...base, points: three.slice(0, 2) }), /at least 3/);
  assert.match(err({ ...base, points: [{ x: 1, y: 2 }, ...three] }), /points\[0\]\.z must be a number/);
  assert.match(err({ ...base, points: [{ x: 1, y: 2, z: null }, ...three] }), /points\[0\]\.z must be a number/);
  assert.match(err({ ...base, points: [{ x: 1, y: 2, z: 3, size: -1 }, ...three] }), /size must be above 0/);
  assert.match(err({ ...base, points: three, colorBy: "sector" }), /colorBy must be one of/);
  assert.match(err({ ...base, points: three, colorBy: "group" }), /needs a group/);
  assert.match(err({ ...base, points: three, colorBy: "value" }), /value on every point; points\[0\]/);
  assert.match(err({ ...base, points: three, highlight: ["MSFT"] }), /"MSFT" is not the label/);
  assert.match(err({ ...base, points: three, highlight: "T1" }), /list of point labels/);
  const tooManyHl = Array.from({ length: CHART_LIMITS.highlight + 1 }, () => "T1");
  assert.match(err({ ...base, points: three, highlight: tooManyHl }), /At most 12 highlighted/);
  const many = Array.from({ length: CHART_LIMITS.points3d + 1 }, (_, i) => ({ x: i, y: i, z: i }));
  assert.match(err({ ...base, points: many }), /2001 points; at most 2000/);
  const groups = Array.from({ length: CHART_LIMITS.groups + 1 }, (_, i) => ({ x: i, y: i, z: i, group: `G${i}` }));
  assert.match(err({ ...base, points: groups }), /13 groups; at most 12/);
  const max = Array.from({ length: CHART_LIMITS.points3d }, (_, i) => ({ x: i, y: i % 7, z: i % 13, group: `G${i % CHART_LIMITS.groups}` }));
  assert.equal(ok({ ...base, points: max }).points!.length, CHART_LIMITS.points3d);
});

test("scatter3d through the tool: a short summary and its command row", async () => {
  const pts = Array.from({ length: 300 }, (_, i) => ({ x: i, y: i * 2, z: i % 9, label: `T${i}`, group: `G${i % 12}` }));
  const r = await runChartTool({ kind: "scatter3d", title: "Many", points: pts });
  assert.equal(r.ok, true);
  assert.equal(r.chart?.points?.length, 300);
  assert.ok(r.content.length < 900, `${r.content.length}`);
  assert.equal(deskToolCommand("show_chart", { kind: "scatter3d", title: "Semis: IV vs return" }).cmd, '/chart scatter3d "Semis: IV vs return"');
  assert.ok("points" in CHART_TOOL.input_schema.properties);
});
