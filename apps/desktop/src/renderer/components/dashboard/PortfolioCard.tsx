import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Layers,
  Eye,
  EyeOff,
  GripVertical,
  MoreVertical,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { BrokerageAccount } from "../../../shared/snaptrade";
import StockIcon from "@/components/stock/StockIcon";
import {
  readPaperAccount,
  subscribePaperAccount,
  type PaperAccount,
} from "@/lib/paper-account";
import { isEtfTicker } from "@/lib/etf-tickers";
import { useLiveQuotes } from "@/hooks/useLivePrices";
import { usePositionQuant } from "@/hooks/usePositionQuant";
import { usePositionReach } from "@/hooks/usePositionReach";
import { openStock } from "@/lib/stock-open";
import CurrencyFlag from "@/components/dashboard/CurrencyFlag";
import ConnectPortfolioEmpty, { usePortfolioConnected } from "@/components/dashboard/ConnectPortfolioEmpty";
import SelectionGloss, { type GlossScope } from "@/components/dashboard/SelectionGloss";
import { currencyOr } from "@/lib/currencies";
import { useDemoMode } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

/**
 * Portfolio card in the Growth Forecast card's exact frame: every open
 * position with live-priced PnL in dollars and percent, plus the total
 * PnL and overall income % up top. Colored text only — no badges.
 */

function pnlTone(v: number): string {
  if (v > 0) return "text-[#16A34A]";
  if (v < 0) return "text-[#DC2626]";
  return "text-[#6b7280]";
}

function fmtUsd(v: number, sign = false): string {
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : sign && v > 0 ? "+" : ""}$${s}`;
}

/**
 * Line under the PnL, tiered by move size so coaching only appears when it
 * means something. Below ±1% it's plain fact (daily noise deserves no
 * drama); ±1–5% acknowledges the move; past ±5% the coaching voice is
 * earned. Rotates daily within a tier; returned in parts so the dollar
 * amount can render colored.
 */
/** What the cash balance is denominated in. The paper book is dollars; the
 *  row looks the currency up rather than spelling it out, so this is the
 *  only line that changes when a balance carries its own. */
const CASH_CURRENCY = "USD";

/** `€4,120.55` · `¥612,400` · `CHF 980.20` — a balance in its own currency. */
function fmtNative(code: string, amount: number): string {
  const { symbol } = currencyOr(code);
  const digits = Number.isInteger(amount) ? 0 : 2;
  const value = amount.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // A lettered symbol needs the space a glyph doesn't: "CHF980" reads as one word.
  return `${symbol}${symbol.length > 1 ? " " : ""}${value}`;
}

/**
 * The line under the P&L. It says where the number came from, not how to
 * feel about it: which holdings carry most of the gains, or of the losses,
 * and how much of them. A terminal that cheers on green days and frets on
 * red ones amplifies the mood it should be steadying, and a line with a view
 * in it is a line that reads as advice.
 *
 * The share is of the gross figure on the same side as the total: of all the
 * gains when the book is up, of all the losses when it is down. Offsetting
 * positions are left out of the denominator, so the share never reads over
 * one hundred and always describes what the named holdings actually did.
 */
function pnlMessageParts(
  pnl: number,
  rows: ReadonlyArray<{ symbol: string; pnl: number }>,
): { before: string; amount: string | null; after: string } {
  if (Math.abs(pnl) < 0.005) return { before: "Flat for now.", amount: null, after: "" };
  const up = pnl > 0;
  const side = rows
    .filter((r) => (up ? r.pnl > 0 : r.pnl < 0))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  const gross = side.reduce((sum, r) => sum + Math.abs(r.pnl), 0);
  const before = up ? "Up " : "Down ";
  const amount = fmtUsd(Math.abs(pnl));
  const noun = up ? "gains" : "losses";
  if (side.length === 0 || gross <= 0) return { before, amount, after: "." };

  // Name the holdings that carry the figure: one if it carries most of it
  // alone, otherwise the top two.
  const named = side.slice(0, side[0].pnl / gross >= 0.5 ? 1 : 2);
  const share = Math.round((named.reduce((sum, r) => sum + Math.abs(r.pnl), 0) / gross) * 100);
  const who = named.map((r) => r.symbol).join(" and ");
  if (named.length === side.length && share >= 100) {
    return { before, amount, after: `. All of the ${noun} from ${who}.` };
  }
  return { before, amount, after: `. ${share}% of the ${noun} from ${who}.` };
}
/**
 * The table over the holdings, in reading order — and that order never
 * changes. A narrow card shows the head of it and the rest is simply off the
 * edge; widening the card reveals the next column, then the next, the way
 * pulling a spreadsheet wider does. Columns never trade places or appear in
 * the middle of the run, which is what made them read as popping in.
 */
type ColumnKey =
  | "qty"
  | "last"
  | "avgCost"
  | "value"
  | "weight"
  | "beta"
  | "exposure"
  | "reaching"
  | "dayPnl"
  | "totalPnl"
  | "vol30"
  | "mom20"
  | "residZ"
  | "w52"
  | "earnings"
  | "riskShare";

/** Which part of the settings panel a column is listed under. */
type ColumnSection = "data" | "quant";

const COLUMNS: Array<{ key: ColumnKey; label: string; w: number; section: ColumnSection; title?: string }> = [
  { key: "qty", label: "Qty", w: 64, section: "data" },
  { key: "last", label: "Last", w: 78, section: "data" },
  { key: "avgCost", label: "Avg cost", w: 84, section: "data" },
  { key: "value", label: "Value", w: 92, section: "data" },
  { key: "weight", label: "Weight", w: 62, section: "data" },
  { key: "beta", label: "Beta", w: 56, section: "data", title: "90-day beta to the benchmark" },
  {
    key: "exposure",
    label: "Exposure",
    w: 92,
    section: "data",
    title: "Value × beta: the position's market exposure in dollars",
  },
  {
    key: "reaching",
    label: "Reaching",
    w: 76,
    section: "data",
    title: "Live propagation events that reach this name. Click to open it",
  },
  { key: "dayPnl", label: "Day P&L", w: 88, section: "data" },
  { key: "totalPnl", label: "Total P&L", w: 96, section: "data" },
  { key: "vol30", label: "Vol 30d", w: 66, section: "quant", title: "Daily volatility over 30 days" },
  { key: "mom20", label: "Mom 20d", w: 70, section: "quant", title: "20-day momentum" },
  {
    key: "residZ",
    label: "Resid z",
    w: 66,
    section: "quant",
    title: "Today's move with beta × market taken out, in standard deviations",
  },
  { key: "w52", label: "52w", w: 72, section: "quant", title: "Distance from the 52-week high / low" },
  {
    key: "earnings",
    label: "Earnings",
    w: 70,
    section: "quant",
    title: "Sessions until the next earnings print",
  },
  {
    key: "riskShare",
    label: "Risk share",
    w: 76,
    section: "quant",
    title: "Share of the book's standalone risk (value × volatility) from this position",
  },
];

/** Which columns the reader keeps and in what order — remembered. */
const COLUMN_PREFS_KEY = "falcon.ui.positionsColumns.v3";
type ColumnPrefs = { order: ColumnKey[]; hidden: ColumnKey[] };
/**
 * The reading order the table opens with and Reset returns to: quantity by
 * the name, then price, cost, value, share, and the two P&Ls on the right —
 * a spreadsheet's order, left to right. `COLUMNS` above is a lookup, not
 * the order; the reader's own order lives in their prefs.
 */
const DEFAULT_COLUMN_ORDER: ColumnKey[] = [
  "qty",
  "last",
  "avgCost",
  "value",
  "weight",
  "beta",
  "exposure",
  "reaching",
  "dayPnl",
  "totalPnl",
  "vol30",
  "mom20",
  "residZ",
  "w52",
  "earnings",
  "riskShare",
];
/**
 * Off until asked for: quantity and average cost are bookkeeping, not a
 * decision; the quant set is for the reader who wants the numbers behind
 * the read. Everything else is on.
 */
const DEFAULT_HIDDEN: ColumnKey[] = [
  "qty",
  "avgCost",
  "vol30",
  "mom20",
  "residZ",
  "w52",
  "earnings",
  "riskShare",
];

function isColumnKey(v: unknown): v is ColumnKey {
  return typeof v === "string" && DEFAULT_COLUMN_ORDER.includes(v as ColumnKey);
}

function loadColumnPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ColumnPrefs>) : null;
    const order = Array.isArray(parsed?.order) ? parsed.order.filter(isColumnKey) : [];
    const unique = Array.from(new Set(order));
    // A column added since goes on the end, never lost.
    const full = [...unique, ...DEFAULT_COLUMN_ORDER.filter((k) => !unique.includes(k))];
    const hidden = Array.isArray(parsed?.hidden) ? parsed.hidden.filter(isColumnKey) : [];
    // A column this install has never seen takes its default, not "on".
    const fresh = DEFAULT_HIDDEN.filter((k) => !order.includes(k));
    if (!parsed) return { order: DEFAULT_COLUMN_ORDER, hidden: DEFAULT_HIDDEN };
    return { order: full, hidden: Array.from(new Set([...hidden, ...fresh])) };
  } catch {
    return { order: DEFAULT_COLUMN_ORDER, hidden: DEFAULT_HIDDEN };
  }
}

/**
 * One line of the Data list in the settings menu: a grip that reorders it,
 * a box that shows or hides it, and its name. The grip is the only drag
 * handle — the checkbox and label are ordinary controls.
 */
function ColumnRow({
  column,
  checked,
  onToggle,
}: {
  column: (typeof COLUMNS)[number];
  checked: boolean;
  onToggle: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={column.key}
      dragListener={false}
      dragControls={controls}
      className="flex select-none items-center gap-2 rounded-lg px-1 py-1 text-[12.5px] text-[#1d1b1b]"
      whileDrag={{ scale: 1.02, backgroundColor: "rgba(255,255,255,0.8)" }}
    >
      <span
        onPointerDown={(e) => controls.start(e)}
        className="cursor-grab text-[#B4B4AE] active:cursor-grabbing"
        aria-label={`Drag to reorder ${column.label}`}
        role="button"
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
      </span>
      <button type="button" onClick={onToggle} className="flex-1 text-left font-normal">
        {column.label}
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`${checked ? "Hide" : "Show"} ${column.label}`}
        onClick={onToggle}
        className={cn(
          "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
          checked ? "border-[#1d1b1b] bg-[#1d1b1b] text-white" : "border-black/20 bg-white/60",
        )}
      >
        {checked ? <Check className="h-[10px] w-[10px]" strokeWidth={3} aria-hidden /> : null}
      </button>
    </Reorder.Item>
  );
}

/**
 * What the model is told a highlight in this table is, when the cell itself
 * cannot say — a group line, a heading. The cells carry their own column.
 */
const TABLE_CONTEXT =
  "A figure from the Positions table of an investor's portfolio: columns are " +
  COLUMNS.map((c) => (c.title ? `${c.label} (${c.title})` : c.label)).join(", ") +
  ".";

/** The name column never gives up more than this, whatever the table wants. */
const NAME_MIN = 116;
/** The gap between columns (Tailwind's gap-3), counted when they are measured. */
const COL_GAP = 12;

/** The position groups, in the order the card lists them. */
const GROUPS = [
  { key: "stocks", label: "Stocks" },
  { key: "etfs", label: "ETFs" },
] as const;

/** Privacy mask: always five stars, no digits, no separators. */
const MASKED_MONEY = "$*****";

export default function PortfolioCard({
  masked = false,
  onToggleMasked,
  onDuplicate,
  onRemove,
}: {
  masked?: boolean;
  onToggleMasked?: () => void;
  /** Three-dot menu: open a copy of this card on the dashboard. */
  onDuplicate?: () => void;
  /** Three-dot menu: take this card off the dashboard. */
  onRemove?: () => void;
}) {
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  const [brokerAccounts, setBrokerAccounts] = useState<BrokerageAccount[]>([]);
  /** The book reads by what a holding is, not by which account it sits in. */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    stocks: true,
    etfs: true,
    cash: true,
    connected: true,
  });
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  // The three-dot menu. It closes the way every menu closes: a click
  // anywhere else, or Escape. The listener only exists while it is open.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Nothing linked yet — the card shows the way in instead of an empty table. */
  const connected = usePortfolioConnected();

  /** The reader's column choices — hidden ones and the order of the rest. */
  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs>(loadColumnPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(columnPrefs));
    } catch {
      /* non-fatal */
    }
  }, [columnPrefs]);
  const toggleColumn = (key: ColumnKey) =>
    setColumnPrefs((p) => ({
      ...p,
      hidden: p.hidden.includes(key) ? p.hidden.filter((k) => k !== key) : [...p.hidden, key],
    }));

  /**
   * Sorting, from a column's head: first click orders the book by that
   * figure descending, the second flips it ascending, the third lets go and
   * the list returns to its own order. One column at a time; picking a new
   * one starts it at descending.
   */
  const [sort, setSort] = useState<{ key: ColumnKey; dir: "desc" | "asc" } | null>(null);
  const cycleSort = (key: ColumnKey) =>
    setSort((cur) => {
      if (cur?.key !== key) return { key, dir: "asc" };
      return cur.dir === "asc" ? { key, dir: "desc" } : null;
    });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  // The panel is portalled to the body: inside the card it was clipped by the
  // card's overflow the moment the list of columns outgrew the space under
  // the button. It sits at the button's corner in viewport terms and never
  // grows past the bottom of the window — past that it scrolls.
  const [settingsPos, setSettingsPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const place = () => {
      const r = settingsRef.current?.getBoundingClientRect();
      if (r) setSettingsPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!settingsRef.current?.contains(t) && !settingsPanelRef.current?.contains(t)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  /** The search pill: closed, it is the glyph; open, it is the top bar's
   *  pill grown out of it, and the glyph has slid left to make room. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);

  // Connected real brokerages (SnapTrade) appear as sibling nodes.
  useEffect(() => {
    let cancelled = false;
    void window.meridian
      ?.getBrokerageNetWorth?.()
      .then((res) => {
        if (!cancelled && res?.ok && res.networth.connected) {
          setBrokerAccounts(res.networth.accounts);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Shared price source — the same quotes the headline and the chart use, so
  // this card can't report a loss the net-worth number doesn't show.
  const symbolsKey = Object.keys(account.positions).sort().join(",");
  const quotes = useLiveQuotes(symbolsKey);
  const quant = usePositionQuant(symbolsKey);
  const reach = usePositionReach(symbolsKey);
  const prices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [symbol, q] of Object.entries(quotes)) out[symbol] = q.price;
    return out;
  }, [quotes]);

  /**
   * How wide the list is, so the table can show what fits. A narrow card is a
   * quantity and a value; every column past that arrives as the card is
   * stretched, in the order a reader would ask for them.
   */
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * The list scrolls by hand. Measured in the running app, the box is a real
   * scroller — 361px showing 487px of rows — and the wheel still left
   * `scrollTop` at 0, while the same wheel scrolled the page beside it. Some
   * layer between the wheel and this box eats the browser's own scroll, and
   * rather than keep hunting it, the wheel is answered here, which works
   * whatever that layer is. Non-passive so the browser cannot also scroll if
   * it ever does get through — one answer per tick. At either edge the event
   * is left alone, so the page underneath still takes over the way it should.
   */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      // Lines and pages arrive as counts, not pixels.
      const dy =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      const next = Math.max(0, Math.min(max, el.scrollTop + dy));
      if (next === el.scrollTop) return;
      e.preventDefault();
      el.scrollTop = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const [listWidth, setListWidth] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setListWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    setListWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    return Object.values(account.positions)
      .filter((p) => {
        // Float residue from an old "sell everything" — worth nothing, listed
        // as nothing.
        const price = prices[p.symbol];
        const value = price != null ? p.shares * price : p.costUsd;
        return Math.abs(value) >= 0.01;
      })
      .map((p) => {
      const price = prices[p.symbol];
      const value = price != null ? p.shares * price : p.costUsd;
      const pnl = value - p.costUsd;
      const shares = Math.abs(p.shares);
      const changePct = quotes[p.symbol]?.changePercent ?? null;
      // The session's move in dollars: the print against the close it opened
      // from, which is what the percentage is quoted against.
      const prevClose =
        price != null && changePct != null && changePct > -100
          ? price / (1 + changePct / 100)
          : null;
      const q = quant[p.symbol];
      const beta = q?.beta ?? null;
      const betaR2 = q?.betaR2 ?? null;
      return {
        symbol: p.symbol,
        side: p.shares > 0 ? "long" : "short",
        shares,
        price,
        /** What one share cost, averaged over everything bought. */
        avgCost: shares > 1e-9 ? Math.abs(p.costUsd) / shares : null,
        /** Live market value of the holding — cost basis until a quote lands. */
        value,
        dayPnl: prevClose != null ? p.shares * (price! - prevClose) : null,
        dayPct: changePct,
        pnl,
        pnlPct: Math.abs(p.costUsd) > 1e-9 ? (pnl / Math.abs(p.costUsd)) * 100 : 0,
        beta,
        betaR2,
        /** The same dollars, as market exposure: a 2.9-beta name counts thrice. */
        exposure: beta != null ? value * beta : null,
        vol30: q?.vol30 ?? null,
        mom20: q?.mom20 ?? null,
        residZ: q?.residZ ?? null,
        fromHigh: q?.fromHigh ?? null,
        fromLow: q?.fromLow ?? null,
        earningsIn: q?.earningsIn ?? null,
        reach: reach[p.symbol] ?? [],
      };
    });
  }, [account, prices, quotes, quant, reach]);

  /**
   * Standalone risk share: this position's value × volatility against the
   * book's. No correlations in it — the Risk Engine's snapshot does not carry
   * a per-position figure yet, and a made-up one would be worse than a plain
   * one. Said so in the column's tooltip.
   */
  const riskDenominator = rows.reduce(
    (s, r) => s + (r.vol30 != null ? Math.abs(r.value) * r.vol30 : 0),
    0,
  );
  const riskShareOf = (r: (typeof rows)[number]): number | null =>
    r.vol30 == null || riskDenominator <= 0 ? null : (Math.abs(r.value) * r.vol30) / riskDenominator;

  /** The number a column sorts on: the figure its cell prints. Weight rides
   *  on value (the divisor is the same book for every row). */
  const sortValue = (key: ColumnKey, r: (typeof rows)[number]): number | null => {
    switch (key) {
      case "qty":
        return r.shares;
      case "last":
        return r.price ?? null;
      case "avgCost":
        return r.avgCost;
      case "value":
      case "weight":
        return r.value;
      case "beta":
        return r.beta;
      case "exposure":
        return r.exposure;
      case "reaching":
        return r.reach.filter((x) => x.status !== "priced").length;
      case "dayPnl":
        return r.dayPnl;
      case "totalPnl":
        return r.pnl;
      case "vol30":
        return r.vol30;
      case "mom20":
        return r.mom20;
      case "residZ":
        return r.residZ;
      case "w52":
        return r.fromHigh;
      case "earnings":
        return r.earningsIn;
      case "riskShare":
        return riskShareOf(r);
    }
  };

  /** A group's rows in the chosen order. "asc" is the up arrow and puts the
   *  largest figure at the top — the way a reader reads a ranking, not the
   *  way a spreadsheet defines the word. Rows without the figure sink to the
   *  bottom whichever way the sort runs; no sort leaves the list untouched. */
  const applySort = (list: typeof rows): typeof rows => {
    if (!sort) return list;
    const mul = sort.dir === "asc" ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = sortValue(sort.key, a);
      const bv = sortValue(sort.key, b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * mul;
    });
  };

  // Money hides behind a fixed five-star mask; percentages stay visible.
  const money = (s: string) => (masked ? MASKED_MONEY : s);

  /**
   * The cash, by currency. The account carries one dollar figure, so the real
   * book is a single row; demo mode hands over a split and the rows follow it.
   * Either way they add up to `account.cash`, which is what values the book.
   */
  const demo = useDemoMode();
  const cashRows =
    demo && demo.currencies?.length
      ? demo.currencies
      : [{ code: CASH_CURRENCY, amount: account.cash, usd: account.cash }];

  const orderedColumns = useMemo(
    () =>
      columnPrefs.order
        .filter((k) => !columnPrefs.hidden.includes(k))
        .map((k) => COLUMNS.find((c) => c.key === k))
        .filter((c): c is (typeof COLUMNS)[number] => c != null),
    [columnPrefs],
  );
  const visibleColumns = useMemo(() => {
    // The tree's indent and the scroller's own padding are not the table's.
    const usable = listWidth - 40;
    const out: typeof COLUMNS = [];
    let used = NAME_MIN;
    for (const column of orderedColumns) {
      const next = used + COL_GAP + column.w;
      if (out.length > 0 && next > usable) break;
      used = next;
      out.push(column);
    }
    return out;
  }, [listWidth, orderedColumns]);
  /** Name on the left takes the slack; every column keeps its own width. */
  const gridTemplate = useMemo(
    () => `minmax(0,1fr) ${visibleColumns.map((c) => `${c.w}px`).join(" ")}`,
    [visibleColumns],
  );

  /** A company or a fund — the only split the book can make from a ticker. */
  const needle = query.trim().toUpperCase();
  const matches = (symbol: string) => !needle || symbol.toUpperCase().includes(needle);
  const stockRows = useMemo(
    () => rows.filter((r) => !isEtfTicker(r.symbol) && matches(r.symbol)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, needle],
  );
  const etfRows = useMemo(
    () => rows.filter((r) => isEtfTicker(r.symbol) && matches(r.symbol)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, needle],
  );
  /**
   * The column heads are listed once, above the whole book, rather than
   * repeated under every group: the columns are the same either way, and
   * saying so twice cost a line of the list without telling the reader
   * anything. A collapsed group still prints its totals under the columns,
   * so the heads stay as long as any group has rows — a row of figures with
   * nothing over them is exactly what the heads exist to prevent.
   */
  const showColumnHeads = GROUPS.some((g) => (g.key === "stocks" ? stockRows : etfRows).length > 0);
  const sumValue = (list: typeof rows) => list.reduce((s, r) => s + r.value, 0);
  /** A group's line in the table: the count under Qty, the money under the
   *  columns it belongs to, and nothing under the ones a total cannot be. */
  const groupCell = (key: ColumnKey, list: typeof rows) => {
    switch (key) {
      case "qty":
        return <span className="tabular-nums text-[#6b7280]">{list.length}</span>;
      case "value":
        return (
          <span className="tabular-nums text-[#374151]">{money(fmtUsd(sumValue(list)))}</span>
        );
      case "weight":
        return <span className="tabular-nums text-[#6b7280]">{weightOf(sumValue(list))}</span>;
      case "dayPnl": {
        const known = list.filter((r) => r.dayPnl != null);
        if (known.length === 0) return null;
        const total = known.reduce((s, r) => s + (r.dayPnl ?? 0), 0);
        return (
          <span className={cn("tabular-nums", pnlTone(total))}>{money(fmtUsd(total, true))}</span>
        );
      }
      case "totalPnl": {
        const total = list.reduce((s, r) => s + r.pnl, 0);
        return (
          <span className={cn("tabular-nums", pnlTone(total))}>{money(fmtUsd(total, true))}</span>
        );
      }
      case "beta": {
        const b = weightedBeta(list);
        return b == null ? null : <span className="tabular-nums text-[#6b7280]">{b.toFixed(2)}</span>;
      }
      case "exposure": {
        const known = list.filter((r) => r.exposure != null);
        if (known.length === 0) return null;
        const total = known.reduce((s, r) => s + (r.exposure ?? 0), 0);
        return <span className="tabular-nums text-[#374151]">{money(fmtUsd(total))}</span>;
      }
      case "reaching": {
        const ids = new Set(list.flatMap((r) => r.reach.filter((x) => x.status !== "priced").map((x) => x.run_id)));
        return ids.size > 0 ? <span className="tabular-nums text-[#6b7280]">{ids.size}</span> : null;
      }
      case "riskShare": {
        const known = list.map(riskShareOf).filter((x): x is number => x != null);
        if (known.length === 0) return null;
        return (
          <span className="tabular-nums text-[#6b7280]">
            {(known.reduce((s, x) => s + x, 0) * 100).toFixed(0)}%
          </span>
        );
      }
      // A last price, an average cost, a share of the book, a volatility —
      // not things a group has; the column stays empty rather than inventing one.
      default:
        return null;
    }
  };

  /** Value-weighted beta of a list, over the names that have one. */
  function weightedBeta(list: typeof rows): number | null {
    const known = list.filter((r) => r.beta != null);
    const base = known.reduce((s, r) => s + Math.abs(r.value), 0);
    if (known.length === 0 || base <= 0) return null;
    return known.reduce((s, r) => s + Math.abs(r.value) * (r.beta ?? 0), 0) / base;
  }

  /** Share of the whole book — positions and the cash beside them. */
  const bookValue = rows.reduce((s, r) => s + r.value, 0) + Math.max(0, account.cash);
  const weightOf = (value: number): string =>
    bookValue > 1e-9 ? `${((value / bookValue) * 100).toFixed(1)}%` : "—";

  /**
   * What a highlight in the table is about. The cell it started in names the
   * column, the row names the holding — so "1.98" reaches the model as the
   * beta of COST, not as a number. A highlight outside any cell (a group
   * line) falls back to the table's own description.
   */
  const scopeOfSelection = useCallback((range: Range): GlossScope | null => {
    const node = range.startContainer;
    const el = node instanceof Element ? node : node.parentElement;
    const cell = el?.closest<HTMLElement>("[data-col]");
    const symbol = el?.closest<HTMLElement>("[data-symbol]")?.dataset.symbol;
    const column = cell ? COLUMNS.find((c) => c.key === cell.dataset.col) : undefined;
    if (!column) return symbol ? { ticker: symbol } : null;
    const what = column.title ? `${column.label}: ${column.title}` : column.label;
    return {
      ticker: symbol,
      context: `The "${column.label}" column of ${symbol ?? "a holding"} in an investor's Positions table (${what}). Explain what ${column.label} means and how to read this value.`,
    };
  }, []);

  /** One cell, in the column's own alignment and tone. */
  const cellFor = (key: ColumnKey, row: (typeof rows)[number]) => {
    switch (key) {
      case "qty":
        return (
          <span className="tabular-nums text-[#6b7280]">
            {row.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </span>
        );
      case "last":
        return (
          <span className="tabular-nums text-[#374151]">
            {row.price != null ? money(fmtUsd(row.price)) : "—"}
          </span>
        );
      case "avgCost":
        return (
          <span className="tabular-nums text-[#6b7280]">
            {row.avgCost != null ? money(fmtUsd(row.avgCost)) : "—"}
          </span>
        );
      case "value":
        return (
          <span className="tabular-nums text-[#374151]">{money(fmtUsd(row.value))}</span>
        );
      case "weight":
        return <span className="tabular-nums text-[#6b7280]">{weightOf(row.value)}</span>;
      case "dayPnl":
        return row.dayPnl == null ? (
          <span className="tabular-nums text-[#9CA3AF]">—</span>
        ) : (
          <span className={cn("tabular-nums", pnlTone(row.dayPnl))}>
            {money(fmtUsd(row.dayPnl, true))}
          </span>
        );
      case "totalPnl":
        return (
          <span
            className={cn("flex items-center justify-end gap-1 tabular-nums", pnlTone(row.pnl))}
            title={`${fmtUsd(row.pnl, true)} · ${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%`}
          >
            <span>{money(fmtUsd(row.pnl, true))}</span>
          </span>
        );
      case "beta": {
        // A beta the market barely explains is a weak number, however large it
        // is. Under r² 0.3 it is drawn faint and says so on hover, so a −0.97
        // that comes from one quarter of noisy energy tape reads as what it
        // is rather than as a fact about the name.
        const weak = row.beta != null && row.betaR2 != null && row.betaR2 < 0.3;
        return (
          <span
            className={cn("tabular-nums", weak ? "text-[#B0B4BA]" : "text-[#6b7280]")}
            title={
              row.beta != null && row.betaR2 != null
                ? `r² ${row.betaR2.toFixed(2)}${weak ? ": the market explains little of this name's moves, so the beta is a weak read" : ""}`
                : undefined
            }
          >
            {row.beta != null ? row.beta.toFixed(2) : "—"}
          </span>
        );
      }
      case "exposure":
        return (
          <span className="tabular-nums text-[#374151]">
            {row.exposure != null ? money(fmtUsd(row.exposure)) : "—"}
          </span>
        );
      case "reaching": {
        const live = row.reach.filter((x) => x.status !== "priced");
        if (live.length === 0) return <span className="text-[#C9CCD1]">·</span>;
        return (
          <button
            type="button"
            data-no-lift
            onClick={() => openStock(row.symbol)}
            title={`${live.length} live event${live.length === 1 ? "" : "s"} reaching ${row.symbol}. Open its tape`}
            className="app-no-drag inline-flex items-center justify-end gap-1 tabular-nums text-[#374151] hover:text-[#1d1b1b]"
          >
            <span>{live.length}</span>
            <span className="flex items-center gap-[3px]">
              {live.slice(0, 3).map((x) => (
                <span
                  key={x.run_id}
                  aria-hidden
                  className={cn(
                    "block h-[6px] w-[6px] rounded-full",
                    x.status === "open" ? "bg-[#2FB873]" : "bg-[#C9CCD1]",
                  )}
                />
              ))}
            </span>
          </button>
        );
      }
      case "vol30":
        return (
          <span className="tabular-nums text-[#6b7280]">
            {row.vol30 != null ? `${row.vol30.toFixed(1)}%` : "—"}
          </span>
        );
      case "mom20":
        return row.mom20 == null ? (
          <span className="text-[#9CA3AF]">—</span>
        ) : (
          <span className={cn("tabular-nums", pnlTone(row.mom20))}>
            {row.mom20 >= 0 ? "+" : ""}
            {row.mom20.toFixed(1)}%
          </span>
        );
      case "residZ":
        return row.residZ == null ? (
          <span className="text-[#9CA3AF]">—</span>
        ) : (
          <span className={cn("tabular-nums", pnlTone(row.residZ))}>
            {row.residZ >= 0 ? "+" : ""}
            {row.residZ.toFixed(1)}σ
          </span>
        );
      case "w52":
        return row.fromHigh == null ? (
          <span className="text-[#9CA3AF]">—</span>
        ) : (
          <span
            className="tabular-nums text-[#6b7280]"
            title={
              row.fromLow != null
                ? `${row.fromHigh.toFixed(0)}% from the 52-week high · +${row.fromLow.toFixed(0)}% off the low`
                : undefined
            }
          >
            {row.fromHigh.toFixed(0)}%
          </span>
        );
      case "earnings":
        return row.earningsIn == null ? (
          <span className="text-[#9CA3AF]">—</span>
        ) : (
          <span
            className={cn("tabular-nums", row.earningsIn <= 3 ? "text-[#D97706]" : "text-[#6b7280]")}
            title={`${row.earningsIn} session${row.earningsIn === 1 ? "" : "s"} to earnings`}
          >
            {row.earningsIn}s
          </span>
        );
      case "riskShare": {
        const share = riskShareOf(row);
        return (
          <span className="tabular-nums text-[#6b7280]">
            {share != null ? `${(share * 100).toFixed(0)}%` : "—"}
          </span>
        );
      }
    }
  };

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  // Falcon node value: cash + live-priced positions.
  const paperValue =
    account.cash +
    Object.values(account.positions).reduce((s, p) => {
      const price = prices[p.symbol];
      return s + (price != null ? p.shares * price : p.costUsd);
    }, 0);
  const totalBasis = Object.values(account.positions).reduce(
    (s, p) => s + Math.abs(p.costUsd),
    0,
  );
  const pnlPct = totalBasis > 1e-9 ? (totalPnl / totalBasis) * 100 : 0;
  // Everything the card lists: the Falcon account plus any connected broker.
  const assetsValue =
    paperValue +
    brokerAccounts.reduce((s, a) => s + (Number.isFinite(a.totalValue ?? NaN) ? (a.totalValue as number) : 0), 0);

  return (
    // No resting min-height of its own: the slot the card sits in sets the
    // height (the grid cell, or the dock), and a 560px floor inside it meant a
    // shortened card overflowed instead of shrinking — so the list never had a
    // bounded box to scroll inside.
    <div className="grid h-full w-full grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
          POSITIONS
        </span>
        {/* gap-3 plus the pulled-in dots: the three-dot glyph is a 3px mark
            centred in a 16px box, so without the -mr the empty half of its
            box reads as extra padding against the card's edge. */}
        <div className="flex items-center gap-3">
          {/* Search — the top bar's pill, grown out of the glyph. The group is
              anchored to the card's right edge, so the pill grows leftward and
              the glyph rides its left edge out. */}
          <motion.div
            data-no-lift
            initial={false}
            animate={{
              width: searchOpen ? 176 : 16,
              backgroundColor: searchOpen ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0)",
              borderColor: searchOpen ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0)",
              boxShadow: searchOpen
                ? "inset 0 1px 0 rgba(255,255,255,0.7), 0 0 0 1px rgba(0,0,0,0.04)"
                : "inset 0 0 0 rgba(255,255,255,0), 0 0 0 0 rgba(0,0,0,0)",
            }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className={cn(
              "flex h-7 items-center overflow-hidden rounded-full border",
              searchOpen ? "-my-1.5 pl-2 pr-2.5 backdrop-blur-xl backdrop-saturate-150" : "-my-1.5",
            )}
          >
            <button
              type="button"
              aria-label={searchOpen ? "Close search" : "Search positions"}
              aria-expanded={searchOpen}
              onClick={() => {
                if (searchOpen) {
                  setQuery("");
                  setSearchOpen(false);
                } else {
                  setSearchOpen(true);
                }
              }}
              className={cn(
                "app-no-drag flex shrink-0 items-center transition-colors hover:text-[#1d1b1b]",
                searchOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
              )}
            >
              <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              onBlur={() => {
                if (!query.trim()) setSearchOpen(false);
              }}
              placeholder="Search positions"
              aria-label="Search positions"
              tabIndex={searchOpen ? 0 : -1}
              className={cn(
                "app-no-drag ml-2 w-full min-w-0 bg-transparent text-[12.5px] text-[#1d1b1b] outline-none placeholder:text-[#9CA3AF]",
                !searchOpen && "pointer-events-none opacity-0",
              )}
            />
          </motion.div>

          {/* Settings — a switch glyph; the panel under it decides what the
              table shows and in what order. */}
          <div ref={settingsRef} data-no-lift className="relative flex">
            <button
              type="button"
              aria-label="Table settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
              className={cn(
                "app-no-drag transition-colors hover:text-[#1d1b1b]",
                settingsOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
              )}
            >
              <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            {createPortal(
            <AnimatePresence>
              {settingsOpen && settingsPos ? (
                <motion.div
                  ref={settingsPanelRef}
                  data-no-lift
                  role="dialog"
                  aria-label="Table settings"
                  initial={{ opacity: 0, scale: 0.92, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ type: "spring", stiffness: 480, damping: 34 }}
                  style={{
                    transformOrigin: "top right",
                    top: settingsPos.top,
                    right: settingsPos.right,
                    maxHeight: `calc(100vh - ${settingsPos.top + 12}px)`,
                  }}
                  className="app-no-drag fixed z-[60] w-56 overflow-y-auto overscroll-contain rounded-2xl border border-white/60 bg-white/70 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150 [&::-webkit-scrollbar]:hidden"
                >
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <span className="select-none font-sans text-[11px] font-normal tracking-[0.08em] text-[#9CA3AF]">
                      APPEARANCE
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setColumnPrefs({ order: DEFAULT_COLUMN_ORDER, hidden: DEFAULT_HIDDEN })
                      }
                      className="text-[11.5px] font-normal text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
                    >
                      Reset
                    </button>
                  </div>
                  <div aria-hidden className="mx-1 my-1 h-px bg-black/[0.06]" />
                  {(["data", "quant"] as const).map((section) => {
                    const keys = columnPrefs.order.filter(
                      (k) => COLUMNS.find((c) => c.key === k)?.section === section,
                    );
                    return (
                      <div key={section}>
                        <span className="block select-none px-1 pb-1 pt-1.5 font-sans text-[11px] font-normal tracking-[0.08em] text-[#9CA3AF]">
                          {section === "data" ? "DATA" : "QUANT"}
                        </span>
                        {/* Each section reorders among its own; the other
                            section's places in the overall order are kept. */}
                        <Reorder.Group
                          axis="y"
                          values={keys}
                          onReorder={(next) =>
                            setColumnPrefs((p) => {
                              const queue = [...(next as ColumnKey[])];
                              return {
                                ...p,
                                order: p.order.map((k) => (keys.includes(k) ? queue.shift()! : k)),
                              };
                            })
                          }
                          className="space-y-0.5"
                        >
                          {keys.map((key) => {
                            const column = COLUMNS.find((c) => c.key === key);
                            if (!column) return null;
                            return (
                              <ColumnRow
                                key={key}
                                column={column}
                                checked={!columnPrefs.hidden.includes(key)}
                                onToggle={() => toggleColumn(key)}
                              />
                            );
                          })}
                        </Reorder.Group>
                      </div>
                    );
                  })}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
            )}
          </div>

          <button
            type="button"
            onClick={onToggleMasked}
            aria-label={masked ? "Show values" : "Hide values"}
            aria-pressed={masked}
            className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
          >
            {masked ? (
              <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            ) : (
              <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            )}
          </button>
          {/* The card menu. `data-no-lift` keeps a press here from picking
              the whole card up. The panel drops inside the card, so the
              card's overflow clip never cuts it off. */}
          {/* `flex` kills the inline-block baseline gap that floated the
              dots a couple of pixels above the eye; the -mr pulls the
              narrow glyph out so its visible mark, not its empty box, sits
              the card's padding from the edge. */}
          <div ref={menuRef} data-no-lift className="relative flex -mr-[10px]">
            <button
              type="button"
              aria-label="Card menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className={cn(
                "app-no-drag transition-colors hover:text-[#1d1b1b]",
                menuOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
              )}
            >
              <MoreVertical className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            {/* The panel wears the dashboard's glass card frame, a size down:
                same border, inner highlight, ring and blur, with a drop
                shadow so it reads as floating over the card. It unfolds from
                the button's corner and slips back the same way. */}
            <AnimatePresence>
              {menuOpen ? (
                <motion.div
                  role="menu"
                  aria-label="Card actions"
                  initial={{ opacity: 0, scale: 0.92, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ type: "spring", stiffness: 480, damping: 34 }}
                  style={{ transformOrigin: "top right" }}
                  className="app-no-drag absolute right-0 top-full z-50 mt-2 w-48 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onDuplicate?.();
                    }}
                    className="group/mi flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-[#1d1b1b] transition-all duration-150 hover:translate-x-0.5 hover:bg-[#1d1b1b]/[0.07] active:scale-[0.97]"
                  >
                    <Copy
                      className="h-[15px] w-[15px] text-[#4b5563] transition-colors duration-150 group-hover/mi:text-[#1d1b1b]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    Duplicate
                  </button>
                  <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onRemove?.();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-[#DC2626] transition-all duration-150 hover:translate-x-0.5 hover:bg-[#DC2626]/[0.10] active:scale-[0.97]"
                  >
                    <X className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
                    Delete module
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="row-span-3 min-h-0">
          <ConnectPortfolioEmpty
            Icon={Layers}
            line="No account linked yet. Connect a brokerage or open a Falcon paper account to see your positions here."
          />
        </div>
      ) : (
      <>
      {/* What the book is worth, with the move on it alongside. */}
      <div className="mt-5 shrink-0">
        <div className="flex items-end gap-1.5">
          <span className="text-[30px] font-medium leading-none tabular-nums text-[#1d1b1b]">
            {money(fmtUsd(assetsValue))}
          </span>
          <span
            className={cn(
              "mb-0.5 flex items-center gap-0.5 text-[12.5px] font-medium tabular-nums",
              pnlTone(pnlPct),
            )}
          >
            <span>{money(fmtUsd(totalPnl, true))}</span>
            {pnlPct >= 0 ? (
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            )}
            {pnlPct >= 0 ? "+" : ""}
            {pnlPct.toFixed(2)}%
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-[#9CA3AF]">
          {(() => {
            const msg = pnlMessageParts(totalPnl, rows);
            return (
              <>
                {msg.before}
                {msg.amount ? (
                  <span className={cn("font-medium tabular-nums", pnlTone(totalPnl))}>
                    {money(msg.amount)}
                  </span>
                ) : null}
                {msg.after}
              </>
            );
          })()}
        </p>
      </div>

      {/* The book by what a holding is: companies, funds, then the cash that
          has not been put to work. This is the part that gives when the card
          is resized — it takes the spare height, and scrolls rather than
          crushing the rows when there isn't any. */}
      {/* Highlight a figure and it explains itself, the way the Insight copy
          does — except this copy is a table, so the cell says what the figure
          is (a beta, a 30-day vol, a risk share) and whose, before the model
          is asked. The gloss host is the grid row; the list scrolls inside it,
          so the popover sits over the rows rather than being carried off with
          them. */}
      <SelectionGloss
        resolve={scopeOfSelection}
        context={TABLE_CONTEXT}
        className="flex min-h-0 flex-col"
        contentClassName="flex min-h-0 flex-1 flex-col"
      >
      <div
        ref={listRef}
        data-no-lift
        style={{ touchAction: "pan-y" }}
        // The scrollbar is drawn — the app's thin one. Hidden, a list that
        // did not answer the wheel gave no sign it could move at all; visible,
        // it can at least be taken by the thumb.
        // Its own compositing layer, so a scroll inside the card's
        // backdrop-filter and framer's transformed wrappers is painted on
        // the frame it happens rather than on the next unrelated repaint.
        className="scrollbar-meridian app-no-drag mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 will-change-transform"
      >
        {rows.length === 0 && account.cash <= 0 ? (
          <p className="py-1.5 text-[12.5px] text-[#9CA3AF]">No open positions.</p>
        ) : null}

        {/* Column heads, listed once for the whole book. They stay pinned
            while the list scrolls: said once, they would otherwise be gone
            by the second screenful, and a column of figures with no label
            over it is the thing the heads exist to prevent.

            The fill is the card's own surface, which is what a reader sees
            through the glass here; it has to stay in step with the card
            body, or the pinned strip shows as a seam. The strip runs the
            full width so nothing scrolls through it, and the heading inside
            stands off the same rail the groups indent their rows behind, so
            a figure and its label share a column edge. That border is
            transparent because the rail belongs to the rows, not to the
            heading over them. */}
        {showColumnHeads ? (
          <div className="sticky top-0 z-10 bg-[#F2F2EF]">
            <div className="ml-[21px] border-l-[0.5px] border-transparent pl-3.5">
              <div
                className="grid items-center gap-3 border-b-[0.5px] border-black/[0.06] pb-1 text-right font-['Geist_Mono'] text-[9.5px] uppercase tracking-[0.06em] text-[#9CA3AF]"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <span className="text-left">Name</span>
                {/* Every head is the switch for its own sort: largest first
                    (arrow up), smallest first (arrow down), back to the book's
                    order. The arrow marks the sorted column and which way it runs. */}
                {visibleColumns.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    data-no-lift
                    onClick={() => cycleSort(c.key)}
                    title={c.title ?? `Sort by ${c.label}`}
                    className={cn(
                      "app-no-drag inline-flex items-center justify-end gap-0.5 transition-colors hover:text-[#4b5563]",
                      sort?.key === c.key && "text-[#1d1b1b]",
                    )}
                  >
                    {c.label}
                    {sort?.key === c.key ? (
                      sort.dir === "desc" ? (
                        <ArrowDown className="h-2.5 w-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
                      ) : (
                        <ArrowUp className="h-2.5 w-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
                      )
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {GROUPS.map((group) => {
          const list = applySort(group.key === "stocks" ? stockRows : etfRows);
          if (list.length === 0) return null;
          const open = openGroups[group.key] !== false;
          return (
            <div key={group.key} className="mb-1">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                aria-expanded={open}
                className="app-no-drag grid w-full items-center gap-3 py-1 text-right text-[12px]"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <span className="flex min-w-0 items-center gap-1 text-left">
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 shrink-0 text-[#9CA3AF] transition-transform",
                      open && "rotate-90",
                    )}
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span className="truncate text-[11.5px] font-normal text-[#6b7280]">{group.label}</span>
                </span>
                {visibleColumns.map((c) => (
                  <span key={c.key} className="whitespace-nowrap">
                    {groupCell(c.key, list)}
                  </span>
                ))}
              </button>

              {open ? (
                <div className="ml-[21px] border-l-[0.5px] border-black/[0.1] pl-3.5">
                  {list.map((row) => (
                    <div key={row.symbol}>
                    <div
                      data-symbol={row.symbol}
                      className="grid items-center gap-3 py-1.5 text-right text-[12.5px]"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      <span className="flex min-w-0 items-center gap-2.5 text-left">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#E3E3E0]">
                          <StockIcon symbol={row.symbol} size="sm" className="h-3.5 w-3.5 object-contain" />
                        </span>
                        <span className="truncate text-[13px] font-semibold text-[#1d1b1b]">
                          {row.symbol}
                        </span>
                        {/* A short reads the opposite way round from everything
                            else in this list — the dot says so before the
                            numbers do. */}
                        {row.side === "short" && (
                          <span
                            role="img"
                            className="h-[5px] w-[5px] shrink-0 rounded-full bg-[#DC2626]"
                            title={`Short position in ${row.symbol}`}
                            aria-label={`${row.symbol} short position`}
                          />
                        )}
                      </span>
                      {visibleColumns.map((c) => (
                        <span key={c.key} data-col={c.key} className="whitespace-nowrap">
                          {cellFor(c.key, row)}
                        </span>
                      ))}
                    </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {/* Cash — always listed, even at zero: an empty line is the answer to
            "how much is waiting", and the reader asked the question. */}
        <div className="mb-1">
          <button
            type="button"
            onClick={() => toggleGroup("cash")}
            aria-expanded={openGroups.cash !== false}
            className="app-no-drag grid w-full items-center gap-3 py-1 text-right text-[12px]"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <span className="flex min-w-0 items-center gap-1 text-left">
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-[#9CA3AF] transition-transform",
                  openGroups.cash !== false && "rotate-90",
                )}
                strokeWidth={2}
                aria-hidden
              />
              <span className="truncate text-[11.5px] font-normal text-[#6b7280]">Cash</span>
            </span>
            {visibleColumns.map((c) => (
              <span key={c.key} className="whitespace-nowrap">
                {c.key === "value" ? (
                  <span className="tabular-nums text-[#374151]">{money(fmtUsd(account.cash))}</span>
                ) : c.key === "weight" ? (
                  <span className="tabular-nums text-[#6b7280]">{weightOf(Math.max(0, account.cash))}</span>
                ) : null}
              </span>
            ))}
          </button>

          {openGroups.cash !== false ? (
            <div className="ml-[21px] border-l-[0.5px] border-black/[0.1] pl-3.5">
              {cashRows.map((row) => (
                <div key={row.code} className="flex items-center gap-2.5 py-1.5">
                  <CurrencyFlag code={row.code} />
                  <span className="text-[13px] font-semibold text-[#1d1b1b]">{row.code}</span>
                  {/* What is actually held, where that isn't the dollar figure
                      on the right anyway. Dropped under the mask: two rows of
                      stars say nothing twice. */}
                  {row.code !== CASH_CURRENCY && !masked ? (
                    <span className="text-[12px] tabular-nums text-[#9CA3AF]">
                      {fmtNative(row.code, row.amount)}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[12.5px] tabular-nums text-[#374151]">
                    {money(fmtUsd(row.usd))}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Connected brokerages sit under their own heading: SnapTrade gives a
            total and no holdings, so those dollars cannot honestly be filed
            into the groups above. */}
        {brokerAccounts.length > 0 ? (
          <div className="mb-1">
            <button
              type="button"
              onClick={() => toggleGroup("connected")}
              aria-expanded={openGroups.connected !== false}
              className="app-no-drag flex w-full items-center gap-1 py-1 text-left"
            >
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-[#9CA3AF] transition-transform",
                  openGroups.connected !== false && "rotate-90",
                )}
                strokeWidth={2}
                aria-hidden
              />
              <span className="text-[11.5px] font-medium text-[#6b7280]">Connected</span>
              <span className="ml-auto text-[12px] tabular-nums text-[#6b7280]">
                {money(
                  fmtUsd(
                    brokerAccounts.reduce(
                      (sum, a) => sum + (Number.isFinite(a.totalValue ?? NaN) ? (a.totalValue as number) : 0),
                      0,
                    ),
                  ),
                )}
              </span>
            </button>

            {openGroups.connected !== false ? (
              <div className="ml-[21px] border-l-[0.5px] border-black/[0.1] pl-3.5">
                {brokerAccounts.map((acct) => (
                  <div key={acct.id} className="flex items-center gap-2.5 py-1.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[9px] font-semibold text-[#6b7280]">
                      {acct.institution.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="text-[13px] font-semibold text-[#1d1b1b]">{acct.institution}</span>
                    <span className="text-[10.5px] text-[#9CA3AF]">{acct.name}</span>
                    <span className="ml-auto text-[12.5px] tabular-nums text-[#374151]">
                      {acct.totalValue != null ? money(fmtUsd(acct.totalValue)) : "—"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

      </div>
      </SelectionGloss>
      </>
      )}

    </div>
  );
}
