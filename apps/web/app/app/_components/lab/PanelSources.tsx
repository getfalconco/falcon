"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { dataNumbers, parseShown, type CiteReport } from "@/lib/desk/citations";
import { matchFigure, measureOf, panelFigures, partOf, type PanelFigure } from "@/lib/desk/citation-panel";
import { PanelSourceCard } from "./SourceCite";
import { useRunStats } from "./RunHonesty";
import type { LabRun } from "./run";

/**
 * The results panel's numbers as sources: wraps a panel section (RunPanel's
 * Overview) and, on a click on a number (a tile value, a key stats cell),
 * opens the source card naming the audit or result field it shows
 * (lib/desk/citation-panel.ts), and whether the chat quotes that same field.
 * It reads the DOM it wraps, so the panel's markup needs no change.
 */

/** Each strategy test's chat citation check, by run id (LabChat provides it). */
export const ChatCites = createContext<Map<string, CiteReport> | null>(null);

const BENCH: Record<string, string> = { cagr: "bench_cagr", sharpe: "bench_sharpe", max_dd: "bench_max_dd" };

export function PanelSources({ run, children }: { run: LabRun; children: ReactNode }) {
  const st = useRunStats(run);
  const report = useContext(ChatCites)?.get(run.id);
  const figs = useMemo(() => panelFigures({ headline: st?.headline, split: st?.split, whole: st?.whole, metrics: run.result?.metrics as Record<string, unknown> | undefined }), [st, run.result]);
  // The panel fields the chat's audit citations resolved to.
  const quoted = useMemo(() => {
    const out = new Set<string>();
    for (const c of report?.checks ?? []) {
      if (c.status !== "verified" || (c.ref !== "audit" && c.tool !== "audit_run")) continue;
      const f = matchFigure(figs, c.label, { measure: measureOf(c.field ?? ""), part: partOf(c.field ?? "") });
      if (f) out.add(f.path);
    }
    return out;
  }, [report, figs]);
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<PanelFigure | null>(null);
  const close = useCallback(() => setOpen(null), []);

  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("td, span, dd");
    if (!el || el.closest("button, a, [role=button], [role=dialog]")) return;
    const text = (el.textContent ?? "").trim();
    const nums = dataNumbers(text);
    const token = nums.length === 1 ? nums[0]!.text : /^[-+]?\d+$/.test(text) ? text : null;
    if (!token || !parseShown(token)) return;
    // The measure from the row (key stats) or the tile's label; the part from the column header.
    const row = el.closest("tr");
    const label = row?.querySelector("th")?.textContent ?? (el.parentElement?.firstElementChild !== el ? el.parentElement?.firstElementChild?.textContent : null) ?? "";
    let measure = measureOf(label);
    // A tile's second line ("SPY +10.1%") is the benchmark's figure.
    if (measure && BENCH[measure] && /^[A-Z^][\w.^-]*\s/.test(text)) measure = BENCH[measure]!;
    const cell = el.closest("td");
    const header = cell && row ? el.closest("table")?.querySelectorAll("thead th")[Array.from(row.children).indexOf(cell)]?.textContent : null;
    const fig = matchFigure(figs, token, { measure, part: partOf(header ?? "") ?? (st?.headline.main.id ?? null) });
    if (!fig) return;
    anchor.current = el;
    setOpen(fig);
  };

  return (
    <div className="contents [&_td.tabular-nums]:cursor-pointer [&_span.tabular-nums]:cursor-pointer" onClick={onClick}>
      {children}
      {open ? <PanelSourceCard anchor={anchor} fig={open} quoted={quoted.has(open.path)} lang="en" onClose={close} /> : null}
    </div>
  );
}
