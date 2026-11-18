"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { RotateCcw } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MONO } from "../parts";
import { observeSettledSize } from "../shell/resize";
import { digitsFor, fmtValue } from "./Chart2D";

/**
 * What the 3D charts in a Desk reply share (show_chart "surface3d" in
 * lab/Surface3D.tsx, "scatter3d" in lab/Scatter3D.tsx): the three.js view
 * (camera, lights, orbit controls, render on demand, settled resize, scroll
 * engagement, theme tokens, keyboard rotate/zoom, reset), the boxed axes with
 * their HTML tick labels, the colour scales and the box around the canvas.
 * Imported only by those two lazily loaded files, so three.js stays out of the
 * Desk bundle until a 3D chart is on screen.
 */

/** Viridis: readable on light and dark, and in grayscale. */
export const SURFACE_STOPS = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
const STOP_COLORS = SURFACE_STOPS.map((c) => new THREE.Color(c));
/** Height of the box in world units (the floor spans -1..1 on x and z). */
export const HEIGHT = 1;
/** Gap in px kept between an axis label and the edge of the chart box. */
const LABEL_PAD = 4;
const RADIUS = 4.4;

export function colorAt(t: number, out: THREE.Color): THREE.Color {
  const x = Math.max(0, Math.min(1, t)) * (STOP_COLORS.length - 1);
  const i = Math.min(STOP_COLORS.length - 2, Math.floor(x));
  return out.copy(STOP_COLORS[i]!).lerp(STOP_COLORS[i + 1]!, x - i);
}

export function niceTicks(min: number, max: number, target: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) out.push(Math.round(t / step) * step);
  return out;
}

/** "0 0 0" (a --f-* token) -> a three color. */
export function token(el: Element, name: string, fallback: string): THREE.Color {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const p = v.split(/\s+/).map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? new THREE.Color(`rgb(${p[0]}, ${p[1]}, ${p[2]})`) : new THREE.Color(fallback);
}

/** Dark theme: the --f-line token is light there. */
export function isDark(el: Element): boolean {
  return token(el, "--f-line", "#000").r > 0.5;
}

export function webgl(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Group colours: the 2D chart tokens (lab/Chart2D.tsx SERIES_COLORS, ink last
 * here, it reads as "no colour" among points) with four extra hues between
 * them, so 12 groups stay apart. Each has a light and a dark value.
 */
const GROUP_PALETTE: { token?: string; light: string; dark: string }[] = [
  { token: "--f-chart-ew", light: "#2a78d6", dark: "#609ef0" },
  { token: "--f-warn", light: "#b0782f", dark: "#dea760" },
  { light: "#1f8a80", dark: "#4fc1b5" },
  { token: "--f-chart-competitor", light: "#8d5a86", dark: "#c48ebc" },
  { light: "#6b7f2a", dark: "#a9bf5c" },
  { light: "#c8414f", dark: "#f2737f" },
  { token: "--f-iris", light: "#5b4bdb", dark: "#a095f8" },
  { token: "--f-caution", light: "#c9a227", dark: "#d9b648" },
  { token: "--f-chart-customer", light: "#4f74a8", dark: "#80a0d2" },
  { light: "#8a5a3c", dark: "#c49473" },
  { token: "--f-chart-peer", light: "#8f8f88", dark: "#969696" },
  { token: "--f-fore", light: "#1d1b1b", dark: "#ededed" },
];

/** The group colours for the current theme, as "#rrggbb". */
export function groupColors(el: Element): string[] {
  const dark = isDark(el);
  return GROUP_PALETTE.map((p) => `#${(p.token ? token(el, p.token, dark ? p.dark : p.light) : new THREE.Color(dark ? p.dark : p.light)).getHexString()}`);
}

export type Theme = { line: THREE.Color; fore: THREE.Color; dark: boolean };
export type ViewApi = { reset: () => void; rotate: (dTheta: number, dPhi: number) => void; zoom: (f: number) => void };
/** Pointer position over the canvas in px (null when it left), and whether a button is down (dragging). */
export type HoverAt = { x: number; y: number; w: number; h: number; dragging: boolean } | null;

export type View3D = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  request: () => void;
  size: () => { w: number; h: number };
  /** Projects a world point to px in the box; `front` is false behind the camera. */
  toScreen: (p: THREE.Vector3) => { x: number; y: number; front: boolean };
  /** Runs before each render; return true to ask for another frame (an animation still running). */
  onFrame: (fn: (now: number) => boolean | void) => void;
  /** Called at once and again whenever the app theme changes. */
  onTheme: (fn: (t: Theme) => void) => void;
  /** Pointer moves (rAF-throttled) and leaves. */
  onHover: (fn: (at: HoverAt) => void) => void;
  api: ViewApi;
  dispose: () => void;
};

/**
 * The camera, lights and controls of a 3D chart in `el` (the canvas is
 * prepended): drag rotates, pinch or ctrl/cmd + scroll zooms (plain scroll only
 * once the chart was clicked, so the thread still scrolls past), renders only
 * while something moves. Null when WebGL cannot start.
 */
export function createView(el: HTMLElement, opts: { height: number; damping: boolean }): View3D | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.outline = "none";
  el.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const target = new THREE.Vector3(0, HEIGHT * 0.42, 0);
  const home = new THREE.Vector3().setFromSpherical(new THREE.Spherical(RADIUS, THREE.MathUtils.degToRad(60), THREE.MathUtils.degToRad(38))).add(target);
  camera.position.copy(home);
  camera.lookAt(target);

  scene.add(new THREE.AmbientLight(0xffffff, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enablePan = false;
  controls.minDistance = 2.2;
  controls.maxDistance = 9;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.8;
  controls.enableDamping = opts.damping;
  controls.dampingFactor = 0.12;
  controls.update();

  const frameFns: ((now: number) => boolean | void)[] = [];
  const themeFns: ((t: Theme) => void)[] = [];
  const hoverFns: ((at: HoverAt) => void)[] = [];
  let w = 0;
  const h = opts.height;

  let frame = 0;
  const render = () => {
    frame = 0;
    let again = false;
    if (controls.update()) again = controls.enableDamping;
    // The camera's matrices follow the controls now, so labels projected below match this frame (not the last).
    camera.updateMatrixWorld();
    const now = performance.now();
    for (const f of frameFns) if (f(now)) again = true;
    renderer.render(scene, camera);
    if (again) request();
  };
  const request = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  controls.addEventListener("change", request);

  const stopSize = observeSettledSize(el, (rect) => {
    w = Math.max(1, Math.floor(rect.width));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    request();
  });

  // Plain scroll zooms only after a click inside (the thread keeps scrolling past); pinch (ctrl + wheel) always.
  let engaged = false;
  const onWheelCapture = (e: WheelEvent) => {
    controls.enableZoom = engaged || e.ctrlKey || e.metaKey;
  };
  const onDown = () => {
    engaged = true;
  };
  let pending: PointerEvent | null = null;
  let hoverFrame = 0;
  const onLeave = () => {
    engaged = false;
    pending = null;
    for (const f of hoverFns) f(null);
  };
  const pickNow = () => {
    hoverFrame = 0;
    const e = pending;
    if (!e) return;
    const r = renderer.domElement.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height, dragging: e.buttons !== 0 };
    for (const f of hoverFns) f(at);
  };
  const onMove = (e: PointerEvent) => {
    pending = e;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(pickNow);
  };
  el.addEventListener("wheel", onWheelCapture, { capture: true, passive: true });
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("pointermove", onMove);

  const theme = (): Theme => {
    const line = token(el, "--f-line", "#000");
    return { line, fore: token(el, "--f-fore", "#111"), dark: line.r > 0.5 };
  };
  // Theme switches (html class) recolor what registered.
  const mo = new MutationObserver(() => {
    const t = theme();
    for (const f of themeFns) f(t);
    request();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });

  const v = new THREE.Vector3();
  const sph = new THREE.Spherical();
  const api: ViewApi = {
    reset: () => {
      camera.position.copy(home);
      controls.target.copy(target);
      controls.update();
      request();
    },
    rotate: (dTheta, dPhi) => {
      sph.setFromVector3(v.copy(camera.position).sub(controls.target));
      sph.theta += dTheta;
      sph.phi = Math.max(0.15, Math.min(controls.maxPolarAngle, sph.phi + dPhi));
      camera.position.setFromSpherical(sph).add(controls.target);
      controls.update();
      request();
    },
    zoom: (f) => {
      sph.setFromVector3(v.copy(camera.position).sub(controls.target));
      sph.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, sph.radius * f));
      camera.position.setFromSpherical(sph).add(controls.target);
      controls.update();
      request();
    },
  };

  const pv = new THREE.Vector3();
  return {
    scene,
    camera,
    controls,
    request,
    size: () => ({ w, h }),
    toScreen: (p) => {
      pv.copy(p).project(camera);
      return { x: ((pv.x + 1) / 2) * w, y: ((1 - pv.y) / 2) * h, front: pv.z < 1 };
    },
    onFrame: (fn) => frameFns.push(fn),
    onTheme: (fn) => {
      themeFns.push(fn);
      fn(theme());
    },
    onHover: (fn) => hoverFns.push(fn),
    api,
    dispose: () => {
      if (frame) cancelAnimationFrame(frame);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      stopSize();
      mo.disconnect();
      el.removeEventListener("wheel", onWheelCapture, { capture: true });
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointermove", onMove);
      controls.removeEventListener("change", request);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        mats.forEach((x) => x.dispose());
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

/** One axis of the box: its ticks (inside the range), how a value maps to world units, its title and unit. */
export type AxisDef = { ticks: number[]; world: (v: number) => number; label: string; unit?: string };

/**
 * The box's axes: the floor frame with grid lines at the x and y ticks, the
 * value post (z) at the side corner that shows left-most, and HTML labels
 * (ticks and titles) kept inside the box. x runs along the floor's width, y
 * along its depth, z up.
 */
export function addAxes(view: View3D, overlay: HTMLElement, x: AxisDef, y: AxisDef, z: AxisDef): void {
  const { scene, camera } = view;
  const floor: number[] = [-1, 0, -1, 1, 0, -1, 1, 0, -1, 1, 0, 1, 1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0, -1];
  for (const t of x.ticks) floor.push(x.world(t), 0, -1, x.world(t), 0, 1);
  for (const t of y.ticks) floor.push(-1, 0, y.world(t), 1, 0, y.world(t));
  const floorGeom = new THREE.BufferGeometry();
  floorGeom.setAttribute("position", new THREE.Float32BufferAttribute(floor, 3));
  const floorMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 });
  scene.add(new THREE.LineSegments(floorGeom, floorMat));
  // The value axis stands at the back corner (it moves as the view turns).
  const postGeom = new THREE.BufferGeometry();
  postGeom.setAttribute("position", new THREE.Float32BufferAttribute(new Array(6 + z.ticks.length * 6).fill(0), 3));
  const postMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 });
  scene.add(new THREE.LineSegments(postGeom, postMat));
  view.onTheme((t) => {
    floorMat.color.copy(t.line);
    floorMat.opacity = t.dark ? 0.16 : 0.12;
    postMat.color.copy(t.line);
    postMat.opacity = t.dark ? 0.35 : 0.28;
  });

  // Labels: HTML over the canvas, placed by projecting their 3D anchor each frame.
  type Label = { el: HTMLSpanElement; at: () => THREE.Vector3; align: "center" | "right" | "left"; width: number };
  const list: Label[] = [];
  const add = (text: string, cls: string, at: () => THREE.Vector3, align: Label["align"] = "center") => {
    const s = document.createElement("span");
    s.textContent = text;
    s.className = `pointer-events-none absolute left-0 top-0 whitespace-nowrap ${cls}`;
    s.style.fontFamily = cls.includes("tick") ? MONO : "";
    overlay.appendChild(s);
    list.push({ el: s, at, align, width: 0 });
  };
  // Which edges face the viewer: front edge for x, side edge for y, back corner for z.
  const side = { x: 1, z: 1 };
  // The value axis stands at the side corner that shows left-most (never behind the data).
  const post = { x: -1, z: 1 };
  const step = (t: number[]) => (t.length > 1 ? t[1]! - t[0]! : 1);
  const [dx, dy, dz] = [digitsFor(step(x.ticks)), digitsFor(step(y.ticks)), digitsFor(step(z.ticks))];
  const tickCls = "tick text-[10.5px] text-faint";
  const titleCls = "text-[11px] text-quiet";
  for (const t of x.ticks) add(fmtValue(t, x.unit, dx, true), tickCls, () => new THREE.Vector3(x.world(t), 0, side.z * 1.14));
  for (const t of y.ticks) add(fmtValue(t, y.unit, dy, true), tickCls, () => new THREE.Vector3(side.x * 1.16, 0, y.world(t)));
  for (const t of z.ticks) add(fmtValue(t, z.unit, dz, true), tickCls, () => new THREE.Vector3(post.x * 1.08, z.world(t), post.z * 1.08), "right");
  add(x.label, titleCls, () => new THREE.Vector3(0, 0, side.z * 1.5));
  add(y.label, titleCls, () => new THREE.Vector3(side.x * 1.6, 0, 0));
  add(z.label, titleCls, () => new THREE.Vector3(post.x, HEIGHT * 1.14, post.z));

  const v = new THREE.Vector3();
  const target = view.controls.target;
  view.onFrame(() => {
    const { w, h } = view.size();
    side.x = camera.position.x - target.x >= 0 ? 1 : -1;
    side.z = camera.position.z - target.z >= 0 ? 1 : -1;
    // The post at the left-most side corner, with short ticks.
    const a = v.set(side.x, 0, -side.z).project(camera).x;
    const b = v.set(-side.x, 0, side.z).project(camera).x;
    post.x = a < b ? side.x : -side.x;
    post.z = a < b ? -side.z : side.z;
    const pts = postGeom.getAttribute("position") as THREE.BufferAttribute;
    const px = post.x;
    const pz = post.z;
    pts.setXYZ(0, px, 0, pz);
    pts.setXYZ(1, px, HEIGHT, pz);
    z.ticks.forEach((t, k) => {
      pts.setXYZ(2 + k * 2, px, z.world(t), pz);
      pts.setXYZ(3 + k * 2, px * 1.05, z.world(t), pz * 1.05);
    });
    pts.needsUpdate = true;
    for (const l of list) {
      v.copy(l.at()).project(camera);
      const sx = ((v.x + 1) / 2) * w;
      const sy = ((1 - v.y) / 2) * h;
      // Kept inside the box (the value-axis title sits at the left-most corner and would be cut off in narrow panels).
      if (!l.width) l.width = l.el.offsetWidth;
      const left0 = sx - l.width * (l.align === "center" ? 0.5 : l.align === "right" ? 1 : 0);
      const left = Math.max(LABEL_PAD, Math.min(left0, w - l.width - LABEL_PAD));
      const top = Math.max(LABEL_PAD + 7, Math.min(sy, h - LABEL_PAD - 7));
      l.el.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px) translate(0, -50%)`;
      l.el.style.visibility = v.z < 1 ? "visible" : "hidden";
    }
  });
}

/** Arrow keys rotate (shift: faster), + / - zoom, 0 resets. */
export function viewKeyDown(api: RefObject<ViewApi | null>) {
  return (e: KeyboardEvent) => {
    const a = api.current;
    if (!a) return;
    const step = THREE.MathUtils.degToRad(e.shiftKey ? 30 : 10);
    const keys: Record<string, () => void> = {
      ArrowLeft: () => a.rotate(-step, 0),
      ArrowRight: () => a.rotate(step, 0),
      ArrowUp: () => a.rotate(0, -step),
      ArrowDown: () => a.rotate(0, step),
      "+": () => a.zoom(0.88),
      "=": () => a.zoom(0.88),
      "-": () => a.zoom(1.14),
      "0": () => a.reset(),
    };
    const f = keys[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };
}

/** The focusable box around the canvas: label overlay, Reset view, and the tooltip (children). */
export function ViewBox({
  boxRef,
  labelsRef,
  api,
  height,
  label,
  children,
}: {
  boxRef: RefObject<HTMLDivElement>;
  labelsRef: RefObject<HTMLDivElement>;
  api: RefObject<ViewApi | null>;
  height: number;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div
      ref={boxRef}
      className="relative cursor-grab select-none overflow-hidden rounded-lg outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-line/20"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-roledescription="interactive 3D chart"
      aria-label={`${label} Arrow keys rotate, plus and minus zoom, 0 resets the view.`}
      onKeyDown={viewKeyDown(api)}
    >
      <div ref={labelsRef} className="pointer-events-none absolute inset-0" aria-hidden />
      <button
        type="button"
        onClick={() => api.current?.reset()}
        title="Reset view"
        className="absolute right-1.5 top-1.5 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border border-line/[0.1] bg-surface/85 px-2 text-fs-12 text-fore-4 backdrop-blur transition-colors hover:bg-surface hover:text-fore outline-none focus-visible:ring-2 focus-visible:ring-line/20"
      >
        <RotateCcw width={12} height={12} strokeWidth={1.75} aria-hidden />
        Reset view
      </button>
      {children}
    </div>
  );
}

/** A hover card next to the pointer, flipped to its left when it would cross the right edge. */
export function HoverCard({ left, top, boxWidth, children }: { left: number; top: number; boxWidth: number; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(180);
  // Measured whenever the pointer moves (the content changes with the point); the same width does not re-render.
  useLayoutEffect(() => {
    if (card.current) setWidth(card.current.offsetWidth);
  }, [left, top]);
  const x = left + 14 + width > boxWidth - 4 ? Math.max(4, left - 14 - width) : left + 14;
  return (
    <div
      ref={card}
      className="pointer-events-none absolute z-10 w-max min-w-[150px] max-w-[300px] rounded-md border border-line/10 bg-raised px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
      style={{ top: Math.max(4, top - 70), left: x }}
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-fs-12">{children}</div>
    </div>
  );
}

/** A row of HoverCard: name, then the value in mono. */
export function HoverRow({ name, value, strong = false, mono = true }: { name: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <>
      <span className={strong ? "font-medium text-fore-3" : "text-fore-4"}>{name}</span>
      <span className={`whitespace-nowrap text-right tabular-nums text-fore ${strong ? "font-medium" : ""}`} style={mono ? { fontFamily: MONO } : undefined}>
        {value}
      </span>
    </>
  );
}

/** The color legend: viridis from the lowest to the highest value. */
export function ColorScale({ min, max, unit, label }: { min: number; max: number; unit?: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-fs-11.5 text-quiet">
      <span className="shrink-0">{label}</span>
      <span className="shrink-0 tabular-nums" style={{ fontFamily: MONO }}>
        {fmtValue(min, unit)}
      </span>
      <span className="h-2 min-w-[60px] max-w-[260px] flex-1 rounded-full" style={{ background: `linear-gradient(90deg, ${SURFACE_STOPS.join(", ")})` }} aria-hidden />
      <span className="shrink-0 tabular-nums" style={{ fontFamily: MONO }}>
        {fmtValue(max, unit)}
      </span>
    </div>
  );
}
