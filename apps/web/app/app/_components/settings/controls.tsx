"use client";

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Dropdown, type Icon } from "../shell/ui";

/**
 * Settings controls, sized after the Claude desktop app's Settings dialog:
 * a row (title, optional description, control at the right), the icon
 * segmented pill, the plain "Value ⌄" select, the boxed select, the filled
 * text input, the pill switch, the text segmented control and the filled button.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/25";

/** One setting: 50px tall with a title only, 64px with a description; thin divider below except on the last row. */
export function SettingRow({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="flex min-h-[50px] items-center justify-between gap-8 border-b border-line/[0.08] py-[10px] last:border-b-0">
      <div className="min-w-0">
        <div id={id} className="text-fs-14 leading-fs-22 text-fore">
          {title}
        </div>
        {description ? <div className="text-fs-14 leading-fs-22 text-quiet">{description}</div> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** Section heading inside the right column ("General"). */
export function SectionHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-fs-16 font-medium leading-fs-24 text-fore">
      {children}
    </h3>
  );
}

export type Option<T extends string> = { value: T; label: string; icon?: Icon };

/** Track with one raised square per choice (theme: monitor / sun / moon). Arrow keys move the choice. */
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
    <div role="radiogroup" aria-label={label} aria-labelledby={labelledBy} className="inline-flex h-[26px] items-center rounded-[8px] bg-line/[0.05]">
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
            className={`flex h-[26px] w-[25px] items-center justify-center rounded-[7px] border transition-colors ${FOCUS} ${
              on ? "border-line/[0.14] bg-surface text-fore shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-line/[0.1] dark:shadow-none" : "border-transparent text-fore-3 hover:text-fore"
            }`}
          >
            {I ? <I width={15} height={15} strokeWidth={1.5} aria-hidden /> : o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Text segmented control ("Normal | Thinking | Verbose"): a soft track, the choice raised with a hairline border. */
export function TextSegmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-[26px] items-center rounded-[8px] bg-line/[0.05]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`h-[26px] rounded-[7px] border px-3 text-fs-14 transition-colors ${FOCUS} ${
              on ? "border-line/[0.14] bg-surface text-fore dark:bg-line/[0.1]" : "border-transparent text-fore-3 hover:text-fore"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Plain text and a chevron, no box, like "Anthropic Sans ⌄"; opens a short list. */
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
          className={`inline-flex h-[26px] items-center gap-[10px] rounded-[7px] px-3 text-fs-14 text-fore transition-colors hover:bg-line/[0.05] ${FOCUS} ${open ? "bg-line/[0.06]" : ""}`}
        >
          {current.label}
          <ChevronDown width={14} height={14} strokeWidth={1.5} className="text-fore-3" aria-hidden />
        </button>
      )}
    />
  );
}

/** A filled, full-width select ("Claude Light ⌄" over a preview). */
export function BoxSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <Dropdown
      label={label}
      kind="select"
      width={240}
      className="w-full"
      groups={[{ items: options.map((o) => ({ id: o.value, label: o.label, selected: o.value === value })) }]}
      onSelect={(id) => onChange(id as T)}
      button={({ props }) => (
        <button {...props} className={`flex h-[26px] w-full items-center justify-between rounded-[7px] bg-line/[0.06] pl-2 pr-3 text-left text-fs-14 text-fore transition-colors hover:bg-line/[0.08] ${FOCUS}`}>
          <span className="truncate">{current.label}</span>
          <ChevronDown width={14} height={14} strokeWidth={1.5} className="shrink-0 text-fore-3" aria-hidden />
        </button>
      )}
    />
  );
}

/** Pill switch, blue when on as in the reference. */
export function Toggle({ checked, onChange, labelledBy, label }: { checked: boolean; onChange: (v: boolean) => void; labelledBy?: string; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[18px] w-[33px] shrink-0 items-center rounded-full transition-colors ${FOCUS} ${checked ? "bg-[#2f7cf6]" : "bg-line/[0.18]"}`}
    >
      <span
        className={`absolute left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform ${checked ? "translate-x-[15px]" : "translate-x-0"}`}
        aria-hidden
      />
    </button>
  );
}

/** Filled text input ("e.g. JetBrains Mono"). */
export function TextField({ value, onChange, placeholder, labelledBy, className = "" }: { value: string; onChange: (v: string) => void; placeholder?: string; labelledBy?: string; className?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-labelledby={labelledBy}
      className={`h-[26px] w-[205px] rounded-[7px] bg-line/[0.06] px-[11px] text-fs-14 text-fore placeholder:text-faint ${FOCUS} ${className}`}
    />
  );
}

/** Filled button ("Open Appearance"). */
export function FilledButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`h-[26px] rounded-[7px] bg-line/[0.08] px-[9px] text-fs-14 text-fore transition-colors hover:bg-line/[0.12] ${FOCUS}`}>
      {children}
    </button>
  );
}
