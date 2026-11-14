"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Relation } from "@falcon/ripple";
import { layoutGraph, type Graph } from "@/lib/workspace/graph";
import { relationLabel } from "@/lib/workspace/feed";
import { INK, MONO, netColor } from "./parts";

export const RELATION_COLOR: Record<Relation, string> = {
  customer: "#4f74a8",
  supplier: "#b0782f",
  competitor: "#8d5a86",
  peer: "#8f8f88",
  self: "#1d1b1b",
};
const UNKNOWN_EDGE = "#c4c4bf";

/** A relation's colour; the neutral edge colour for none or a value this build does not know. */
export function relationColor(relation: string | null | undefined): string {
  return (relation && RELATION_COLOR[relation as Relation]) || UNKNOWN_EDGE;
}
/** Largest zoom the fit may use: labels stay at about their design size. */
const MAX_SCALE = 1.2;

export function RelationLegend({ relations }: { relations: readonly Relation[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {relations.map((r) => (
        <li key={r} className="flex items-center gap-1.5 text-[12px] text-[#4b4b48]">
          <span className="h-[2px] w-4 rounded-full" style={{ background: relationColor(r) }} aria-hidden />
          {relationLabel(r)}
        </li>
      ))}
    </ul>
  );
}

type View = { x: number; y: number; k: number };

/**
 * The connection graph as SVG. Seeds (focus list) are dark, other companies
 * outlined; the outline color is today's net direction on that company.
 * Hover lights a node and its links; click opens the node's Ticker tab.
 * `interactive` adds drag to pan and wheel to zoom.
 */
export function GraphView({
  graph,
  onOpen,
  interactive = true,
  ring = 150,
  className = "",
  highlight,
  ariaLabel = "Connection graph",
}: {
  graph: Graph;
  onOpen: (ticker: string) => void;
  interactive?: boolean;
  ring?: number;
  className?: string;
  /** Extra emphasis on one node (the page's own company). */
  highlight?: string;
  ariaLabel?: string;
}) {
  const positions = useMemo(() => layoutGraph(graph, { ring }), [graph, ring]);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // The element's size, so a small graph is never blown up past MAX_SCALE.
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setFrame({ w: width, h: height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  // The drawing's bounds, padded for labels.
  const box = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of Array.from(positions.values())) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return { x: -100, y: -100, w: 200, h: 200 };
    const pad = 48;
    const w = Math.max(maxX - minX + pad * 2, 220, frame ? frame.w / MAX_SCALE : 0);
    const h = Math.max(maxY - minY + pad * 2, 180, frame ? frame.h / MAX_SCALE : 0);
    return { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
  }, [frame, positions]);

  useEffect(() => setView({ x: 0, y: 0, k: 1 }), [graph]);

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      (map.get(e.source) ?? map.set(e.source, new Set()).get(e.source)!).add(e.target);
      (map.get(e.target) ?? map.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    return map;
  }, [graph]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView((v) => {
        const k = Math.min(4, Math.max(0.4, v.k * factor));
        // Zoom around the pointer.
        const scale = Math.min(rect.width / box.w, rect.height / box.h);
        const px = (event.clientX - rect.left - rect.width / 2) / scale;
        const py = (event.clientY - rect.top - rect.height / 2) / scale;
        const ratio = k / v.k;
        return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [box.h, box.w, interactive]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!interactive || event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    },
    [interactive, view.x, view.y],
  );
  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const d = drag.current;
      const svg = svgRef.current;
      if (!d || !svg) return;
      const dx = event.clientX - d.x;
      const dy = event.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) svg.setPointerCapture(event.pointerId);
      d.moved = true;
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / box.w, rect.height / box.h);
      setView((v) => ({ ...v, x: d.vx + dx / scale, y: d.vy + dy / scale }));
    },
    [box.h, box.w],
  );
  const endDrag = useCallback(() => {
    // Let the click that ends a drag be ignored by the nodes.
    setTimeout(() => {
      drag.current = null;
    }, 0);
  }, []);

  const seeds = useMemo(() => new Set(graph.nodes.filter((n) => n.focus).map((n) => n.id)), [graph]);
  const lit = hover ? neighbors.get(hover) ?? new Set<string>() : null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const transform = `translate(${cx + view.x} ${cy + view.y}) scale(${view.k}) translate(${-cx} ${-cy})`;

  return (
    <svg
      ref={svgRef}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMid meet"
      className={`block h-full w-full select-none ${interactive ? "cursor-grab active:cursor-grabbing" : ""} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      role="group"
      aria-label={ariaLabel}
    >
      <g transform={transform}>
        {graph.edges.map((e) => {
          const a = positions.get(e.source);
          const b = positions.get(e.target);
          if (!a || !b) return null;
          const on = hover ? e.source === hover || e.target === hover : false;
          const dim = hover !== null && !on;
          // Links that touch a seed carry the picture; the rest stay faint.
          const primary = seeds.has(e.source) || seeds.has(e.target);
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={relationColor(e.relation)}
              strokeWidth={on ? 2 : 1.25}
              strokeOpacity={dim ? 0.1 : on ? 0.95 : primary ? 0.6 : 0.28}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${e.source} and ${e.target}${e.relation ? `: ${relationLabel(e.relation).toLowerCase()}` : ""}`}</title>
            </line>
          );
        })}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const radius = n.focus ? 7.5 : n.depth === 1 ? 5.5 : 4.5;
          const dim = hover !== null && hover !== n.id && !lit?.has(n.id);
          const own = highlight === n.id;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x} ${p.y})`}
              className="cursor-pointer outline-none"
              opacity={dim ? 0.28 : 1}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
              onClick={() => {
                if (drag.current?.moved) return;
                onOpen(n.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(n.id);
                }
              }}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              tabIndex={interactive ? 0 : -1}
              role="button"
              aria-label={`${n.id}, ${n.name}`}
            >
              <circle r={radius + 9} fill="transparent" />
              {own ? <circle r={radius + 4.5} fill="none" stroke={INK} strokeOpacity={0.25} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
              <circle
                r={radius}
                fill={n.focus ? INK : "#ffffff"}
                stroke={n.focus ? (n.net === null ? INK : netColor(n.net)) : n.net === null ? "rgba(0,0,0,0.35)" : netColor(n.net)}
                strokeWidth={n.focus && n.net !== null ? 2.25 : 1.5}
                vectorEffect="non-scaling-stroke"
              />
              <text
                y={radius + 13}
                textAnchor="middle"
                fontSize={n.focus ? 11.5 : 10.5}
                fill={n.focus ? INK : "#4b4b48"}
                style={{ fontFamily: MONO, paintOrder: "stroke" }}
                stroke="#fdfdfd"
                strokeWidth={3}
                strokeLinejoin="round"
              >
                {n.id}
              </text>
              <title>{n.name}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
