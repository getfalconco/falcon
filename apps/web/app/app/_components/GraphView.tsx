"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { quadtree, type Quadtree } from "d3-quadtree";
import { Settings } from "lucide-react";

/**
 * The connection graph, drawn like Obsidian's graph view: a plain canvas of
 * gray dots sized by their number of links, thin straight lines, labels under
 * the dots that fade in as you zoom. A d3-force simulation lays it out and
 * keeps it gently floating; drag a dot to pull it (the rest follow), drag the
 * background to pan, scroll or pinch to zoom. Hover lights a company and its
 * neighbours and dims the rest; click opens the company.
 *
 * Canvas, not SVG, so the whole market (1,600 companies, 4,400 links) stays
 * smooth. `interactive={false}` (the small cards) keeps hover, click and
 * dragging dots but drops pan and zoom: the view follows the drawing instead.
 */

export type ForceGraphNode = {
  id: string;
  name: string;
  focus?: boolean;
  /** Link count that sizes the dot; defaults to the links drawn (a filtered graph keeps its full-market sizes). */
  size?: number;
};
export type ForceGraphEdge = { source: string; target: string; strength?: number };
export type ForceGraph = { nodes: readonly ForceGraphNode[]; edges: readonly ForceGraphEdge[] };

type SimNode = SimulationNodeDatum & {
  id: string;
  name: string;
  focus: boolean;
  degree: number;
  /** Radius in graph units. */
  r: number;
  /** Phase of its idle drift. */
  phase: number;
};
type SimLink = SimulationLinkDatum<SimNode> & { source: SimNode; target: SimNode; strength: number };

type Colors = {
  dark: boolean;
  node: string;
  focus: string;
  lit: string;
  edge: string;
  label: string;
  sub: string;
  font: string;
};

type Options = {
  interactive: boolean;
  highlight: string | undefined;
  onOpen: (id: string) => void;
  /** Preferred link length for small graphs, in graph units. */
  ring: number | undefined;
};

const MIN_K = 0.02;
const MAX_K = 6;

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function radiusFor(degree: number) {
  return 3 + 1.45 * Math.log2(1 + degree);
}

function hashPhase(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 6283) / 1000;
}

function rgb(style: CSSStyleDeclaration, name: string, fallback: string) {
  const v = style.getPropertyValue(`--f-${name}`).trim();
  return v ? `rgb(${v})` : fallback;
}

function readColors(el: Element): Colors {
  const style = getComputedStyle(el);
  const surface = style.getPropertyValue("--f-surface").trim().split(/\s+/).map(Number);
  const dark = surface.length === 3 && surface[0] + surface[1] + surface[2] < 3 * 110;
  return {
    dark,
    node: dark ? rgb(style, "quiet", "#a3a3a3") : rgb(style, "quiet-2", "#8a8a85"),
    focus: dark ? rgb(style, "fore-4", "#c8c8c8") : rgb(style, "quiet", "#767676"),
    lit: rgb(style, "fore", dark ? "#ededed" : "#1d1b1b"),
    edge: rgb(style, "fore", dark ? "#ededed" : "#1d1b1b"),
    label: dark ? rgb(style, "fore-3", "#d6d6d6") : rgb(style, "fore-4", "#4b4b48"),
    sub: rgb(style, "quiet", dark ? "#a3a3a3" : "#767676"),
    font: style.fontFamily || "sans-serif",
  };
}

function prefersReduced(): boolean {
  const pref = document.documentElement.dataset.fMotion;
  if (pref === "reduced") return true;
  if (pref === "full") return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

class GraphEngine {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private byId = new Map<string, SimNode>();
  /** Last place of every node ever drawn, so a node a filter brings back returns where it was. */
  private placed = new Map<string, { x: number; y: number }>();
  private edgeSig = "";
  private neighbours = new Map<SimNode, Set<SimNode>>();
  private linksOf = new Map<SimNode, SimLink[]>();
  private maxR = 4;
  private sim: Simulation<SimNode, SimLink>;
  private view = { x: 0, y: 0, k: 1 };
  /** True until the user pans or zooms: the view follows the drawing. */
  private follow = true;
  private warm = 0;
  private appear = 0;
  private hover: SimNode | null = null;
  private dimFor: SimNode | null = null;
  private fade = 0;
  private drag: { node: SimNode; id: number; sx: number; sy: number; moved: boolean } | null = null;
  private pan: { id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; k: number; cx: number; cy: number; vx: number; vy: number } | null = null;
  private tree: Quadtree<SimNode> | null = null;
  private colors: Colors;
  private reduced = false;
  private visible = true;
  private raf = 0;
  private last = 0;
  private dirty = true;
  private odd = false;
  private cleanups: (() => void)[] = [];
  /** Frame times for the last second, for the frame rate readout in dev tools. */
  private frames: number[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: Options,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.colors = readColors(canvas);
    this.reduced = prefersReduced();
    this.sim = forceSimulation<SimNode, SimLink>().stop();
    this.listen();
    this.resize();
    // A handle for poking at the graph from dev tools.
    if (process.env.NODE_ENV === "development") (canvas as HTMLCanvasElement & { graph?: GraphEngine }).graph = this;
  }

  /* ---------------------------------------------------------------- */
  /* Data                                                              */
  /* ---------------------------------------------------------------- */

  setData(graph: ForceGraph) {
    const old = this.byId;
    const edgeSig = graph.edges.map((e) => `${e.source}>${e.target}`).join(",");
    const sameShape =
      graph.nodes.length === this.nodes.length &&
      edgeSig === this.edgeSig &&
      graph.nodes.every((n) => old.has(n.id));
    if (sameShape) {
      for (const n of graph.nodes) {
        const s = old.get(n.id)!;
        s.focus = !!n.focus;
        s.name = n.name;
      }
      this.request();
      return;
    }

    for (const n of this.nodes) if (n.x !== undefined && n.y !== undefined) this.placed.set(n.id, { x: n.x, y: n.y });
    const byId = new Map<string, SimNode>();
    const sizes = new Map<SimNode, number>();
    let kept = 0;
    const nodes: SimNode[] = graph.nodes.map((n) => {
      const prev = old.get(n.id) ?? this.placed.get(n.id);
      if (prev) kept++;
      const node: SimNode = {
        id: n.id,
        name: n.name,
        focus: !!n.focus,
        degree: 0,
        r: 4,
        phase: hashPhase(n.id),
        x: prev?.x,
        y: prev?.y,
        vx: 0,
        vy: 0,
      };
      byId.set(n.id, node);
      if (n.size !== undefined) sizes.set(node, n.size);
      return node;
    });
    const links: SimLink[] = [];
    for (const e of graph.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b || a === b) continue;
      links.push({ source: a, target: b, strength: e.strength ?? 2 });
      a.degree++;
      b.degree++;
    }
    const neighbours = new Map<SimNode, Set<SimNode>>();
    const linksOf = new Map<SimNode, SimLink[]>();
    let maxR = 4;
    for (const n of nodes) {
      n.r = radiusFor(sizes.get(n) ?? n.degree);
      maxR = Math.max(maxR, n.r);
      neighbours.set(n, new Set());
      linksOf.set(n, []);
    }
    for (const l of links) {
      neighbours.get(l.source)!.add(l.target);
      neighbours.get(l.target)!.add(l.source);
      linksOf.get(l.source)!.push(l);
      linksOf.get(l.target)!.push(l);
    }
    this.nodes = nodes;
    this.edgeSig = edgeSig;
    this.links = links;
    this.byId = byId;
    this.neighbours = neighbours;
    this.linksOf = linksOf;
    this.maxR = maxR;
    this.hover = null;
    this.dimFor = null;
    this.fade = 0;
    this.drag = null;
    this.tree = null;
    this.build(kept < nodes.length * 0.8);
  }

  private build(fresh: boolean) {
    const n = this.nodes.length;
    const big = n > 250;
    const ring = this.opts.ring;
    const linkCount = new Map<SimNode, number>();
    for (const l of this.links) {
      linkCount.set(l.source, (linkCount.get(l.source) ?? 0) + 1);
      linkCount.set(l.target, (linkCount.get(l.target) ?? 0) + 1);
    }
    const sim = forceSimulation<SimNode, SimLink>(this.nodes)
      .stop()
      .force(
        "link",
        forceLink<SimNode, SimLink>(this.links)
          .distance((l) => (big ? 72 : ring ? ring * 0.5 : 60) + (big ? 1.6 : 1) * (l.source.r + l.target.r))
          // d3's default (weaker links on hubs), a little firmer for strong filing links.
          .strength((l) => (0.75 + 0.12 * l.strength) / Math.min(linkCount.get(l.source) ?? 1, linkCount.get(l.target) ?? 1)),
      )
      .force(
        "charge",
        forceManyBody<SimNode>()
          .strength(big ? (d) => -(200 + 12 * d.r) : ring ? -ring * 1.6 : -200)
          .theta(big ? 1.2 : 0.9)
          .distanceMax(big ? 600 : 900),
      )
      .force("collide", forceCollide<SimNode>((d) => d.r + (big ? 9 : 2)).strength(big ? 0.8 : 0.7))
      .force("x", forceX<SimNode>(0).strength(big ? 0.03 : 0.06))
      .force("y", forceY<SimNode>(0).strength(big ? 0.03 : 0.06));
    this.sim.stop();
    this.sim = sim;
    // Reduced motion cools faster: it is settled off screen, then drawn still.
    sim.alpha(fresh ? 1 : 0.3).alphaTarget(0).alphaDecay(this.reduced ? 0.06 : 0.0228);
    // Warm up off screen so the first paint is already a shape, not an explosion.
    this.warm = fresh ? (this.reduced ? 120 : big ? 100 : 60) : 0;
    if (fresh) this.appear = 0;
    // A new drawing, or a filter: the view eases to fit what is left (an interactive view lets go once it settles).
    this.follow = true;
    this.request();
  }

  setOptions(opts: Partial<Options>) {
    const ringChanged = opts.ring !== undefined && opts.ring !== this.opts.ring;
    this.opts = { ...this.opts, ...opts };
    if (ringChanged && this.nodes.length) this.build(false);
    this.request();
  }

  /** Back to the whole drawing, animated. */
  resetView() {
    this.follow = true;
    this.request();
  }

  /** Shake the layout up again (Obsidian's "animate"). */
  relayout() {
    for (const n of this.nodes) {
      n.x = undefined;
      n.y = undefined;
      n.vx = 0;
      n.vy = 0;
    }
    this.sim.nodes(this.nodes);
    this.sim.alpha(1);
    this.warm = this.reduced ? 0 : 10;
    this.follow = true;
    this.request();
  }

  /** Light a node (keyboard focus on the list beside the canvas). */
  setHover(id: string | null) {
    this.hover = id ? this.byId.get(id) ?? null : null;
    if (this.hover) this.dimFor = this.hover;
    this.request();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.sim.stop();
    for (const c of this.cleanups) c();
  }

  /* ---------------------------------------------------------------- */
  /* Loop                                                              */
  /* ---------------------------------------------------------------- */

  private idleTarget() {
    // Nothing moves unless something external moves it: the sim cools and stops.
    return 0;
  }

  private simRunning() {
    return this.sim.alpha() > this.sim.alphaMin() || this.sim.alphaTarget() > 0;
  }

  private request() {
    this.dirty = true;
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || !this.w || !this.h) return;
    const dt = this.last ? Math.min(64, now - this.last) : 16;
    this.last = now;
    let active = false;

    if (this.nodes.length) {
      // Warm-up (and reduced motion): many ticks per frame within a time budget, nothing painted until done.
      if (this.warm > 0 || (this.reduced && !this.drag && this.simRunning())) {
        const start = performance.now();
        const budget = this.warm > 0 ? 32 : 24;
        while (performance.now() - start < budget) {
          this.sim.tick();
          if (this.warm > 0) this.warm--;
          else if (!this.simRunning()) break;
          if (this.warm === 0 && !this.reduced) break;
        }
        this.tree = null;
        if (this.warm === 0) {
          // First shape: settle into idle drift; fit at once.
          this.sim.alphaTarget(this.drag ? 0.25 : this.idleTarget());
          if (this.follow) this.fitNow(1);
        }
        this.dirty = true;
        active = true;
      } else if (this.simRunning()) {
        // Idle drift is slow: half the ticks (and paints) once the layout has cooled.
        const idle = !this.drag && this.sim.alpha() < 0.03;
        this.odd = !this.odd;
        if (!idle || this.odd) {
          this.sim.tick();
          this.tree = null;
          this.dirty = true;
        }
        active = true;
      }
    }

    // Hover dimming fades in and out.
    const target = this.hover ? 1 : 0;
    if (this.fade !== target) {
      this.fade = this.reduced ? target : clamp(this.fade + (target ? 1 : -1) * (dt / 140), 0, 1);
      if (this.fade === 0) this.dimFor = null;
      this.dirty = true;
      active = true;
    }
    if (this.warm === 0 && this.appear < 1) {
      this.appear = this.reduced ? 1 : clamp(this.appear + dt / 260, 0, 1);
      this.dirty = true;
      active = true;
    }
    if (this.follow && this.warm === 0 && this.nodes.length) {
      const moved = this.fitNow(this.reduced ? 1 : 0.12);
      // An interactive view stops following once the layout has cooled.
      if (this.opts.interactive && !moved && this.sim.alpha() < 0.05) this.follow = false;
      if (moved) this.dirty = active = true;
    }

    if (this.warm === 0 && this.dirty) this.draw();
    this.dirty = false;

    this.frames.push(now);
    while (this.frames.length && this.frames[0] < now - 1000) this.frames.shift();
    this.canvas.dataset.fps = String(this.frames.length);

    if (active || this.warm > 0) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  /** Moves the view toward the fit; true while it is still moving. */
  private fitNow(ease: number): boolean {
    if (!this.nodes.length || !this.w || !this.h) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      if (x - n.r < minX) minX = x - n.r;
      if (y - n.r < minY) minY = y - n.r;
      if (x + n.r > maxX) maxX = x + n.r;
      if (y + n.r > maxY) maxY = y + n.r;
    }
    const pad = this.opts.interactive ? 48 : 18;
    const labelRoom = 18;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = clamp(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2 - labelRoom) / bh), MIN_K, this.opts.interactive ? 1.6 : 1.25);
    const x = this.w / 2 - ((minX + maxX) / 2) * k;
    const y = (this.h - labelRoom) / 2 - ((minY + maxY) / 2) * k;
    const v = this.view;
    const dk = k - v.k;
    const dx = x - v.x;
    const dy = y - v.y;
    if (Math.abs(dk) < 0.0005 && Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) {
      v.k = k;
      v.x = x;
      v.y = y;
      return false;
    }
    v.k += dk * ease;
    v.x += dx * ease;
    v.y += dy * ease;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Drawing                                                           */
  /* ---------------------------------------------------------------- */

  private draw() {
    const { ctx, dpr, w, h, colors: c } = this;
    const { x: tx, y: ty, k } = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.nodes.length) return;

    const appear = this.appear;
    const fade = this.fade;
    const focus = this.dimFor;
    const lit = focus ? this.neighbours.get(focus) : null;
    const isLit = (n: SimNode) => !!focus && (n === focus || !!lit?.has(n));

    // The visible part of the graph, in graph units.
    const m = this.maxR + 40 / k;
    const x0 = -tx / k - m;
    const y0 = -ty / k - m;
    const x1 = (w - tx) / k + m;
    const y1 = (h - ty) / k + m;
    const inView = (n: SimNode) => n.x! >= x0 && n.x! <= x1 && n.y! >= y0 && n.y! <= y1;

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

    // Links: one thin path, faint; the hovered node's links drawn again, brighter.
    const lineW = clamp(k * 0.9, 0.65, 1.25) / k;
    const base = (c.dark ? 0.2 : 0.17) * appear;
    ctx.lineWidth = lineW;
    ctx.strokeStyle = c.edge;
    ctx.globalAlpha = base * (1 - 0.7 * fade);
    ctx.beginPath();
    for (const l of this.links) {
      const a = l.source;
      const b = l.target;
      if ((a.x! < x0 && b.x! < x0) || (a.x! > x1 && b.x! > x1) || (a.y! < y0 && b.y! < y0) || (a.y! > y1 && b.y! > y1)) continue;
      if (focus && fade > 0 && (a === focus || b === focus)) continue;
      ctx.moveTo(a.x!, a.y!);
      ctx.lineTo(b.x!, b.y!);
    }
    ctx.stroke();
    if (focus) {
      ctx.globalAlpha = (base * (1 - fade) + (c.dark ? 0.55 : 0.5) * fade) * appear;
      ctx.lineWidth = lineW * (1 + 0.4 * fade);
      ctx.beginPath();
      for (const l of this.linksOf.get(focus) ?? []) {
        ctx.moveTo(l.source.x!, l.source.y!);
        ctx.lineTo(l.target.x!, l.target.y!);
      }
      ctx.stroke();
    }

    // Dots, batched by colour and brightness.
    const plain = new Path2D();
    const focused = new Path2D();
    const litPlain = new Path2D();
    const litFocused = new Path2D();
    const self = new Path2D();
    const highlight = this.opts.highlight ? this.byId.get(this.opts.highlight) : undefined;
    for (const n of this.nodes) {
      if (!inView(n)) continue;
      const p = n === focus || n === highlight ? self : isLit(n) ? (n.focus ? litFocused : litPlain) : n.focus ? focused : plain;
      p.moveTo(n.x! + n.r, n.y!);
      p.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
    }
    const dim = 1 - 0.78 * fade;
    ctx.globalAlpha = dim * appear;
    ctx.fillStyle = c.node;
    ctx.fill(plain);
    ctx.fillStyle = c.focus;
    ctx.fill(focused);
    ctx.globalAlpha = appear;
    ctx.fillStyle = c.node;
    ctx.fill(litPlain);
    ctx.fillStyle = c.focus;
    ctx.fill(litFocused);
    ctx.fillStyle = c.lit;
    ctx.fill(self);

    // Labels, in screen pixels so they stay crisp: big dots first as you zoom out.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fs = clamp(11.5 * Math.pow(k, 0.35), 10, 13.5);
    const subFs = fs - 1.5;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const mainFont = `400 ${fs}px ${c.font}`;
    const subFont = `400 ${subFs}px ${c.font}`;
    const showSub = k >= 1.4;
    // A small graph (a card) always shows every label.
    const small = this.nodes.length <= 60;
    ctx.font = mainFont;
    for (const n of this.nodes) {
      if (!inView(n)) continue;
      const sr = n.r * k;
      // Fades in with zoom, bigger dots first (r^1.5 so hubs keep a label zoomed far out).
      let a = small ? 1 : clamp((k * n.r * Math.sqrt(n.r) - 8) / 4, 0, 1);
      if (focus) a = isLit(n) ? Math.max(a, fade) : a * (1 - 0.85 * fade);
      a *= appear;
      if (a < 0.03) continue;
      const sx = n.x! * k + tx;
      const sy = n.y! * k + ty + sr + 3;
      if (sx < -80 || sx > w + 80 || sy < -20 || sy > h + 20) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = c.label;
      ctx.fillText(n.id, sx, sy);
      if (showSub && n.name && n.name !== n.id) {
        ctx.font = subFont;
        ctx.fillStyle = c.sub;
        ctx.globalAlpha = a * clamp((k - 1.4) / 0.4, 0, 1);
        ctx.fillText(n.name, sx, sy + fs + 1);
        ctx.font = mainFont;
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  private local(e: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private toWorld(p: { x: number; y: number }) {
    return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k };
  }

  private nodeAt(p: { x: number; y: number }): SimNode | null {
    if (!this.nodes.length || this.warm > 0) return null;
    if (!this.tree) {
      this.tree = quadtree<SimNode>()
        .x((d) => d.x!)
        .y((d) => d.y!)
        .addAll(this.nodes);
    }
    const w = this.toWorld(p);
    const slop = 5 / this.view.k;
    const found = this.tree.find(w.x, w.y, this.maxR + slop);
    if (!found) return null;
    return Math.hypot(found.x! - w.x, found.y! - w.y) <= found.r + slop ? found : null;
  }

  private setCursor() {
    this.canvas.style.cursor = this.drag?.moved || this.pan?.moved ? "grabbing" : this.hover ? "pointer" : this.opts.interactive ? "grab" : "default";
  }

  private zoomAt(p: { x: number; y: number }, factor: number) {
    const v = this.view;
    const k = clamp(v.k * factor, MIN_K, MAX_K);
    const r = k / v.k;
    v.x = p.x - (p.x - v.x) * r;
    v.y = p.y - (p.y - v.y) * r;
    v.k = k;
    this.follow = false;
    this.request();
  }

  private listen() {
    const el = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    on("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2 && this.opts.interactive) {
        // Two fingers: pinch zoom, whatever the first one was doing.
        this.releaseDrag();
        this.pan = null;
        const [a, b] = Array.from(this.pointers.values());
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.view.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: this.view.x, vy: this.view.y };
        return;
      }
      const node = this.nodeAt(p);
      if (node) {
        this.drag = { node, id: e.pointerId, sx: p.x, sy: p.y, moved: false };
        this.hover = node;
        this.dimFor = node;
      } else if (this.opts.interactive) {
        this.pan = { id: e.pointerId, sx: p.x, sy: p.y, vx: this.view.x, vy: this.view.y, moved: false };
      }
      el.setPointerCapture(e.pointerId);
      this.request();
    });

    on("pointermove", (e) => {
      const p = this.local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = Array.from(this.pointers.values());
        const pc = this.pinch;
        const k = clamp(pc.k * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pc.dist), MIN_K, MAX_K);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const r = k / pc.k;
        this.view = { k, x: cx - (pc.cx - pc.vx) * r, y: cy - (pc.cy - pc.vy) * r };
        this.follow = false;
        this.request();
        return;
      }
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 3) return;
        if (!d.moved) {
          d.moved = true;
          // Pin it and wake the rest so they follow.
          this.sim.alphaTarget(0.25);
          if (this.sim.alpha() < 0.25) this.sim.alpha(0.25);
        }
        const w = this.toWorld(p);
        d.node.fx = w.x;
        d.node.fy = w.y;
        this.setCursor();
        this.request();
        return;
      }
      const pan = this.pan;
      if (pan && pan.id === e.pointerId) {
        const dx = p.x - pan.sx;
        const dy = p.y - pan.sy;
        if (!pan.moved && Math.hypot(dx, dy) < 3) return;
        pan.moved = true;
        this.follow = false;
        this.view.x = pan.vx + dx;
        this.view.y = pan.vy + dy;
        this.setCursor();
        this.request();
        return;
      }
      if (e.pointerType === "touch") return;
      const node = this.nodeAt(p);
      if (node !== this.hover) {
        this.hover = node;
        if (node) this.dimFor = node;
        this.setCursor();
        this.request();
      }
    });

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        return;
      }
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        if (!d.moved && e.type === "pointerup") {
          this.drag = null;
          this.opts.onOpen(d.node.id);
        } else {
          this.releaseDrag();
        }
        if (e.pointerType === "touch") this.hover = null;
      }
      if (this.pan && this.pan.id === e.pointerId) this.pan = null;
      if (e.pointerType !== "touch" && !this.drag && !this.pan) {
        this.hover = this.nodeAt(this.local(e));
        if (this.hover) this.dimFor = this.hover;
      }
      this.setCursor();
      this.request();
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("pointerleave", () => {
      if (this.drag || this.pan) return;
      if (this.hover) {
        this.hover = null;
        this.setCursor();
        this.request();
      }
    });

    on(
      "wheel",
      (e) => {
        if (!this.opts.interactive) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        // Trackpad pinch arrives as a wheel with ctrlKey and small deltas.
        const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016));
        this.zoomAt(this.local(e), factor);
      },
      { passive: false },
    );

    // Size and device pixel ratio.
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(el);
    this.cleanups.push(() => ro.disconnect());

    // Pause when the tab or the view is hidden.
    const onVisibility = () => this.setVisible(!document.hidden && this.inViewport);
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(([entry]) => {
        this.inViewport = !!entry?.isIntersecting;
        onVisibility();
      });
      io.observe(el);
      this.cleanups.push(() => io.disconnect());
    }

    // Theme and motion settings.
    const refresh = () => {
      this.colors = readColors(el);
      const reduced = prefersReduced();
      if (reduced !== this.reduced) {
        this.reduced = reduced;
        this.sim.alphaDecay(reduced ? 0.06 : 0.0228);
        if (!this.drag) this.sim.alphaTarget(this.idleTarget());
      }
      this.request();
    };
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-f-theme", "data-f-motion", "style"] });
    this.cleanups.push(() => mo.disconnect());
    if (typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", refresh);
      this.cleanups.push(() => mq.removeEventListener("change", refresh));
    }
  }

  private inViewport = true;

  private setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.last = 0;
    } else {
      this.request();
    }
  }

  private releaseDrag() {
    const d = this.drag;
    if (!d) return;
    d.node.fx = null;
    d.node.fy = null;
    this.drag = null;
    this.sim.alphaTarget(this.idleTarget());
    this.request();
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    // Keep the middle of the drawing in the middle.
    if (this.w && this.h) {
      this.view.x += (w - this.w) / 2;
      this.view.y += (h - this.h) / 2;
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    if (!this.opts.interactive) this.follow = true;
    this.dirty = true;
    this.request();
  }
}

export function GraphView({
  graph,
  onOpen,
  interactive = true,
  ring,
  className = "",
  highlight,
  ariaLabel = "Connection graph",
  toolbar,
  controlsTop = 12,
  toolbarBottom = false,
  settings = true,
}: {
  graph: ForceGraph;
  onOpen: (ticker: string) => void;
  /** Pan, zoom and the settings button; off for the small cards. */
  interactive?: boolean;
  /** Preferred link length for a small graph. */
  ring?: number;
  className?: string;
  /** Extra emphasis on one node (the page's own company). */
  highlight?: string;
  ariaLabel?: string;
  /** Floats top-left over the canvas (the Graph tab's filter bar); interactive views only. */
  toolbar?: ReactNode;
  /** Distance in px from the top for the toolbar and settings button (clears a title floating over the canvas). */
  controlsTop?: number;
  /** Put the toolbar at the bottom-left of the canvas instead of the top. */
  toolbarBottom?: boolean;
  /** The settings (gear) button at the top-right; interactive views only. */
  settings?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const onOpenRef = useRef(onOpen);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new GraphEngine(canvas, { interactive, highlight, ring, onOpen: (id) => onOpenRef.current(id) });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // The engine lives as long as the canvas; later prop changes go through setOptions and setData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setOptions({ interactive, highlight, ring });
  }, [interactive, highlight, ring]);

  useEffect(() => {
    engineRef.current?.setData(graph);
  }, [graph]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  // A keyboard path to every company, for small graphs (the whole market would be thousands of stops).
  const list = graph.nodes.length <= 200 ? graph.nodes : null;

  return (
    <div className={`relative h-full w-full ${className}`}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none select-none"
        role="img"
        aria-label={ariaLabel}
      />
      {list ? (
        <ul className="sr-only">
          {list.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onOpen(n.id)}
                onFocus={() => engineRef.current?.setHover(n.id)}
                onBlur={() => engineRef.current?.setHover(null)}
              >
                {`${n.id}, ${n.name}`}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {interactive && toolbar ? <div
          className={`pointer-events-none absolute left-3 right-14 ${toolbarBottom ? "bottom-3" : ""}`}
          style={toolbarBottom ? undefined : { top: controlsTop }}
        >
          {toolbar}
        </div> : null}
      {interactive && settings ? (
        <div ref={menuRef} className="absolute right-3" style={{ top: controlsTop }}>
          <button
            type="button"
            aria-label="Graph settings"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-quiet outline-none transition-colors hover:bg-surface-hover hover:text-fore focus-visible:bg-surface-hover"
          >
            <Settings width={17} height={17} strokeWidth={1.6} aria-hidden />
          </button>
          {menu ? (
            <div role="menu" className="absolute right-0 top-9 z-10 w-40 rounded-lg border border-line/[0.08] bg-raised p-1 shadow-lg">
              {(
                [
                  ["Reset view", () => engineRef.current?.resetView()],
                  ["Re-run layout", () => engineRef.current?.relayout()],
                ] as const
              ).map(([label, run]) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    run();
                    setMenu(false);
                  }}
                  className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-fs-13 text-fore-3 outline-none hover:bg-surface-hover hover:text-fore focus-visible:bg-surface-hover"
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
