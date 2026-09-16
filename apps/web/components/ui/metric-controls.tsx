"use client";

import { useEffect, useRef, useState } from "react";
import { BarChart3, Check, ChevronDown, LineChart } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChartView } from "./metric-chart";

export interface PeriodOption {
  label: string;
  /** How many trailing points of the series this window keeps. */
  points?: number;
}

/* ------------------------------------------------------------------ */
/* View toggle — curve | bars                                          */
/* ------------------------------------------------------------------ */

export function ViewToggle({
  value,
  onChange,
}: {
  value: ChartView;
  onChange: (view: ChartView) => void;
}) {
  const options: Array<{ id: ChartView; Icon: typeof LineChart; label: string }> = [
    { id: "curve", Icon: LineChart, label: "Curve view" },
    { id: "bars", Icon: BarChart3, label: "Bar view" },
  ];

  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-md bg-white/[0.05] p-0.5">
      {options.map(({ id, Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-label={label}
          aria-pressed={value === id}
          className={cn(
            "flex items-center rounded px-1.5 py-1 transition-colors",
            value === id
              ? "bg-white/[0.1] text-foreground"
              : "text-white/40 hover:text-white/70",
          )}
        >
          <Icon className="h-3 w-3" strokeWidth={2} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Period select — quiet text trigger + small menu                     */
/* ------------------------------------------------------------------ */

export function PeriodSelect({
  value,
  options,
  onChange,
  accentText,
}: {
  value: string;
  options: PeriodOption[];
  onChange: (option: PeriodOption) => void;
  accentText?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 text-[13px] text-white/55 transition-colors hover:text-foreground"
      >
        {value}
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-full z-30 mt-1.5 min-w-[9.5rem] overflow-hidden rounded-lg border border-white/[0.1] bg-[#161616] py-1 shadow-xl"
        >
          {options.map((option) => {
            const selected = option.label === value;
            return (
              <button
                key={option.label}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-white/[0.05]",
                  selected ? "text-foreground" : "text-white/55",
                )}
              >
                {option.label}
                {selected ? (
                  <Check
                    className="h-3.5 w-3.5"
                    strokeWidth={2}
                    style={accentText ? { color: accentText } : undefined}
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
