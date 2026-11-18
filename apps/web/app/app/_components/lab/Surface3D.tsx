"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { describeChart, type ChartSpec } from "@/lib/desk/chart-spec";
import { fmtValue } from "./Chart2D";
import { useCalmMotion } from "./motion";
import { ColorScale, HEIGHT, HoverCard, HoverRow, ViewBox, addAxes, colorAt, createView, niceTicks, webgl, type ViewApi } from "./three-scene";

/**
 * An interactive 3D surface (show_chart kind "surface3d") in plain three.js:
 * drag to rotate, pinch or ctrl/cmd + scroll to zoom (plain scroll zooms once
 * the chart was clicked, so the thread still scrolls past it), hover reads
 * x / y / z, arrow keys rotate and +/- zoom, "Reset view" puts the camera
 * back. Renders on demand (no loop while nothing moves). Loaded on its own
 * (next/dynamic in lab/ChartBlock.tsx), so three.js only downloads with the
 * first surface. Without WebGL it falls back to a heatmap. The view, axes and
 * legend are shared with the 3D scatter (lab/three-scene.tsx).
 */

type Hover = { i: number; j: number; left: number; top: number };

export default function Surface3D({ spec, height = 340, animate = false }: { spec: ChartSpec; height?: number; animate?: boolean }) {
  const g = spec.grid!;
  const box = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const still = useCalmMotion();
  const stillRef = useRef(still);
  stillRef.current = still;
  const [grow] = useState(animate && !still);
  const [ok, setOk] = useState(true);
  const [hover, setHover] = useState<Hover | null>(null);
  const api = useRef<ViewApi | null>(null);

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const row of g.z) for (const v of row) if (v !== null) (zMin = Math.min(zMin, v)), (zMax = Math.max(zMax, v));
  const zUnit = spec.axes?.z?.unit;
  const xLabel = spec.axes?.x?.label ?? "x";
  const yLabel = spec.axes?.y?.label ?? "y";
  const zLabel = spec.axes?.z?.label ?? "value";

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
    const nx = g.x.length;
    const ny = g.y.length;
    const x0 = g.x[0]!;
    const x1 = g.x[nx - 1]!;
    const y0 = g.y[0]!;
    const y1 = g.y[ny - 1]!;
    const lo = Number.isFinite(zMin) ? zMin : 0;
    const hi = Number.isFinite(zMax) ? zMax : 1;
    const wx = (v: number) => ((v - x0) / (x1 - x0 || 1)) * 2 - 1;
    const wz = (v: number) => ((v - y0) / (y1 - y0 || 1)) * 2 - 1;
    const wh = (v: number) => (hi === lo ? HEIGHT / 2 : ((v - lo) / (hi - lo)) * HEIGHT);

    // The surface: one vertex per cell, triangles only where all their corners have a value.
    const positions = new Float32Array(nx * ny * 3);
    const colors = new Float32Array(nx * ny * 3);
    const c = new THREE.Color();
    for (let i = 0; i < ny; i++)
      for (let j = 0; j < nx; j++) {
        const k = i * nx + j;
        const v = g.z[i]![j];
        positions[k * 3] = wx(g.x[j]!);
        positions[k * 3 + 1] = v === null || v === undefined ? 0 : wh(v);
        positions[k * 3 + 2] = wz(g.y[i]!);
        colorAt(v === null || v === undefined || hi === lo ? 0.5 : (v - lo) / (hi - lo), c);
        colors[k * 3] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;
      }
    const has = (i: number, j: number) => g.z[i]![j] !== null && g.z[i]![j] !== undefined;
    const index: number[] = [];
    for (let i = 0; i < ny - 1; i++)
      for (let j = 0; j < nx - 1; j++) {
        const a = i * nx + j;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        const tri = (p: number, q: number, r: number, ok3: boolean) => ok3 && index.push(p, q, r);
        if (has(i, j) && has(i, j + 1) && has(i + 1, j) && has(i + 1, j + 1)) {
          index.push(a, d, b, b, d, e);
        } else {
          tri(a, d, b, has(i, j) && has(i + 1, j) && has(i, j + 1));
          tri(b, d, e, has(i, j + 1) && has(i + 1, j) && has(i + 1, j + 1));
        }
      }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.setIndex(index);
    geom.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);

    // Grid lines over the surface (at most ~24 each way).
    const wire: number[] = [];
    const strideJ = Math.max(1, Math.ceil(nx / 24));
    const strideI = Math.max(1, Math.ceil(ny / 24));
    const vtx = (i: number, j: number) => [positions[(i * nx + j) * 3]!, positions[(i * nx + j) * 3 + 1]!, positions[(i * nx + j) * 3 + 2]!];
    const every = (n: number, stride: number) => {
      const out: number[] = [];
      for (let k = 0; k < n; k += stride) out.push(k);
      if (out[out.length - 1] !== n - 1) out.push(n - 1);
      return out;
    };
    for (const i of every(ny, strideI)) for (let j = 0; j < nx - 1; j++) if (has(i, j) && has(i, j + 1)) wire.push(...vtx(i, j), ...vtx(i, j + 1));
    for (const j of every(nx, strideJ)) for (let i = 0; i < ny - 1; i++) if (has(i, j) && has(i + 1, j)) wire.push(...vtx(i, j), ...vtx(i + 1, j));
    const wireGeom = new THREE.BufferGeometry();
    wireGeom.setAttribute("position", new THREE.Float32BufferAttribute(wire, 3));
    const wireMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 });
    const wireLines = new THREE.LineSegments(wireGeom, wireMat);
    scene.add(wireLines);

    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    marker.visible = false;
    scene.add(marker);
    view.onTheme((t) => {
      wireMat.color.copy(t.line);
      wireMat.opacity = t.dark ? 0.22 : 0.16;
      (marker.material as THREE.MeshBasicMaterial).color.copy(t.fore);
    });

    // Growing in: the surface rises from the floor once, on a fresh reply.
    const growStart = grow ? performance.now() : 0;
    const GROW_MS = 850;
    const setGrow = (t: number) => {
      mesh.scale.y = t;
      wireLines.scale.y = t;
    };
    if (grow) setGrow(0.001);
    view.onFrame((now) => {
      if (!grow || !growStart) return false;
      const p = Math.min(1, (now - growStart) / GROW_MS);
      setGrow(Math.max(0.001, 1 - (1 - p) ** 3));
      return p < 1;
    });

    addAxes(
      view,
      overlay,
      { ticks: niceTicks(x0, x1, 5).filter((t) => t >= x0 && t <= x1), world: wx, label: xLabel, unit: spec.axes?.x?.unit },
      { ticks: niceTicks(y0, y1, 5).filter((t) => t >= y0 && t <= y1), world: wz, label: yLabel, unit: spec.axes?.y?.unit },
      { ticks: niceTicks(lo, hi, 6).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9), world: wh, label: zLabel, unit: zUnit },
    );

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const v = new THREE.Vector3();
    view.onHover((at) => {
      const hit = at && !at.dragging ? (ndc.set((at.x / at.w) * 2 - 1, -(at.y / at.h) * 2 + 1), ray.setFromCamera(ndc, camera), ray.intersectObject(mesh, false)[0]) : undefined;
      if (!at || !hit || !hit.face) {
        if (marker.visible) {
          marker.visible = false;
          request();
        }
        setHover(null);
        return;
      }
      let best = hit.face.a;
      let bestD = Infinity;
      for (const k of [hit.face.a, hit.face.b, hit.face.c]) {
        const d = v.set(positions[k * 3]!, positions[k * 3 + 1]! * mesh.scale.y, positions[k * 3 + 2]!).distanceToSquared(hit.point);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      marker.position.set(positions[best * 3]!, positions[best * 3 + 1]! * mesh.scale.y, positions[best * 3 + 2]!);
      marker.visible = true;
      request();
      setHover({ i: Math.floor(best / nx), j: best % nx, left: at.x, top: at.y });
    });

    api.current = view.api;
    request();

    return () => {
      api.current = null;
      view.dispose();
      overlay.replaceChildren();
    };
    // The spec of a drawn chart never changes (ChartBlock keeps the first one per tool call).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, height]);

  if (!ok) return <Heatmap spec={spec} height={height} />;

  const hv = hover ? g.z[hover.i]?.[hover.j] : undefined;
  return (
    <div className="flex flex-col gap-2.5">
      <ViewBox boxRef={box} labelsRef={labels} api={api} height={height} label={`${spec.title}. ${describeChart(spec)}`}>
        {hover && hv !== undefined ? (
          <HoverCard left={hover.left} top={hover.top} boxWidth={box.current?.clientWidth ?? 0}>
            <HoverRow name={xLabel} value={fmtValue(g.x[hover.j]!, spec.axes?.x?.unit)} />
            <HoverRow name={yLabel} value={fmtValue(g.y[hover.i]!, spec.axes?.y?.unit)} />
            <HoverRow name={zLabel} value={fmtValue(hv, zUnit)} strong />
          </HoverCard>
        ) : null}
      </ViewBox>
      <ColorScale min={zMin} max={zMax} unit={zUnit} label={zLabel} />
    </div>
  );
}

/** Without WebGL: the same grid as a heatmap. */
function Heatmap({ spec, height }: { spec: ChartSpec; height: number }) {
  const g = spec.grid!;
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of g.z) for (const v of row) if (v !== null) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  const c = new THREE.Color();
  const nx = g.x.length;
  const ny = g.y.length;
  return (
    <div className="flex flex-col gap-2.5">
      <svg viewBox={`0 0 ${nx} ${ny}`} preserveAspectRatio="none" width="100%" height={height - 30} role="img" aria-label={`${spec.title}. ${describeChart(spec)}`}>
        {g.z.map((row, i) =>
          row.map((v, j) => (v === null ? null : <rect key={`${i}-${j}`} x={j} y={ny - 1 - i} width={1.02} height={1.02} fill={`#${colorAt(hi === lo ? 0.5 : (v - lo) / (hi - lo), c).getHexString()}`} />)),
        )}
      </svg>
      <p className="text-fs-11.5 text-faint">3D view needs WebGL; shown as a heatmap ({spec.axes?.x?.label ?? "x"} across, {spec.axes?.y?.label ?? "y"} up).</p>
      <ColorScale min={lo} max={hi} unit={spec.axes?.z?.unit} label={spec.axes?.z?.label ?? "value"} />
    </div>
  );
}
