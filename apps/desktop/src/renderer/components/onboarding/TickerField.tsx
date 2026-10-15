import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { StockCatalogEntry } from "../../../shared/stock-catalog";
import { addTickers, ONBOARDING_TICKER_CAP, parseTickerInput } from "../../../shared/onboarding-tickers";
import { lookupTicker } from "@/lib/onboarding-reading";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { onboardingInputClass } from "@/components/onboarding/onboarding-ui";

type Props = {
  tickers: string[];
  /** The new list, and the catalog entries of the names just added (their company names go to the watchlist). */
  onChange: (tickers: string[], added?: StockCatalogEntry[]) => void;
  /** Enter on an empty field with names already in: the step's Continue. */
  onSubmit?: () => void;
};

type Problem = { key: MessageKey; params?: Record<string, string | number> };

/**
 * Tickers, typed. Each one is checked against the stock catalog (the same
 * search as the top bar) before it becomes a chip, so the desk only ever
 * holds names that exist. Several can go in at once ("nvda, tsm aapl"), and
 * the catalog's matches show under the field as the reader types.
 */
export default function TickerField({ tickers, onChange, onSubmit }: Props) {
  const t = useT();
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [suggestions, setSuggestions] = useState<StockCatalogEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const full = tickers.length >= ONBOARDING_TICKER_CAP;

  // Matches under the field, for the piece being typed.
  useEffect(() => {
    const piece = text.split(/[\s,;]+/).pop()?.trim() ?? "";
    const search = window.meridian?.searchStockSymbols;
    if (!piece || !search) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(piece, 8)
        .then((rows) => {
          if (cancelled) return;
          setSuggestions(
            rows.filter((r) => !r.symbol.startsWith("^") && !tickers.includes(r.symbol.toUpperCase())).slice(0, 4),
          );
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, tickers]);

  async function commit(raw: string) {
    if (checking) return;
    const { tickers: parsed, rejected } = parseTickerInput(raw);
    if (parsed.length === 0 && rejected.length === 0) {
      if (tickers.length > 0) onSubmit?.();
      return;
    }
    setChecking(true);
    setProblem(null);
    const found: string[] = [];
    const entries: StockCatalogEntry[] = [];
    let miss: Problem | null = rejected[0] ? { key: "auth.onboarding.tickers.notTicker", params: { text: rejected[0] } } : null;
    try {
      for (const ticker of parsed) {
        const entry = await lookupTicker(ticker);
        if (entry) {
          found.push(entry.symbol.toUpperCase());
          entries.push(entry);
        }
        else miss ??= { key: "auth.onboarding.tickers.notFound", params: { symbol: ticker } };
      }
    } catch {
      miss = { key: "auth.onboarding.tickers.unavailable" };
    } finally {
      setChecking(false);
    }
    const next = addTickers(tickers, found);
    if (next.length !== tickers.length) onChange(next, entries);
    if (!miss && next.length >= ONBOARDING_TICKER_CAP && found.length > next.length - tickers.length) {
      miss = { key: "auth.onboarding.tickers.full", params: { count: ONBOARDING_TICKER_CAP } };
    }
    setProblem(miss);
    // Keep what did not go in, so a typo can be fixed in place.
    const leftover = [...rejected, ...parsed.filter((p) => !found.includes(p) && !next.includes(p))];
    setText(miss && miss.key !== "auth.onboarding.tickers.full" ? leftover.join(" ") : "");
    inputRef.current?.focus();
  }

  function pick(entry: StockCatalogEntry) {
    // The piece being typed is replaced by the pick; anything before it stays to be checked on Enter.
    const before = text.split(/[\s,;]+/).slice(0, -1).join(" ");
    setText(before);
    setProblem(null);
    onChange(addTickers(tickers, [entry.symbol.toUpperCase()]), [entry]);
    inputRef.current?.focus();
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        autoFocus
        spellCheck={false}
        autoCapitalize="characters"
        disabled={full}
        placeholder={t("auth.onboarding.tickers.placeholder")}
        aria-label={t("auth.onboarding.tickers.label")}
        aria-invalid={problem && problem.key !== "auth.onboarding.tickers.full" ? true : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (problem) setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "," && text.trim())) {
            e.preventDefault();
            void commit(text);
            return;
          }
          if (e.key === "Backspace" && !text && tickers.length > 0) {
            onChange(tickers.slice(0, -1));
          }
        }}
        onBlur={() => {
          // A name typed and left behind still counts, once it checks out.
          if (text.trim()) window.setTimeout(() => void commit(text), 120);
        }}
        className={cn(onboardingInputClass, "uppercase placeholder:normal-case")}
      />

      {suggestions.length > 0 && text.trim() && !checking ? (
        <div className="absolute z-50 mt-1 w-full overflow-hidden border border-white/10 bg-[#0d0d0d] shadow-xl">
          {suggestions.map((entry) => (
            <button
              key={entry.symbol}
              type="button"
              // Before the field's blur, so the pick wins over the blur's commit.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(entry);
              }}
              className="app-no-drag flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm text-white/80 transition hover:bg-white/[0.05]"
            >
              <span className="w-14 shrink-0 font-medium text-white">{entry.symbol}</span>
              <span className="truncate text-xs text-white/40">{entry.companyName}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-2 min-h-[1.25rem]" aria-live="polite">
        {checking ? (
          <p className="text-xs text-white/40">{t("auth.onboarding.tickers.checking")}</p>
        ) : problem ? (
          <p
            role={problem.key === "auth.onboarding.tickers.full" ? undefined : "alert"}
            className={cn("text-xs", problem.key === "auth.onboarding.tickers.full" ? "text-white/40" : "text-red-400")}
          >
            {t(problem.key, problem.params)}
          </p>
        ) : null}
      </div>

      {tickers.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {tickers.map((ticker) => (
            <button
              key={ticker}
              type="button"
              onClick={() => onChange(tickers.filter((x) => x !== ticker))}
              aria-label={t("auth.onboarding.tickers.remove", { symbol: ticker })}
              className="app-no-drag flex items-center gap-1.5 border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 transition hover:border-white/25 hover:text-white"
            >
              {ticker}
              <X className="h-3 w-3 text-white/40" strokeWidth={2} aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
