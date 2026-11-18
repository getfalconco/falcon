"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { describeChart, type ChartPoint3D, type ChartSpec } from "@/lib/desk/chart-spec";
import { MONO } from "../parts";
import { observeSettledSize } from "../shell/resize";
import { fmtValue } from "./Chart2D";
import { useCalmMotion } from "./motion";
import { ColorScale, HEIGHT, HoverCard, HoverRow, ViewBox, addAxes, colorAt, createView, groupColors, niceTicks, token, webgl, type ViewApi } from "./three-scene";

/**
 * An interactive 3D scatter (show_chart kind "scatter3d"): up to 2,000 points
 * drawn in one call (an InstancedMesh of shaded spheres, so nearer points are
 * bigger and a little fog keeps far ones quieter), coloured by group (the app's
 * categorical colours) or on viridis by z or a value. Hover (picked in screen
 * space, nearest to the camera first) shows the point's label and numbers with
 * a halo and a drop line to the floor; highlighted labels stay on, hidden when
 * they would overlap; the legend's groups toggle. Same view, axes, keys and
 * Reset view as the surface (lab/three-scene.tsx). Without WebGL: x against y
 * in 2D, coloured by z.
 */

type Hover = { i: number; left: number; top: number };
type Range = { lo: number; hi: number };

function range(pts: ChartPoint3D[], get: (p: ChartPoint3D) => number, pad = 0.04): Range & { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) (min = Math.min(min, get(p))), (max = Math.max(max, get(p)));
  const span = max - min || Math.abs(max) || 1;
  return { min, max, lo: min - span * pad, hi: max + span * pad };
}

/** Point radius in world units: smaller as the cloud grows; `size` scales it by area. */
function radii(pts: ChartPoint3D[]): Float32Array {
  const n = pts.length;
  const base = n <= 40 ? 0.05 : n <= 150 ? 0.04 : n <= 600 ? 0.031 : 0.024;
  let maxSize = 0;
  for (const p of pts) if (p.size) maxSize = Math.max(maxSize, p.size);
  return Float32Array.from(pts, (p) => (maxSize && p.size ? base * (0.55 + 1.15 * Math.sqrt(p.size / maxSize)) : maxSize ? base * 0.55 : base));
}

export default function Scatter3D({ spec, height = 340, animate = false }: { spec: ChartSpec; height?: number; animate?: boolean }) {
  const pts = spec.points!;
  const box = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const still = useCalmMotion();
  const stillRef = useRef(still);
  stillRef.current = still;
  const [grow] = useState(animate && !still);
  const [ok, setOk] = useState(true);
  const [hover, setHover] = useState<Hover | null>(null);
  const [palette, setPalette] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const hiddenRef = useRef(hidden);
  const api = useRef<ViewApi | null>(null);
  const refresh = useRef<(() => void) | null>(null);

  const colorBy = spec.colorBy ?? "z";
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pts) if (p.group) m.set(p.group, (m.get(p.group) ?? 0) + 1);
    return Array.from(m, ([name, count]) => ({ name, count }));
  }, [pts]);
  const groupIndex = useMemo(() => new Map(groups.map((g, i) => [g.name, i])), [groups]);
  const xr = useMemo(() => range(pts, (p) => p.x), [pts]);
  const yr = useMemo(() => range(pts, (p) => p.y), [pts]);
  const zr = useMemo(() => range(pts, (p) => p.z), [pts]);
  const vr = useMemo(() => (colorBy === "value" ? range(pts, (p) => p.value ?? 0, 0) : zr), [pts, colorBy, zr]);
  const colorOf = useMemo(() => (colorBy === "value" ? (p: ChartPoint3D) => p.value ?? 0 : (p: ChartPoint3D) => p.z), [colorBy]);
  const xLabel = spec.axes?.x?.label ?? "x";
  const yLabel = spec.axes?.y?.label ?? "y";
  const zLabel = spec.axes?.z?.label ?? "z";
  const valueLabel = spec.value?.label ?? "Value";

  useEffect(() => {
    const el = box.current;
    const overlay = labels.current;
    if (!el || !overlay) return;
    if (!webgl()) {
      setOk(false);
      return;
    }
    const view = createView(el, { height, damping: !stillRef.current });
    if (!view) {
      setOk(false);
      return;
    }
    const { scene, camera, request } = view;
    const n = pts.length;
    const world = (r: Range, v: number) => ((v - r.lo) / (r.hi - r.lo || 1)) * 2 - 1;
    const wx = (v: number) => world(xr, v);
    const wz = (v: number) => world(yr, v);
    const wh = (v: number) => ((v - zr.lo) / (zr.hi - zr.lo || 1)) * HEIGHT;
    const pos = new Float32Array(n * 3);
    pts.forEach((p, i) => {
      pos[i * 3] = wx(p.x);
      pos[i * 3 + 1] = wh(p.z);
      pos[i * 3 + 2] = wz(p.y);
    });
    const rad = radii(pts);

    // Every point in one draw call; per-instance colour and scale (0 = hidden group).
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshLambertMaterial(), n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const m = new THREE.Matrix4();
    let growT = grow ? 0 : 1;
    const growStart = performance.now();
    const place = () => {
      const off = hiddenRef.current;
      for (let i = 0; i < n; i++) {
        const g = pts[i]!.group;
        const s = g && off.has(g) ? 0 : rad[i]! * growT;
        m.makeScale(s, s, s).setPosition(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    place();

    const c = new THREE.Color();
    const paint = () => {
      const pal = groupColors(el);
      setPalette(pal);
      const span = vr.max - vr.min;
      for (let i = 0; i < n; i++) {
        const p = pts[i]!;
        if (colorBy === "group") c.set(pal[(groupIndex.get(p.group ?? "") ?? 0) % pal.length]!);
        else colorAt(span ? (colorOf(p) - vr.min) / span : 0.5, c);
        mesh.setColorAt(i, c);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };

    // Depth cue: a light fog in the panel's colour, from the near side of the box to past its far side.
    const fog = new THREE.Fog(0xffffff, 3, 8);
    scene.fog = fog;

    // Hover: a halo, a drop line to the floor and a cross where it lands.
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false, fog: false }));
    halo.visible = false;
    scene.add(halo);
    const dropGeom = new THREE.BufferGeometry();
    dropGeom.setAttribute("position", new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
    const dropMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45, fog: false });
    const drop = new THREE.LineSegments(dropGeom, dropMat);
    drop.visible = false;
    scene.add(drop);

    view.onTheme((t) => {
      fog.color.copy(token(el, "--f-surface", t.dark ? "#141414" : "#ffffff"));
      (halo.material as THREE.MeshBasicMaterial).color.copy(t.fore);
      dropMat.color.copy(t.fore);
      dropMat.opacity = t.dark ? 0.5 : 0.4;
      paint();
    });

    addAxes(
      view,
      overlay,
      { ticks: niceTicks(xr.lo, xr.hi, 5).filter((t) => t >= xr.lo && t <= xr.hi), world: wx, label: xLabel, unit: spec.axes?.x?.unit },
      { ticks: niceTicks(yr.lo, yr.hi, 5).filter((t) => t >= yr.lo && t <= yr.hi), world: wz, label: yLabel, unit: spec.axes?.y?.unit },
      { ticks: niceTicks(zr.lo, zr.hi, 6).filter((t) => t >= zr.lo - 1e-9 && t <= zr.hi + 1e-9), world: wh, label: zLabel, unit: spec.axes?.z?.unit },
    );

    // Highlighted labels: always on, nearest first; one that would overlap a placed one waits.
    const highlight = new Set(spec.highlight ?? []);
    const tags = pts.flatMap((p, i) => {
      if (!p.label || !highlight.has(p.label)) return [];
      const s = document.createElement("span");
      s.textContent = p.label;
      s.className = "pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded bg-surface/80 px-1 text-[10.5px] font-medium leading-[15px] text-fore-3";
      s.style.fontFamily = MONO;
      overlay.appendChild(s);
      return [{ i, el: s, w: 0 }];
    });
    const v = new THREE.Vector3();
    const pxPerUnit = (i: number) => {
      const d = v.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!).distanceTo(camera.position);
      return view.size().h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * d);
    };

    let hovered = -1;
    view.onFrame((now) => {
      const dist = camera.position.distanceTo(view.controls.target);
      fog.near = Math.max(0.5, dist - 0.4);
      fog.far = dist + 5.5;
      let again = false;
      if (grow && growT < 1) {
        growT = Math.min(1, (now - growStart) / 700);
        growT = 1 - (1 - growT) ** 3;
        place();
        again = growT < 1;
      }
      if (tags.length) {
        const { w, h } = view.size();
        const order = tags
          .map((t) => ({ t, d: v.set(pos[t.i * 3]!, pos[t.i * 3 + 1]!, pos[t.i * 3 + 2]!).distanceToSquared(camera.position) }))
          .sort((a, b) => a.d - b.d);
        const placed: { l: number; r: number; t: number; b: number }[] = [];
        for (const { t } of order) {
          const g = pts[t.i]!.group;
          const p = view.toScreen(v.set(pos[t.i * 3]!, pos[t.i * 3 + 1]!, pos[t.i * 3 + 2]!));
          if (!t.w) t.w = t.el.offsetWidth;
          const rr = rad[t.i]! * growT * pxPerUnit(t.i);
          const box2 = { l: p.x - t.w / 2, r: p.x + t.w / 2, t: p.y - rr - 19, b: p.y - rr - 3 };
          const clash = placed.some((q) => box2.l < q.r + 2 && box2.r > q.l - 2 && box2.t < q.b + 1 && box2.b > q.t - 1);
          const show = p.front && !(g && hiddenRef.current.has(g)) && t.i !== hovered && !clash && box2.l >= 0 && box2.r <= w && box2.t >= 0 && box2.b <= h;
          t.el.style.visibility = show ? "visible" : "hidden";
          if (show) {
            placed.push(box2);
            t.el.style.transform = `translate(${box2.l.toFixed(1)}px, ${box2.t.toFixed(1)}px)`;
          }
        }
      }
      return again;
    });

    const show = (i: number) => {
      hovered = i;
      if (i < 0) {
        if (halo.visible) {
          halo.visible = false;
          drop.visible = false;
          request();
        }
        return;
      }
      const [x, y, z] = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
      halo.position.set(x, y, z);
      halo.scale.setScalar(rad[i]! * 1.9);
      halo.visible = true;
      const a = dropGeom.getAttribute("position") as THREE.BufferAttribute;
      const k = 0.05;
      a.setXYZ(0, x, y - rad[i]!, z);
      a.setXYZ(1, x, 0, z);
      a.setXYZ(2, x - k, 0, z);
      a.setXYZ(3, x + k, 0, z);
      a.setXYZ(4, x, 0, z - k);
      a.setXYZ(5, x, 0, z + k);
      a.needsUpdate = true;
      drop.visible = true;
      request();
    };

    // Picking in screen space: every visible point within its drawn radius (+5 px), the nearest to the camera wins. O(n) per move, at most once a frame.
    view.onHover((at) => {
      if (!at || at.dragging) {
        show(-1);
        setHover(null);
        return;
      }
      const off = hiddenRef.current;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const g = pts[i]!.group;
        if (g && off.has(g)) continue;
        v.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
        const d = v.distanceToSquared(camera.position);
        if (d >= bestD) continue;
        const p = view.toScreen(v);
        if (!p.front) continue;
        const r = rad[i]! * pxPerUnit(i) + 5;
        if ((p.x - at.x) ** 2 + (p.y - at.y) ** 2 <= r * r) {
          best = i;
          bestD = d;
        }
      }
      show(best);
      setHover(best < 0 ? null : { i: best, left: at.x, top: at.y });
    });

    api.current = view.api;
    refresh.current = () => {
      place();
      if (hovered >= 0 && pts[hovered]!.group && hiddenRef.current.has(pts[hovered]!.group!)) {
        show(-1);
        setHover(null);
      }
      request();
    };
    request();

    return () => {
      api.current = null;
      refresh.current = null;
      view.dispose();
      overlay.replaceChildren();
    };
    // The spec of a drawn chart never changes (ChartBlock keeps the first one per tool call).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, height]);

  useEffect(() => {
    hiddenRef.current = hidden;
    refresh.current?.();
  }, [hidden]);

  const toggle = (name: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const legend = (
    <>
      {groups.length > 1 || colorBy === "group" ? (
        <GroupLegend groups={groups} colors={colorBy === "group" ? palette : null} hidden={hidden} toggle={toggle} showAll={() => setHidden(new Set())} />
      ) : null}
      {colorBy !== "group" ? <ColorScale min={vr.min} max={vr.max} unit={colorBy === "value" ? spec.value?.unit : spec.axes?.z?.unit} label={colorBy === "value" ? valueLabel : zLabel} /> : null}
    </>
  );

  if (!ok) return <Flat spec={spec} height={height} legend={legend} hidden={hidden} />;

  const hp = hover ? pts[hover.i] : undefined;
  return (
    <div className="flex flex-col gap-2.5">
      <ViewBox boxRef={box} labelsRef={labels} api={api} height={height} label={`${spec.title}. ${describeChart(spec)}`}>
        {hover && hp ? (
          <HoverCard left={hover.left} top={hover.top} boxWidth={box.current?.clientWidth ?? 0}>
            {hp.label ? <span className="col-span-2 mb-0.5 font-medium text-fore" style={{ fontFamily: MONO }}>{hp.label}</span> : null}
            {hp.group ? <HoverRow name="Group" value={hp.group} mono={false} /> : null}
            <HoverRow name={xLabel} value={fmtValue(hp.x, spec.axes?.x?.unit)} />
            <HoverRow name={yLabel} value={fmtValue(hp.y, spec.axes?.y?.unit)} />
            <HoverRow name={zLabel} value={fmtValue(hp.z, spec.axes?.z?.unit)} strong={colorBy === "z"} />
            {hp.value !== undefined ? <HoverRow name={valueLabel} value={fmtValue(hp.value, spec.value?.unit)} strong={colorBy === "value"} /> : null}
          </HoverCard>
        ) : null}
      </ViewBox>
      {legend}
    </div>
  );
}

/** Groups as toggles: swatch (when colour means group), name and count; a hidden group is struck through. */
function GroupLegend({
  groups,
  colors,
  hidden,
  toggle,
  showAll,
}: {
  groups: { name: string; count: number }[];
  colors: string[] | null;
  hidden: ReadonlySet<string>;
  toggle: (name: string) => void;
  showAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Groups: click to show or hide">
      {groups.map((g, i) => {
        const off = hidden.has(g.name);
        const color = colors?.[i % Math.max(1, colors.length)];
        return (
          <button
            key={g.name}
            type="button"
            aria-pressed={!off}
            onClick={() => toggle(g.name)}
            title={off ? `Show ${g.name}` : `Hide ${g.name}`}
            className={`inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-fs-12 outline-none transition-colors hover:bg-line/[0.05] focus-visible:ring-2 focus-visible:ring-line/20 ${off ? "text-faint line-through" : "text-fore-4"}`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={color ? { background: off ? "transparent" : color, boxShadow: `inset 0 0 0 1.5px ${color}` } : { boxShadow: "inset 0 0 0 1.5px currentColor" }}
              aria-hidden
            />
            <span className="max-w-[180px] truncate">{g.name}</span>
            <span className="tabular-nums text-faint">{g.count}</span>
          </button>
        );
      })}
      {hidden.size ? (
        <button type="button" onClick={showAll} className="h-6 rounded-md px-1.5 text-fs-12 text-quiet underline-offset-2 outline-none hover:text-fore hover:underline focus-visible:ring-2 focus-visible:ring-line/20">
          Show all
        </button>
      ) : null}
    </div>
  );
}

/** Without WebGL: x against y, coloured by z (or the value), in SVG. */
function Flat({ spec, height, legend, hidden }: { spec: ChartSpec; height: number; legend: ReactNode; hidden: ReadonlySet<string> }) {
  const all = spec.points!;
  const pts = all.filter((p) => !p.group || !hidden.has(p.group));
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => (wrap.current ? observeSettledSize(wrap.current, (r) => setW(Math.max(200, Math.floor(r.width)))) : undefined), []);
  const H = height - 40;
  const P = { l: 52, r: 12, t: 10, b: 28 };
  const xr = range(all, (p) => p.x);
  const yr = range(all, (p) => p.y);
  const byValue = spec.colorBy === "value";
  const cr = range(all, (p) => (byValue ? (p.value ?? 0) : p.z), 0);
  const sx = (v: number) => P.l + ((v - xr.lo) / (xr.hi - xr.lo || 1)) * (W - P.l - P.r);
  const sy = (v: number) => H - P.b - ((v - yr.lo) / (yr.hi - yr.lo || 1)) * (H - P.t - P.b);
  const c = new THREE.Color();
  const xt = niceTicks(xr.lo, xr.hi, 5).filter((t) => t >= xr.lo && t <= xr.hi);
  const yt = niceTicks(yr.lo, yr.hi, 4).filter((t) => t >= yr.lo && t <= yr.hi);
  return (
    <div ref={wrap} className="flex flex-col gap-2.5">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${spec.title}. ${describeChart(spec)}`} className="text-faint">
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={0.25} />
            <text x={P.l - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize={10.5} fill="currentColor" style={{ fontFamily: MONO }}>
              {fmtValue(t, spec.axes?.y?.unit, undefined, true)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - P.b + 16} textAnchor="middle" fontSize={10.5} fill="currentColor" style={{ fontFamily: MONO }}>
            {fmtValue(t, spec.axes?.x?.unit, undefined, true)}
          </text>
        ))}
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={4.5} stroke="rgb(var(--f-surface))" strokeWidth={1} fill={`#${colorAt(cr.max > cr.min ? ((byValue ? (p.value ?? 0) : p.z) - cr.min) / (cr.max - cr.min) : 0.5, c).getHexString()}`} fillOpacity={0.9}>
            <title>{`${p.label ? `${p.label}: ` : ""}${fmtValue(p.x, spec.axes?.x?.unit)}, ${fmtValue(p.y, spec.axes?.y?.unit)}, ${fmtValue(p.z, spec.axes?.z?.unit)}`}</title>
          </circle>
        ))}
      </svg>
      <p className="text-fs-11.5 text-faint">
        3D view needs WebGL; shown as {spec.axes?.x?.label ?? "x"} across and {spec.axes?.y?.label ?? "y"} up, coloured by {byValue ? (spec.value?.label ?? "value") : (spec.axes?.z?.label ?? "z")}.
      </p>
      {spec.colorBy === "group" ? <ColorScale min={cr.min} max={cr.max} unit={spec.axes?.z?.unit} label={spec.axes?.z?.label ?? "z"} /> : null}
      {legend}
    </div>
  );
}
