import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { StockCatalogEntry } from "../../../shared/stock-catalog";
import { FIELD } from "./agent-ui";

/**
 * A ticker field with suggestions from the app's own symbol search
 * (`window.meridian.searchStockSymbols`). Without the bridge it is a plain
 * field that upper-cases what is typed.
 */
export default function TickerField({
  value,
  companyName,
  onChange,
  placeholder,
  className,
  ariaLabel,
}: {
  value: string;
  companyName?: string;
  onChange: (ticker: string, companyName?: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<StockCatalogEntry[]>([]);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const q = value.trim();
    const search = window.meridian?.searchStockSymbols;
    if (!open || !q || !search) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      search(q, 6)
        .then((r) => {
          if (live) {
            setResults(Array.isArray(r) ? r : []);
            setActive(0);
          }
        })
        .catch(() => live && setResults([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const pick = (entry: StockCatalogEntry) => {
    onChange(entry.symbol.toUpperCase(), entry.companyName);
    setOpen(false);
  };

  const showList = open && results.length > 0;

  return (
    <div ref={wrap} className={cn("relative", className)}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10), undefined);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(results[active]!);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        role="combobox"
        aria-label={ariaLabel ?? t("agents.trig.ticker")}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={placeholder ?? t("agents.trig.ticker")}
        spellCheck={false}
        className={cn(FIELD, "h-9 font-['Geist_Mono'] text-[12.5px] tracking-[0.02em]")}
      />
      {companyName && !open ? (
        <span className="pointer-events-none absolute right-3 top-1/2 max-w-[55%] -translate-y-1/2 truncate text-[11.5px] text-[#9CA3AF]">
          {companyName}
        </span>
      ) : null}
      <AnimatePresence>
        {showList ? (
          <motion.ul
            id={listId}
            role="listbox"
            {...DROPDOWN_FADE}
            className="app-no-drag absolute left-0 top-full z-50 mt-1.5 w-full min-w-[240px] rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
          >
            {results.map((r, i) => (
              <li
                key={r.symbol}
                role="option"
                aria-selected={i === active}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[12.5px]",
                  i === active && "bg-[#1d1b1b]/[0.07]",
                )}
              >
                <span className="w-14 shrink-0 font-['Geist_Mono'] text-[12px] font-medium text-[#1d1b1b]">{r.symbol}</span>
                <span className="min-w-0 truncate text-[#6b7280]">{r.companyName}</span>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
