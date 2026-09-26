import { useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { readThemeChoice, writeThemeChoice, type ThemeChoice } from "@/lib/theme";

/**
 * General — the first pane. Appearance heads it, because it is the setting a
 * reader is most likely to have come for and the one whose effect they can
 * see without reading anything.
 */

const THEMES: ReadonlyArray<{ key: ThemeChoice; label: string; icon: LucideIcon }> = [
  { key: "system", label: "Match the system", icon: Monitor },
  { key: "light", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
];

/** Three ways to answer one question, so they are shown as one control. */
function ThemeControl() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-xl border border-white/60 bg-white/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]"
    >
      {THEMES.map(({ key, label, icon: Icon }) => {
        const on = key === choice;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            onClick={() => {
              setChoice(key);
              writeThemeChoice(key);
            }}
            className={cn(
              "flex h-7 w-9 items-center justify-center rounded-[10px] transition-colors duration-150",
              on
                ? "bg-white text-[#1d1b1b] shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
            )}
          >
            <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export default function GeneralPane() {
  return (
    <SettingsSection title="Appearance">
      <SettingsRow label="Theme">
        <ThemeControl />
      </SettingsRow>
    </SettingsSection>
  );
}
