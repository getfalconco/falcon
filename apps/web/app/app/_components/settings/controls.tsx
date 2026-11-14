"use client";

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Dropdown, type Icon } from "../shell/ui";

/**
 * Settings controls: a row (title, optional description, control at the
 * right), the segmented icon picker, the plain-text select, the pill switch
 * and the soft text field.
 */

export function SettingRow({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-line/[0.08] py-6 last:border-b-0">
      <div className="min-w-0">
        <div id={id} className="text-fs-14 leading-fs-20 text-fore">
          {title}
        </div>
        {description ? <div className="mt-0.5 text-fs-13 leading-fs-19 text-quiet">{description}</div> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

export type Option<T extends string> = { value: T; label: string; icon?: Icon };

/** Icon-only segments in a soft track (theme: monitor / sun / moon). Arrow keys move the choice. */
export function Segmented<T extends string>({ label, labelledBy, value, options, onChange }: { label?: string; labelledBy?: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} aria-labelledby={labelledBy} className="inline-flex gap-0.5 rounded-[10px] border border-line/[0.08] bg-line/[0.03] p-[3px]">
      {options.map((o, i) => {
        const on = o.value === value;
        const I = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            title={o.label}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={`flex h-8 w-11 items-center justify-center rounded-[7px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line/25 ${
              on ? "bg-surface text-fore shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-line/[0.12] dark:shadow-none" : "text-quiet hover:text-fore"
            }`}
          >
            {I ? <I width={16} height={16} strokeWidth={1.75} aria-hidden /> : o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Plain text and a chevron, no box, like "Geist ⌄"; opens a short list. */
export function TextSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <Dropdown
      label={label}
      kind="select"
      align="right"
      width={200}
      groups={[{ items: options.map((o) => ({ id: o.value, label: o.label, selected: o.value === value })) }]}
      onSelect={(id) => onChange(id as T)}
      button={({ open, props }) => (
        <button
          {...props}
          className={`-mr-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-fs-14 text-fore outline-none transition-colors hover:bg-line/[0.05] focus-visible:ring-2 focus-visible:ring-line/20 ${
            open ? "bg-line/[0.06]" : ""
          }`}
        >
          {current.label}
          <ChevronDown width={15} height={15} strokeWidth={1.75} className="text-quiet" aria-hidden />
        </button>
      )}
    />
  );
}

/** Pill switch: ink when on in light, a light accent when on in dark. */
export function Toggle({ checked, onChange, labelledBy, label }: { checked: boolean; onChange: (v: boolean) => void; labelledBy?: string; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line/25 focus-visible:ring-offset-2 focus-visible:ring-offset-raised ${
        checked ? "bg-solid" : "bg-line/[0.16]"
      }`}
    >
      <span
        className={`absolute left-[2px] h-[18px] w-[18px] rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform ${
          checked ? "translate-x-[16px] bg-surface" : "translate-x-0 bg-surface dark:bg-fore-4"
        }`}
        aria-hidden
      />
    </button>
  );
}

/** Text input on a soft filled background. */
export function TextField({ value, onChange, placeholder, labelledBy, className = "" }: { value: string; onChange: (v: string) => void; placeholder?: string; labelledBy?: string; className?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-labelledby={labelledBy}
      className={`h-9 w-[260px] rounded-lg border border-transparent bg-line/[0.05] px-3 text-fs-14 text-fore outline-none transition-colors placeholder:text-faint focus:border-line/20 focus:bg-transparent ${className}`}
    />
  );
}
