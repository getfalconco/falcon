/**
 * Charts the Desk AI draws inside its answers (the `show_chart` tool,
 * lib/desk/tools/chart.ts). This file is pure, with no server imports: the
 * route validates the model's input with it, and the client (lab/sessions.ts)
 * re-checks a spec read back from session storage with the same function.
 *
 * A spec that passes `normalizeChart` comes back in the same shape, so
 * normalizing twice is a no-op (stored specs re-validate as they are).
 *
 *   2D (line | area | bar | scatter): series [{ name, points: [[x, y], ...] }]
 *     x: "YYYY-MM-DD" dates, numbers, or short category labels (one kind per chart)
 *   candlestick: one series, points [[date, open, high, low, close], ...]
 *   surface3d: grid { x: number[], y: number[], z: (number|null)[][] }, z[i][j] at (x[j], y[i])
 *   scatter3d: points [{ x, y, z, label?, group?, size?, value? }] (or series of
 *     points, each series' name becoming the points' group), colorBy, highlight
 */

export const CHART_KINDS = ["line", "area", "bar", "scatter", "candlestick", "surface3d", "scatter3d"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** Caps: what a chat-width chart can show, and what fits in session storage. */
export const CHART_LIMITS = {
  series: 8,
  /** All 2D points of a chart together. */
  points: 5_000,
  candles: 600,
  /** Cells per side of a surface grid. */
  grid: 120,
  /** scatter3d: points, groups (colours), point and group label length, highlighted labels. */
  points3d: 2_000,
  groups: 12,
  pointLabel: 24,
  highlight: 12,
  title: 120,
  subtitle: 200,
  label: 60,
  unit: 16,
  category: 40,
  source: 160,
} as const;

export type ChartAxis = { label?: string; unit?: string };
export type ChartX = string | number;
export type ChartPoint = [ChartX, number | null];
export type ChartCandle = [string, number, number, number, number];
export type ChartSeries = { name: string; points: ChartPoint[] | ChartCandle[] };
export type ChartGrid = { x: number[]; y: number[]; z: (number | null)[][] };
/** A scatter3d point. `size` is a relative weight (e.g. market cap); `value` feeds colorBy "value". */
export type ChartPoint3D = { x: number; y: number; z: number; label?: string; group?: string; size?: number; value?: number };
export const COLOR_BY = ["group", "z", "value"] as const;
export type ChartColorBy = (typeof COLOR_BY)[number];

export type ChartSpec = {
  kind: ChartKind;
  title: string;
  subtitle?: string;
  /** Where the numbers came from, e.g. "Databento, end of day" or "Falcon backtest, 2015-2025". */
  source?: string;
  axes?: { x?: ChartAxis; y?: ChartAxis; z?: ChartAxis };
  /** 2D charts and candlestick. */
  series?: ChartSeries[];
  /** surface3d. */
  grid?: ChartGrid;
  /** scatter3d: the points, how they are coloured, and labels always shown. */
  points?: ChartPoint3D[];
  colorBy?: ChartColorBy;
  highlight?: string[];
  /** scatter3d with colorBy "value": what the value is (legend title and tooltip). */
  value?: ChartAxis;
};

export type ChartResult = { ok: true; spec: ChartSpec } | { ok: false; error: string };

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class SpecError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function text(v: unknown, max: number, what: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new SpecError(`${what} is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new SpecError(`${what} must be text.`);
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) {
    if (required) throw new SpecError(`${what} is required.`);
    return undefined;
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function axis(v: unknown, what: string): ChartAxis | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new SpecError(`${what} must be { label, unit }.`);
  const label = text(v.label, CHART_LIMITS.label, `${what}.label`);
  const unit = text(v.unit, CHART_LIMITS.unit, `${what}.unit`);
  if (!label && !unit) return undefined;
  return { ...(label ? { label } : {}), ...(unit ? { unit } : {}) };
}

/** A y value: a finite number, or null for a gap. Numeric strings are accepted ("1.25"). */
function yValue(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (finite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  throw new SpecError(`${where} must be a number or null.`);
}

function xValue(v: unknown, where: string): ChartX {
  if (finite(v)) return v;
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, CHART_LIMITS.category);
  throw new SpecError(`${where} must be a date "YYYY-MM-DD", a number or a short label.`);
}

export type XKind = "time" | "number" | "category";

/** What the x values of a chart are: all dates, all numbers, or labels. */
export function xKind(series: ChartSeries[]): XKind {
  let dates = true;
  let nums = true;
  for (const s of series)
    for (const p of s.points) {
      const x = p[0];
      if (typeof x !== "number") nums = false;
      if (typeof x !== "string" || !DATE_RE.test(x)) dates = false;
      if (!dates && !nums) return "category";
    }
  return dates ? "time" : nums ? "number" : "category";
}

function points2d(v: unknown, where: string): ChartPoint[] {
  if (!Array.isArray(v)) throw new SpecError(`${where} must be a list of [x, y] pairs.`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2) throw new SpecError(`${where}[${i}] must be an [x, y] pair.`);
    return [xValue(p[0], `${where}[${i}][0]`), yValue(p[1], `${where}[${i}][1]`)];
  });
}

function candles(v: unknown, where: string): ChartCandle[] {
  if (!Array.isArray(v)) throw new SpecError(`${where} must be a list of [date, open, high, low, close].`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length < 5 || typeof p[0] !== "string" || !DATE_RE.test(p[0])) throw new SpecError(`${where}[${i}] must be [date "YYYY-MM-DD", open, high, low, close].`);
    const [o, h, l, c] = [1, 2, 3, 4].map((k) => yValue(p[k], `${where}[${i}][${k}]`));
    if (o === null || h === null || l === null || c === null) throw new SpecError(`${where}[${i}] needs all four prices.`);
    return [p[0], o, Math.max(h, l, o, c), Math.min(h, l, o, c), c];
  });
}

function grid(v: unknown): ChartGrid {
  if (!isObj(v)) throw new SpecError("surface3d needs grid { x: number[], y: number[], z: number[][] }.");
  const axisValues = (a: unknown, name: "x" | "y") => {
    if (!Array.isArray(a) || a.length < 2) throw new SpecError(`grid.${name} needs at least 2 numbers.`);
    if (a.length > CHART_LIMITS.grid) throw new SpecError(`grid.${name} has ${a.length} values; at most ${CHART_LIMITS.grid}. Use a coarser grid.`);
    const out = a.map((n, i) => {
      const x = yValue(n, `grid.${name}[${i}]`);
      if (x === null) throw new SpecError(`grid.${name}[${i}] must be a number.`);
      return x;
    });
    for (let i = 1; i < out.length; i++) if (!(out[i]! > out[i - 1]!)) throw new SpecError(`grid.${name} must be strictly increasing (sort it, and the matching z, ascending).`);
    return out;
  };
  const x = axisValues(v.x, "x");
  const y = axisValues(v.y, "y");
  if (!Array.isArray(v.z) || v.z.length !== y.length) throw new SpecError(`grid.z must have one row per y value (${y.length} rows); z[i][j] is the value at y[i], x[j].`);
  let count = 0;
  const z = v.z.map((row, i) => {
    if (!Array.isArray(row) || row.length !== x.length) throw new SpecError(`grid.z[${i}] must have one value per x value (${x.length}).`);
    return row.map((n, j) => {
      const val = yValue(n, `grid.z[${i}][${j}]`);
      if (val !== null) count++;
      return val;
    });
  });
  if (count < 4) throw new SpecError("grid.z needs at least 4 numbers.");
  return { x, y, z };
}

function num(v: unknown, where: string): number {
  const n = yValue(v, where);
  if (n === null) throw new SpecError(`${where} must be a number.`);
  return n;
}

/** One scatter3d point: { x, y, z, label?, group?, size?, value? } or [x, y, z, label?]. */
function point3d(p: unknown, where: string, group?: string): ChartPoint3D {
  if (Array.isArray(p)) {
    if (p.length < 3) throw new SpecError(`${where} must be { x, y, z } (or [x, y, z, label]).`);
    p = { x: p[0], y: p[1], z: p[2], label: p[3] };
  }
  if (!isObj(p)) throw new SpecError(`${where} must be { x, y, z, label?, group?, size?, value? }.`);
  const out: ChartPoint3D = { x: num(p.x, `${where}.x`), y: num(p.y, `${where}.y`), z: num(p.z, `${where}.z`) };
  const label = text(p.label, CHART_LIMITS.pointLabel, `${where}.label`);
  const g = group ?? text(p.group, CHART_LIMITS.pointLabel, `${where}.group`);
  if (label) out.label = label;
  if (g) out.group = g;
  if (p.size !== undefined && p.size !== null) {
    const size = num(p.size, `${where}.size`);
    if (!(size > 0)) throw new SpecError(`${where}.size must be above 0 (a relative weight, e.g. market cap).`);
    out.size = size;
  }
  if (p.value !== undefined && p.value !== null) out.value = num(p.value, `${where}.value`);
  return out;
}

function scatter3d(input: Record<string, unknown>, spec: ChartSpec): void {
  let points: ChartPoint3D[];
  if (Array.isArray(input.points)) {
    points = input.points.map((p, i) => point3d(p, `points[${i}]`));
  } else if (Array.isArray(input.series) && input.series.length) {
    // Series are groups: each series' name becomes its points' group.
    points = input.series.flatMap((s, i) => {
      if (!isObj(s) || !Array.isArray(s.points)) throw new SpecError(`series[${i}] must be { name, points: [{ x, y, z, label? }, ...] }.`);
      const name = text(s.name, CHART_LIMITS.pointLabel, `series[${i}].name`) ?? `Group ${i + 1}`;
      return s.points.map((p, j) => point3d(p, `series[${i}].points[${j}]`, name));
    });
  } else {
    throw new SpecError("scatter3d needs points: [{ x, y, z, label?, group?, size?, value? }].");
  }
  if (points.length < 3) throw new SpecError("scatter3d needs at least 3 points.");
  if (points.length > CHART_LIMITS.points3d) throw new SpecError(`${points.length} points; at most ${CHART_LIMITS.points3d} in a 3D scatter. Filter (e.g. the most liquid names) or sample.`);
  // Points without a group join "Other" once any point has one.
  if (points.some((p) => p.group)) for (const p of points) p.group ??= "Other";
  const groups = new Set(points.flatMap((p) => (p.group ? [p.group] : [])));
  if (groups.size > CHART_LIMITS.groups) throw new SpecError(`${groups.size} groups; at most ${CHART_LIMITS.groups} (one colour each). Merge the small ones into "Other".`);

  let colorBy: ChartColorBy;
  if (input.colorBy === undefined || input.colorBy === null || input.colorBy === "") {
    colorBy = groups.size > 1 ? "group" : points.every((p) => p.value !== undefined) ? "value" : "z";
  } else if (typeof input.colorBy === "string" && (COLOR_BY as readonly string[]).includes(input.colorBy)) {
    colorBy = input.colorBy as ChartColorBy;
  } else {
    throw new SpecError(`colorBy must be one of ${COLOR_BY.join(", ")}.`);
  }
  if (colorBy === "group" && groups.size < 1) throw new SpecError('colorBy "group" needs a group on the points (or series named by group).');
  if (colorBy === "value") {
    const missing = points.findIndex((p) => p.value === undefined);
    if (missing >= 0) throw new SpecError(`colorBy "value" needs a numeric value on every point; points[${missing}] has none.`);
    const v = axis(input.value, "value");
    if (v) spec.value = v;
  }
  spec.colorBy = colorBy;

  if (input.highlight !== undefined && input.highlight !== null) {
    if (!Array.isArray(input.highlight)) throw new SpecError("highlight must be a list of point labels.");
    if (input.highlight.length > CHART_LIMITS.highlight) throw new SpecError(`At most ${CHART_LIMITS.highlight} highlighted labels (keep the chart readable).`);
    const byKey = new Map(points.flatMap((p) => (p.label ? [[p.label.toUpperCase(), p.label] as const] : [])));
    const kept = new Set<string>();
    input.highlight.forEach((h, i) => {
      const t = text(h, CHART_LIMITS.pointLabel, `highlight[${i}]`);
      if (!t) return;
      const match = byKey.get(t.toUpperCase());
      if (!match) throw new SpecError(`highlight[${i}] "${t}" is not the label of any point.`);
      kept.add(match);
    });
    if (kept.size) spec.highlight = Array.from(kept);
  }
  spec.points = points;
}

/**
 * Checks a chart spec and returns it cleaned (text trimmed and clipped, numeric
 * strings read as numbers, candles' high/low made consistent), or a short error
 * the model can act on. Never throws.
 */
export function normalizeChart(input: unknown): ChartResult {
  try {
    if (!isObj(input)) throw new SpecError("The chart must be an object.");
    const kind = input.kind;
    if (typeof kind !== "string" || !(CHART_KINDS as readonly string[]).includes(kind)) throw new SpecError(`kind must be one of ${CHART_KINDS.join(", ")}.`);
    const k = kind as ChartKind;
    const spec: ChartSpec = { kind: k, title: text(input.title, CHART_LIMITS.title, "title", true)! };
    const subtitle = text(input.subtitle, CHART_LIMITS.subtitle, "subtitle");
    const source = text(input.source, CHART_LIMITS.source, "source");
    if (subtitle) spec.subtitle = subtitle;
    if (source) spec.source = source;
    const a = isObj(input.axes) ? input.axes : {};
    const axes = { x: axis(a.x, "axes.x"), y: axis(a.y, "axes.y"), z: axis(a.z, "axes.z") };
    const kept = Object.fromEntries(Object.entries(axes).filter(([, v]) => v)) as ChartSpec["axes"];
    if (kept && Object.keys(kept).length) spec.axes = kept;

    if (k === "surface3d") {
      spec.grid = grid(input.grid);
      return { ok: true, spec };
    }
    if (k === "scatter3d") {
      scatter3d(input, spec);
      return { ok: true, spec };
    }
    if (!Array.isArray(input.series) || !input.series.length) throw new SpecError("series is required: [{ name, points }].");
    if (input.series.length > CHART_LIMITS.series) throw new SpecError(`At most ${CHART_LIMITS.series} series in one chart.`);
    if (k === "candlestick" && input.series.length !== 1) throw new SpecError("A candlestick chart has exactly one series.");
    let total = 0;
    spec.series = input.series.map((s, i) => {
      if (!isObj(s)) throw new SpecError(`series[${i}] must be { name, points }.`);
      const name = text(s.name, CHART_LIMITS.label, `series[${i}].name`) ?? `Series ${i + 1}`;
      const points = k === "candlestick" ? candles(s.points, `series[${i}].points`) : points2d(s.points, `series[${i}].points`);
      if (!points.length) throw new SpecError(`series[${i}].points is empty.`);
      total += points.length;
      return { name, points };
    });
    if (k === "candlestick" && total > CHART_LIMITS.candles) throw new SpecError(`At most ${CHART_LIMITS.candles} candles; use weekly or monthly bars.`);
    if (total > CHART_LIMITS.points) throw new SpecError(`${total} points; at most ${CHART_LIMITS.points} in one chart. Downsample (e.g. weekly closes).`);
    if (k !== "candlestick") {
      const xk = xKind(spec.series);
      if (k === "scatter" && xk === "category") throw new SpecError("A scatter chart needs numeric (or date) x values.");
      if (!spec.series.some((s) => (s.points as ChartPoint[]).some((p) => p[1] !== null))) throw new SpecError("Every y value is null.");
      // Time and number axes read left to right: sort by x (category order is the model's).
      if (xk !== "category") {
        for (const s of spec.series) (s.points as ChartPoint[]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
      }
    } else {
      (spec.series[0]!.points as ChartCandle[]).sort((p, q) => (p[0] < q[0] ? -1 : 1));
    }
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, error: e instanceof SpecError ? e.message : "The chart could not be read." };
  }
}

/** A short description for screen readers and the model's tool result. */
export function describeChart(spec: ChartSpec): string {
  if (spec.kind === "surface3d" && spec.grid) {
    const g = spec.grid;
    let best: { v: number; x: number; y: number } | null = null;
    let worst: { v: number; x: number; y: number } | null = null;
    g.z.forEach((row, i) =>
      row.forEach((v, j) => {
        if (v === null) return;
        if (!best || v > best.v) best = { v, x: g.x[j]!, y: g.y[i]! };
        if (!worst || v < worst.v) worst = { v, x: g.x[j]!, y: g.y[i]! };
      }),
    );
    const xl = spec.axes?.x?.label ?? "x";
    const yl = spec.axes?.y?.label ?? "y";
    const zl = spec.axes?.z?.label ?? "value";
    const b = best as { v: number; x: number; y: number } | null;
    const w = worst as { v: number; x: number; y: number } | null;
    return `3D surface of ${zl} over ${xl} (${g.x.length} values) and ${yl} (${g.y.length} values)${b && w ? `; highest ${round(b.v)} at ${xl} ${b.x}, ${yl} ${b.y}; lowest ${round(w.v)} at ${xl} ${w.x}, ${yl} ${w.y}` : ""}.`;
  }
  if (spec.kind === "scatter3d" && spec.points) return describeScatter3d(spec, spec.points);
  const series = spec.series ?? [];
  const parts = series.map((s) => {
    if (spec.kind === "candlestick") {
      const c = s.points as ChartCandle[];
      return `${s.name}: ${c.length} candles, ${c[0]?.[0]} close ${round(c[0]?.[4])} to ${c[c.length - 1]?.[0]} close ${round(c[c.length - 1]?.[4])}`;
    }
    const p = (s.points as ChartPoint[]).filter((q) => q[1] !== null);
    const first = p[0];
    const last = p[p.length - 1];
    return `${s.name}: ${p.length} points${first && last ? `, from ${first[1] === null ? "" : round(first[1])} at ${first[0]} to ${last[1] === null ? "" : round(last[1])} at ${last[0]}` : ""}`;
  });
  return `${spec.kind} chart. ${parts.join("; ")}.`;
}

function describeScatter3d(spec: ChartSpec, pts: ChartPoint3D[]): string {
  const name = (a: "x" | "y" | "z", d: string) => spec.axes?.[a]?.label ?? d;
  const range = (a: "x" | "y" | "z") => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) (lo = Math.min(lo, p[a])), (hi = Math.max(hi, p[a]));
    return `${name(a, a)} ${round(lo)} to ${round(hi)}`;
  };
  const counts = new Map<string, number>();
  for (const p of pts) if (p.group) counts.set(p.group, (counts.get(p.group) ?? 0) + 1);
  const groups = counts.size ? ` in ${counts.size} group${counts.size > 1 ? "s" : ""} (${Array.from(counts, ([g, n]) => `${g} ${n}`).join(", ")})` : "";
  const at = (p: ChartPoint3D) => `${p.label ? `${p.label} ` : ""}${round(p.z)}`;
  let top = pts[0]!;
  let low = pts[0]!;
  for (const p of pts) {
    if (p.z > top.z) top = p;
    if (p.z < low.z) low = p;
  }
  const by = spec.colorBy === "value" ? (spec.value?.label ?? "value") : spec.colorBy === "z" ? name("z", "z") : "group";
  return `3D scatter of ${pts.length} points${groups}; ${range("x")}, ${range("y")}, ${range("z")}; highest ${name("z", "z")}: ${at(top)}, lowest: ${at(low)}; coloured by ${by}.`;
}

function round(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(2) : a >= 1 ? v.toFixed(3) : v.toPrecision(3);
}
