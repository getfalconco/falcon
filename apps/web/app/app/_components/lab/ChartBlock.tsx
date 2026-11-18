"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import type { ChartSpec } from "@/lib/desk/chart-spec";
import { Chart2D, ChartKey } from "./Chart2D";
import { EASE_OUT, useCalmMotion } from "./motion";
import type { LabTool } from "./sessions";
import { ToolGroup, superseded } from "./ToolRun";
import { AppActionChip } from "./AppActionChip";

/**
 * Charts in a Desk reply. `ToolSegment` stands in for a run of tool rows
 * (LabChat): lookups stay rows (ToolRun), a `show_chart` call that drew a
 * chart becomes the chart itself, in the same place. A chart that failed
 * stays a row with its error.
 *
 * The 3D charts (three.js: surface, scatter) load on their own the first time
 * one is on screen, so the Desk bundle stays as it was for everyone else.
 */

const SURFACE_H = 340;
const LINE_H = 260;

const Surface3D = dynamic(() => import("./Surface3D"), {
  ssr: false,
  loading: () => <div className="animate-pulse rounded-lg bg-line/[0.03]" style={{ height: SURFACE_H + 26 }} />,
});
const Scatter3D = dynamic(() => import("./Scatter3D"), {
  ssr: false,
  loading: () => <div className="animate-pulse rounded-lg bg-line/[0.03]" style={{ height: SURFACE_H + 26 }} />,
});

export function ToolSegment({ tools, all, live }: { tools: LabTool[]; all: LabTool[]; live: boolean }) {
  // A row left still loading is hidden once the same command ran again (that row shows the outcome).
  const rows = tools.filter((t) => !t.chart && !t.action && !superseded(t, all));
  const charts = tools.filter((t) => t.chart);
  // App actions Falcon AI took (lab/AppActionChip.tsx): a chip each, in place of a row.
  const actions = tools.filter((t) => t.action);
  return (
    <>
      {rows.length ? <ToolGroup tools={rows} all={all} live={live} /> : null}
      {actions.length ? (
        <div className="flex flex-wrap gap-1.5">
          {actions.map((t) => (
            <AppActionChip key={t.id} action={t.action!} />
          ))}
        </div>
      ) : null}
      {charts.map((t) => (
        <ChartBlock key={t.id} id={t.id} spec={t.chart!} live={live} />
      ))}
    </>
  );
}

/** Mounts its children once the block is near the screen (a WebGL context per surface only when seen). */
function useNearScreen<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

export function ChartBlock({ id, spec: incoming, live }: { id: string; spec: ChartSpec; live: boolean }) {
  // The stream re-parses the reply on every chunk; a drawn chart keeps its first spec, so nothing rebuilds.
  const kept = useRef<{ id: string; spec: ChartSpec } | null>(null);
  if (!kept.current || kept.current.id !== id) kept.current = { id, spec: incoming };
  const spec = kept.current.spec;
  const still = useCalmMotion();
  const [fresh] = useState(live);
  const [ref, near] = useNearScreen<HTMLDivElement>();
  const surface = spec.kind === "surface3d" && !!spec.grid;
  const scatter3d = spec.kind === "scatter3d" && !!spec.points;
  const three = surface || scatter3d;
  const yAxis = spec.axes?.y;
  const yCaption = !three && yAxis?.label ? `${yAxis.label}${yAxis.unit ? ` (${yAxis.unit})` : ""}` : null;

  return (
    <motion.figure
      initial={fresh && !still ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      className="m-0 flex w-full min-w-0 flex-col gap-3 rounded-xl border border-line/[0.08] bg-surface px-4 pb-3 pt-3.5"
    >
      <figcaption className="flex flex-col gap-0.5">
        <span className="text-fs-14 font-medium leading-fs-20 text-fore">{spec.title}</span>
        {spec.subtitle ? <span className="text-fs-12.5 leading-fs-18 text-quiet">{spec.subtitle}</span> : null}
      </figcaption>
      {!three ? <ChartKey spec={spec} /> : null}
      <div ref={ref} className="min-w-0">
        {yCaption ? <div className="mb-1 text-fs-11.5 text-quiet">{yCaption}</div> : null}
        {three ? (
          near ? (
            surface ? (
              <Surface3D spec={spec} height={SURFACE_H} animate={fresh} />
            ) : (
              <Scatter3D spec={spec} height={SURFACE_H} animate={fresh} />
            )
          ) : (
            <div style={{ height: SURFACE_H + 26 }} />
          )
        ) : (
          <Chart2D spec={spec} height={LINE_H} animate={fresh} />
        )}
      </div>
      {spec.source || three ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-fs-11.5 leading-fs-16 text-faint">
          {spec.source ? <span className="min-w-0">Source: {spec.source}</span> : <span />}
          {three ? <span className="shrink-0">Drag to rotate · pinch or click then scroll to zoom</span> : null}
        </div>
      ) : null}
    </motion.figure>
  );
}
