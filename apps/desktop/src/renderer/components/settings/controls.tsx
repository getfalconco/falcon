import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The two controls settings rows share: a segmented control for a question
 * with a few answers, and a switch for one that is on or off. Both drawn in
 * the panes' glass, and both right in either theme.
 */

export type SegmentOption<T extends string | number> = {
  value: T;
  label: string;
  /** Drawn instead of the label; the label is then the tooltip and the accessible name. */
  icon?: LucideIcon;
};

/** A few answers to one question, shown as one control. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  /** What the group answers, for assistive tech. */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        "app-no-drag inline-flex items-center gap-0.5 rounded-xl border border-white/60 bg-white/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {options.map(({ value: key, label: text, icon: Icon }) => {
        const on = key === value;
        return (
          <button
            key={String(key)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={Icon ? text : undefined}
            title={Icon ? text : undefined}
            disabled={disabled}
            onClick={() => {
              if (!on) onChange(key);
            }}
            className={cn(
              "flex h-7 items-center justify-center rounded-[10px] transition-colors duration-150",
              Icon ? "w-9" : "px-2.5 text-[12.5px] font-normal",
              on
                ? "bg-white text-[#1d1b1b] shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
            )}
          >
            {Icon ? <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden /> : text}
          </button>
        );
      })}
    </div>
  );
}

/*
 * The switch is drawn in the `--switch-*` tokens (globals.css) rather than
 * the light palette's classes, so the dark-mode layer leaves it alone and
 * each theme sets its track and knob exactly: ink and white in light, a soft
 * off-white track with an ink knob in dark.
 */

/** On or off. */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  /** What it turns on, for assistive tech; the row's own label says it to the eye. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "app-no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-switch-on" : "bg-switch-off",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-[3px] h-4 w-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-[transform,background-color] duration-150",
          checked ? "translate-x-4 bg-switch-knob-on" : "translate-x-0 bg-switch-knob-off",
        )}
      />
    </button>
  );
}
