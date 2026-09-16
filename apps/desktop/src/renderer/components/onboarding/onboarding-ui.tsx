import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { COUNTRIES } from "@/lib/countries";
import { cn } from "@/lib/utils";

export const onboardingInputClass =
  "app-no-drag w-full border-b border-white/15 bg-transparent px-0 py-2.5 text-sm text-white outline-none transition placeholder:text-[#666666] focus:border-white/40";

export const onboardingTextareaClass = cn(onboardingInputClass, "min-h-[4.5rem] resize-none");

export function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">{children}</div>
      </div>
    </div>
  );
}

export function OnboardingProgress({ index, total }: { index: number; total: number }) {
  // Right-aligned so it never collides with the back button on the left.
  return (
    <p className="app-no-drag pointer-events-none absolute right-8 top-16 text-[10px] uppercase tracking-[0.14em] text-white/25">
      {index} / {total}
    </p>
  );
}

type ContinueButtonProps = {
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
};

export function OnboardingContinueButton({
  disabled,
  loading,
  onClick,
  children,
  className,
}: ContinueButtonProps) {
  const active = !disabled && !loading;
  return (
    <button
      type="button"
      disabled={!active}
      onClick={onClick}
      className={cn(
        "app-no-drag mt-8 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
        active
          ? "border-white/10 bg-white text-black"
          : "cursor-not-allowed border-white/[0.06] bg-[#2a2a2a] text-[#666666]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function OnboardingSkipLink({
  onClick,
  className,
  children = "Skip for now",
}: {
  onClick: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "app-no-drag mt-3 w-full text-center text-xs text-white/35 transition hover:text-white/60",
        className,
      )}
    >
      {children}
    </button>
  );
}

type OptionButtonProps = {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  subtitle?: React.ReactNode;
};

export function OnboardingOptionButton({
  selected,
  onClick,
  children,
  subtitle,
}: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "app-no-drag w-full border px-4 py-3.5 text-left text-sm transition",
        selected
          ? "border-white/25 bg-white/[0.06] text-white"
          : "border-white/10 bg-transparent text-white/70 hover:border-white/20 hover:text-white",
      )}
    >
      <span className="block">{children}</span>
      {subtitle ? (
        <span className="mt-0.5 block text-xs text-white/40">{subtitle}</span>
      ) : null}
    </button>
  );
}

type CountrySelectProps = {
  value: string | null;
  onChange: (name: string) => void;
  placeholder?: string;
};

/**
 * Placeholder country picker with emoji flags. Intended to be replaced by a
 * richer dropdown component later — keep the {value,onChange} contract.
 */
export function OnboardingCountrySelect({
  value,
  onChange,
  placeholder = "Select your country",
}: CountrySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selected = COUNTRIES.find((c) => c.name === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q)
    : COUNTRIES;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          onboardingInputClass,
          "flex items-center justify-between gap-2",
          !selected && "text-[#666666]",
        )}
      >
        <span className="flex items-center gap-2 truncate">
          {selected ? <span aria-hidden>{selected.flag}</span> : null}
          <span className="truncate">{selected ? selected.name : placeholder}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-white/40" strokeWidth={1.75} />
      </button>

      {open ? (
        <div className="absolute z-50 mt-2 max-h-64 w-full overflow-hidden border border-white/10 bg-[#0d0d0d] shadow-xl">
          <input
            type="text"
            autoFocus
            placeholder="Search…"
            aria-label="Search country"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="app-no-drag w-full border-b border-white/10 bg-transparent px-4 py-2.5 text-sm text-white outline-none placeholder:text-[#666666]"
          />
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-sm text-white/40">No match</p>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => {
                    onChange(c.name);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="app-no-drag flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-white/80 transition hover:bg-white/[0.05]"
                >
                  <span aria-hidden>{c.flag}</span>
                  <span className="truncate">{c.name}</span>
                  {selected?.code === c.code ? (
                    <Check className="ml-auto h-4 w-4 text-white/60" strokeWidth={1.75} />
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ChipInputProps = {
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  placeholder?: string;
};

/** Freeform tag input: type a ticker or company name, press Enter/comma to add. */
export function OnboardingChipInput({ values, onAdd, onRemove, placeholder }: ChipInputProps) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const target = e.currentTarget;
    if ((e.key === "Enter" || e.key === ",") && target.value.trim()) {
      e.preventDefault();
      onAdd(target.value.trim());
      target.value = "";
      return;
    }
    if (e.key === "Backspace" && !target.value && values.length > 0) {
      onRemove(values[values.length - 1]!);
    }
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder}
        onKeyDown={handleKeyDown}
        className={onboardingInputClass}
      />
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {values.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onRemove(value)}
              className="app-no-drag flex items-center gap-1.5 border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 transition hover:border-white/25 hover:text-white"
            >
              {value.toUpperCase()}
              <X className="h-3 w-3 text-white/40" strokeWidth={2} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
