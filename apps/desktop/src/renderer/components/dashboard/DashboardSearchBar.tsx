import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, LayoutDashboard, Loader2, Search, TrendingUp } from "lucide-react";
import {
  CommandMenu,
  CommandMenuContent,
  CommandMenuEmpty,
  CommandMenuGroup,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuSeparator,
  CommandMenuTrigger,
  getModifierKey,
  useCommandMenu,
  useCommandMenuShortcut,
} from "@/components/ui/command-menu";
import { Kbd } from "@/components/ui/kbd";
import StockIcon from "@/components/stock/StockIcon";
import {
  addRecentStockSearch,
  getRecentStockSearches,
  subscribeRecentStockSearches,
} from "@/lib/recent-stock-search";
import { getStockQuote, searchStockSymbols } from "@/lib/stock-api";
import { formatSignedPercent, formatStockPrice } from "@/lib/stock-format";
import { cn } from "@/lib/utils";
import type { StockCatalogEntry } from "../../../shared/stock-catalog";

/**
 * "Search anything" for the rebuilt (light) dashboard shell. The top-bar pill
 * is only a trigger; the real UI is a ⌘K command menu: stocks (recent /
 * trending / live-priced matches) plus app navigation in one list.
 */

export type DashboardSearchTarget = "dashboard";

type Props = {
  onSelect: (entry: StockCatalogEntry) => void;
  onNavigate?: (target: DashboardSearchTarget) => void;
  className?: string;
};

type NavAction = {
  id: DashboardSearchTarget;
  label: string;
  hint: string;
  icon: React.ReactNode;
  keywords: string;
};

const NAV_ACTIONS: NavAction[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    hint: "Portfolio, assets, insight, risk",
    icon: <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />,
    keywords: "dashboard home portfolio assets",
  },
];

function isIndexSymbol(symbol: string): boolean {
  return symbol.startsWith("^");
}

function cleanTicker(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
}

/** Live price + day change, fetched lazily per visible row. */
function QuoteTail({ symbol }: { symbol: string }) {
  const [price, setPrice] = useState<number | null>(null);
  const [changePercent, setChangePercent] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getStockQuote(symbol)
      .then((q) => {
        if (cancelled) return;
        setPrice(Number.isFinite(q.price) ? q.price : null);
        setChangePercent(Number.isFinite(q.changePercent) ? q.changePercent : null);
      })
      .catch(() => {
        if (!cancelled) {
          setPrice(null);
          setChangePercent(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const up = (changePercent ?? 0) >= 0;
  return (
    <span className="ml-auto shrink-0 text-right tabular-nums">
      <span className="block text-[12.5px] font-medium text-[#1d1b1b]">
        {price != null ? formatStockPrice(price) : "—"}
      </span>
      <span
        className={cn(
          "block text-[11px] font-medium leading-tight",
          changePercent == null ? "text-[#9CA3AF]" : up ? "text-[#16A34A]" : "text-[#DC2626]",
        )}
      >
        {changePercent != null ? formatSignedPercent(changePercent) : ""}
      </span>
    </span>
  );
}

function StockRowBody({ entry }: { entry: StockCatalogEntry }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#E3E3E0]">
        <StockIcon
          symbol={entry.symbol}
          companyName={entry.companyName}
          size="sm"
          className="h-4 w-4 object-contain"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-[#1d1b1b]">
          {entry.symbol}
          {entry.exchange ? (
            <span className="ml-1.5 text-[10.5px] font-medium text-[#9CA3AF]">{entry.exchange}</span>
          ) : null}
        </span>
        <span className="block truncate text-[11.5px] text-[#6b7280]">{entry.companyName}</span>
      </span>
      <QuoteTail symbol={entry.symbol} />
    </span>
  );
}

/**
 * Lives inside CommandMenuContent so it can read the shared query value.
 * Builds one flat, sequentially-indexed list across groups — the menu's
 * keyboard navigation walks `[data-command-item]` in DOM order.
 */
function SearchBody({
  onPickStock,
  onPickNav,
}: {
  onPickStock: (entry: StockCatalogEntry) => void;
  onPickNav: (target: DashboardSearchTarget) => void;
}) {
  const { value, setSelectedIndex } = useCommandMenu();
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<StockCatalogEntry[]>([]);
  const [trending, setTrending] = useState<StockCatalogEntry[]>([]);
  const [recent, setRecent] = useState<StockCatalogEntry[]>(getRecentStockSearches);

  useEffect(() => subscribeRecentStockSearches(() => setRecent(getRecentStockSearches())), []);

  // Trending for the empty state — once per open.
  useEffect(() => {
    let cancelled = false;
    void searchStockSymbols("", 12)
      .then((entries) => {
        if (!cancelled) setTrending(entries.filter((e) => !isIndexSymbol(e.symbol)).slice(0, 6));
      })
      .catch(() => {
        if (!cancelled) setTrending([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const query = value.trim();
  const searching = query.length > 0;

  // Debounced stock matches.
  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchStockSymbols(query, 8)
        .then((entries) => {
          if (!cancelled) setResults(entries);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const navMatches = useMemo(() => {
    if (!searching) return NAV_ACTIONS;
    const q = query.toLowerCase();
    return NAV_ACTIONS.filter(
      (a) => a.label.toLowerCase().includes(q) || a.keywords.includes(q),
    );
  }, [query, searching]);

  const stockRows = searching ? results : [];
  const recentRows = searching ? [] : recent.slice(0, 4);
  const trendingRows = searching ? [] : trending;
  const total = stockRows.length + recentRows.length + trendingRows.length + navMatches.length;

  // A new result set starts from the top again.
  useEffect(() => setSelectedIndex(0), [query, total, setSelectedIndex]);

  // Nothing to pick but a plausible ticker typed — Enter opens it anyway.
  useEffect(() => {
    if (!searching || loading || total > 0) return;
    const symbol = cleanTicker(query);
    if (!symbol) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onPickStock({ symbol, companyName: symbol });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searching, loading, total, query, onPickStock]);

  let index = 0;
  const next = () => index++;

  return (
    <CommandMenuList maxHeight="360px">
      {searching && loading && stockRows.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-[#9CA3AF]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        </div>
      ) : null}

      {searching && !loading && total === 0 ? (
        <CommandMenuEmpty>
          No results for “{query}”
          {cleanTicker(query) ? (
            <>
              {" "}
              — press <Kbd size="xs">↵</Kbd> to open{" "}
              <span className="font-semibold text-[#1d1b1b]">{cleanTicker(query)}</span> anyway.
            </>
          ) : null}
        </CommandMenuEmpty>
      ) : null}

      {stockRows.length > 0 ? (
        <CommandMenuGroup heading="Stocks">
          {stockRows.map((entry) => (
            <CommandMenuItem
              key={`s-${entry.symbol}`}
              index={next()}
              onSelect={() => onPickStock(entry)}
            >
              <StockRowBody entry={entry} />
            </CommandMenuItem>
          ))}
        </CommandMenuGroup>
      ) : null}

      {recentRows.length > 0 ? (
        <CommandMenuGroup heading="Recent">
          {recentRows.map((entry) => (
            <CommandMenuItem
              key={`r-${entry.symbol}`}
              index={next()}
              icon={<Clock className="h-4 w-4 text-[#9CA3AF]" strokeWidth={1.75} />}
              onSelect={() => onPickStock(entry)}
            >
              <StockRowBody entry={entry} />
            </CommandMenuItem>
          ))}
        </CommandMenuGroup>
      ) : null}

      {trendingRows.length > 0 ? (
        <>
          {recentRows.length > 0 ? <CommandMenuSeparator /> : null}
          <CommandMenuGroup heading="Trending">
            {trendingRows.map((entry) => (
              <CommandMenuItem
                key={`t-${entry.symbol}`}
                index={next()}
                icon={<TrendingUp className="h-4 w-4 text-[#9CA3AF]" strokeWidth={1.75} />}
                onSelect={() => onPickStock(entry)}
              >
                <StockRowBody entry={entry} />
              </CommandMenuItem>
            ))}
          </CommandMenuGroup>
        </>
      ) : null}

      {navMatches.length > 0 ? (
        <>
          {total > navMatches.length ? <CommandMenuSeparator /> : null}
          <CommandMenuGroup heading="Navigate">
            {navMatches.map((action) => (
              <CommandMenuItem
                key={`n-${action.id}`}
                index={next()}
                icon={action.icon}
                onSelect={() => onPickNav(action.id)}
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium text-[#1d1b1b]">{action.label}</span>
                  <span className="truncate text-[11.5px] text-[#6b7280]">{action.hint}</span>
                </span>
              </CommandMenuItem>
            ))}
          </CommandMenuGroup>
        </>
      ) : null}
    </CommandMenuList>
  );
}

/** Where the menu should appear: under the cursor (⌘K) or pinned to the pill. */
type Anchor = { x: number; y: number; mode: "cursor" | "pill" };

const MENU_WIDTH = 576; // max-w-xl
const MARGIN = 8;

export default function DashboardSearchBar({ onSelect, onNavigate, className }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);
  const mouse = useRef({ x: 0, y: 0 });
  const pillRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Last known pointer position — ⌘K opens the menu right there.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouse.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  useCommandMenuShortcut(
    useCallback(() => {
      setAnchor({ x: mouse.current.x, y: mouse.current.y, mode: "cursor" });
      setOpen(true);
    }, []),
  );

  // Track the menu's real height so it never runs off the bottom edge.
  useEffect(() => {
    if (!open) {
      setMenuHeight(0);
      return;
    }
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setMenuHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const pickStock = useCallback(
    (entry: StockCatalogEntry) => {
      addRecentStockSearch(entry);
      setOpen(false);
      onSelect(entry);
    },
    [onSelect],
  );

  const pickNav = useCallback(
    (target: DashboardSearchTarget) => {
      setOpen(false);
      onNavigate?.(target);
    },
    [onNavigate],
  );

  const mod = getModifierKey().symbol;

  // Positioning — clamped so the whole menu stays on screen.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 680;
  const width = Math.min(MENU_WIDTH, vw - MARGIN * 2);
  const estHeight = menuHeight || 420;
  let left = (vw - width) / 2;
  let top = vh * 0.26;
  if (anchor?.mode === "cursor") {
    left = anchor.x + 4;
    top = anchor.y + 4;
  } else if (anchor?.mode === "pill") {
    // Sit where the pill is, centred on it, so the input takes its place.
    left = anchor.x - width / 2;
    top = anchor.y;
  }
  left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - estHeight - MARGIN));

  return (
    <CommandMenu open={open} onOpenChange={setOpen}>
      <CommandMenuTrigger asChild>
        <button
          ref={pillRef}
          type="button"
          aria-label="Search anything"
          onClick={() => {
            const r = pillRef.current?.getBoundingClientRect();
            if (r) setAnchor({ x: r.left + r.width / 2, y: r.top - 6, mode: "pill" });
          }}
          className={cn(
            "app-no-drag flex h-9 items-center gap-2 rounded-full border border-white/60 bg-white/55 px-3.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors hover:bg-white/70",
            className,
          )}
        >
          <Search className="h-4 w-4 shrink-0 text-[#6b7280]" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-[#9CA3AF]">Search anything</span>
          <span className="flex shrink-0 items-center gap-1">
            <Kbd size="xs">{mod}</Kbd>
            <Kbd size="xs">K</Kbd>
          </span>
        </button>
      </CommandMenuTrigger>

      <CommandMenuContent
        ref={contentRef}
        overlayClassName="bg-black/10 backdrop-blur-[3px]"
        className="max-w-none translate-x-0 translate-y-0 rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_24px_64px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
        style={{ left, top, width }}
      >
        <CommandMenuInput
          placeholder="Search anything"
          className="text-[14px] text-[#1d1b1b] placeholder:text-[#9CA3AF]"
        />
        <SearchBody onPickStock={pickStock} onPickNav={pickNav} />
      </CommandMenuContent>
    </CommandMenu>
  );
}
