import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, LogOut } from "lucide-react";
import logoBlack from "@/assets/brand/logo-black.png";
import GraphScreen from "@/components/graph/GraphScreen";
import StockView from "@/components/stock/StockView";
import DashboardSearchBar from "@/components/dashboard/DashboardSearchBar";
import StockPeekModal from "@/components/dashboard/StockPeekModal";
import UpdatePill from "@/components/UpdatePill";
import LiftableCard, { type DragPoint } from "@/components/dashboard/LiftableCard";
import PortfolioCard from "@/components/dashboard/PortfolioCard";
import PortfolioChart from "@/components/dashboard/PortfolioChart";
import InsightCard from "@/components/dashboard/InsightCard";
import OpportunitiesPanel from "@/components/dashboard/OpportunitiesPanel";
import { toggleDemoMode } from "@/lib/demo-mode";
import { startPortfolioSync } from "@/lib/portfolio-sync";
import { startPortfolioCoverageSync } from "@/lib/portfolio-coverage";
import { startRiskAccountBridge } from "@/lib/risk-account-bridge";
import PortfolioValueHeadline from "@/components/dashboard/PortfolioValueHeadline";
import TimeframeControls, { type Timeframe } from "@/components/dashboard/TimeframeControls";
import WindowControls from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { STOCK_OPEN_EVENT, type StockOpenDetail } from "@/lib/stock-open";
import type { StockCatalogEntry } from "../../shared/stock-catalog";

/**
 * Rebuilt shell: a bare frame with the brand mark top-left. Panels get
 * rebuilt into the content area step by step — every screen and service
 * is still intact in the codebase.
 */

/** Assets card docked beside the chart — remembered across sessions. */
const ASSETS_DOCKED_KEY = "falcon.ui.assetsDocked";
const DOCK_WIDTH = 340;
const DOCK_GAP = 16;

/** Bottom-row cards, in the order they sit — remembered across sessions. Every
 *  card lifts like the Assets card does; drop one on another to swap them. */
type CardId = "assets" | "insight" | "risk";
const CARD_ORDER_KEY = "falcon.ui.cardOrder.v4";
const DEFAULT_CARD_ORDER: CardId[] = ["assets", "insight", "risk"];
function loadCardOrder(): CardId[] {
  try {
    const raw = localStorage.getItem(CARD_ORDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      const seen = parsed.filter((id): id is CardId => DEFAULT_CARD_ORDER.includes(id as CardId));
      const unique = Array.from(new Set(seen));
      // Anything missing (a card added since) goes on the end.
      return [...unique, ...DEFAULT_CARD_ORDER.filter((id) => !unique.includes(id))];
    }
  } catch {
    /* fall back */
  }
  return DEFAULT_CARD_ORDER;
}

/** One easing for every part of the chart's full-screen move. */
const EXPAND_TWEEN = { duration: 0.6, ease: [0.4, 0, 0.2, 1] } as const;
/** Top bar (pt-16) the main area sits under. */
const TOP_BAR_PX = 64;

type Props = {
  userName: string;
  skipGreeting?: boolean;
  onSignOut: () => void;
};

export default function HomePage({ userName, onSignOut }: Props) {
  const enterStarted = useRef(false);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const firstName = userName.trim().split(/\s+/)[0];
  const [timeframe, setTimeframe] = useState<Timeframe>("Month");
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const [chartExpanded, setChartExpanded] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [view, setView] = useState<"dashboard" | "stock" | "graph">("dashboard");
  // Ticker picked from the top search bar — opens the stock screen in place.
  const [stock, setStock] = useState<StockCatalogEntry | null>(null);
  // ⌘K's pick opens as a glass peek over the dashboard, not the stock view.
  const [peek, setPeek] = useState<StockCatalogEntry | null>(null);

  // Assets card docking: hold the card to lift it, drag it up and a slot opens
  // on the chart's left (the chart narrows to the right); drop it there to
  // dock. Drag a docked card out again to send it back to the bottom row.
  const [assetsDocked, setAssetsDocked] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ASSETS_DOCKED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [assetsLifted, setAssetsLifted] = useState(false);
  const [assetsOverDock, setAssetsOverDock] = useState(false);
  const chartRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(ASSETS_DOCKED_KEY, assetsDocked ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  }, [assetsDocked]);

  // The dock target: the left ~400px of the chart row, from its top edge down.
  const overDockZone = (p: DragPoint): boolean => {
    const rect = chartRowRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      p.x >= rect.left - 24 &&
      p.x <= rect.left + DOCK_WIDTH + 48 &&
      p.y >= rect.top - 40 &&
      p.y <= rect.bottom + 24
    );
  };

  // Card order + swap-by-drop. While a card is lifted, the card under the
  // pointer is marked as the swap target; dropping there exchanges the two.
  const [cardOrder, setCardOrder] = useState<CardId[]>(loadCardOrder);
  const [draggingCard, setDraggingCard] = useState<CardId | null>(null);
  const [swapTarget, setSwapTarget] = useState<CardId | null>(null);
  const cardRefs = useRef<Partial<Record<CardId, HTMLDivElement | null>>>({});

  useEffect(() => {
    try {
      localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(cardOrder));
    } catch {
      /* non-fatal */
    }
  }, [cardOrder]);

  const cardUnder = (p: DragPoint, except: CardId): CardId | null => {
    for (const id of cardOrder) {
      if (id === except) continue;
      if (id === "assets" && assetsDocked) continue;
      const rect = cardRefs.current[id]?.getBoundingClientRect();
      if (!rect) continue;
      if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) return id;
    }
    return null;
  };

  const onCardLift = (id: CardId) => {
    setDraggingCard(id);
    if (id === "assets") setAssetsLifted(true);
  };
  const onCardDragMove = (id: CardId, p: DragPoint) => {
    if (id === "assets") setAssetsOverDock(overDockZone(p));
    setSwapTarget(cardUnder(p, id));
  };
  const onCardDragEnd = (id: CardId, p: DragPoint) => {
    const target = cardUnder(p, id);
    setDraggingCard(null);
    setSwapTarget(null);
    if (id === "assets") {
      const dock = overDockZone(p);
      setAssetsLifted(false);
      setAssetsOverDock(false);
      // In full screen the bottom row is hidden, so a docked card stays put.
      const docked = chartExpanded ? assetsDocked || dock : dock;
      setAssetsDocked(docked);
      if (docked) return;
    }
    if (target) {
      setCardOrder((order) => {
        const a = order.indexOf(id);
        const b = order.indexOf(target);
        if (a < 0 || b < 0) return order;
        const next = [...order];
        next[a] = target;
        next[b] = id;
        return next;
      });
    }
  };
  const dockOpen = assetsDocked || (assetsLifted && assetsOverDock);
  // Full screen hides the drop target but keeps an already-docked card, at size.
  const dockVisible = assetsDocked || (dockOpen && !chartExpanded);

  // Full-screen geometry in pixels so framer can tween it (CSS can't animate
  // from height:auto). The block takes the viewport under the top bar; the
  // chart row takes half of it — or the docked card's own height if taller.
  const [viewportH, setViewportH] = useState<number>(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [dockedCardH, setDockedCardH] = useState(0);
  const availableH = Math.max(320, viewportH - TOP_BAR_PX);
  const expandedRowH = Math.min(
    availableH - 140, // always leave room for the balance band
    Math.max(Math.round(availableH * 0.5), assetsDocked ? dockedCardH : 0),
  );
  // Let the plot keep filling the row while it shrinks back, so collapsing
  // is one glide too — released just before the tween lands on height:auto.
  const [chartFill, setChartFill] = useState(false);
  useEffect(() => {
    if (chartExpanded) {
      setChartFill(true);
      return;
    }
    const t = window.setTimeout(() => setChartFill(false), 520);
    return () => window.clearTimeout(t);
  }, [chartExpanded]);
  const toggleChartExpanded = () => {
    if (!chartExpanded) {
      // Measure the docked card before the row starts animating, so full
      // screen can keep it at exactly this size.
      const row = chartRowRef.current?.getBoundingClientRect();
      setDockedCardH(row ? Math.round(row.height - 40) : 0); // minus pb-10
    }
    setChartExpanded((v) => !v);
  };

  const cardContent = (id: CardId) => {
    switch (id) {
      case "assets":
        return <PortfolioCard masked={privacyMode} onToggleMasked={() => setPrivacyMode((v) => !v)} />;
      case "insight":
        return <InsightCard />;
      case "risk":
        return <OpportunitiesPanel />;
    }
  };

  // One slot per card: hold to lift, drag over another card to mark it, drop
  // to swap. The marked card dips so the target is unmistakable.
  const renderCard = (id: CardId) => (
    <LiftableCard
      key={id}
      layoutId={`card-${id}`}
      // The row is a four-column grid, so a card is exactly its cell: a
      // quarter of the workspace, gaps taken out, at whatever width the
      // window happens to be. No fixed card size to fall out of step with it.
      className="w-full min-w-0"
      onLift={() => onCardLift(id)}
      onDragMove={(p) => onCardDragMove(id, p)}
      onDragEnd={(p) => onCardDragEnd(id, p)}
    >
      <motion.div
        ref={(el) => {
          cardRefs.current[id] = el;
        }}
        animate={{
          scale: swapTarget === id && draggingCard !== id ? 0.965 : 1,
          opacity: swapTarget === id && draggingCard !== id ? 0.72 : 1,
        }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        className="h-full rounded-3xl"
      >
        {cardContent(id)}
      </motion.div>
    </LiftableCard>
  );
  const assetsCard = renderCard("assets");
  const rowCards = cardOrder.filter((id) => !(id === "assets" && assetsDocked));

  // Window sizing/animation system still runs so the frame behaves normally.
  useEffect(() => {
    if (enterStarted.current) return;
    enterStarted.current = true;
    void window.meridian?.enterWorkspace();
  }, []);

  // Esc leaves full screen — the same way every other overlay closes.
  useEffect(() => {
    if (!chartExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChartExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chartExpanded]);

  // Cloud sync — pulls the portfolio down (restoring it on a machine whose
  // local copy is gone), then keeps pushing local changes up so the 24/7
  // worker prices the right book. Lived in the old dashboard shell.
  useEffect(() => startPortfolioSync(), []);

  // Risk Engine (§2/§5): the paper account lives in this renderer, so push
  // positions + cash to the main-process host on every change (it debounces).
  useEffect(() => startRiskAccountBridge(), []);

  // A name picked anywhere in the dashboard — the Insight panel's rail today —
  // opens the stock view, exactly as choosing it in the search bar does.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<StockOpenDetail>).detail;
      const symbol = detail?.ticker?.trim().toUpperCase();
      if (!symbol) return;
      setStock({ symbol, companyName: detail.companyName ?? symbol });
      setView("stock");
    };
    window.addEventListener(STOCK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(STOCK_OPEN_EVENT, onOpen);
  }, []);

  // Coverage: any symbol the user holds that the system does not yet know is
  // auto-added to the Tracker universe and gets a relationship-graph (step1)
  // extraction, so detectors and the network map cover the whole portfolio.
  useEffect(() => startPortfolioCoverageSync(), []);

  // Shift+G opens the relationship graph — the counterparty map step1
  // builds from filings. Press again (or Esc, via the back button) to leave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "G" && e.key !== "g") return;
      // Never steal the key while the user is typing into something.
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el != null &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      setView((v) => (v === "graph" ? "dashboard" : "graph"));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl/⌘+P toggles demo mode: a random >$10K portfolio, random holdings and
  // a random growth curve for presentations. Press again to get the real
  // account back — nothing is written or synced while it's on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        toggleDemoMode();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative h-full overflow-hidden rounded-lg bg-background font-sans">
      <div className="app-drag-region absolute inset-x-0 top-0 h-12" aria-hidden />

      {/* Top-bar backdrop — scrolling content fades out under the brand
          instead of colliding with it */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-30">
        <div className="h-12 bg-background" />
        <div className="h-4 bg-gradient-to-b from-background to-transparent" />
      </div>

      {/* Brand — logo + wordmark, nudged in from the corner */}
      <div className="pointer-events-none absolute left-9 top-[18px] z-50 flex h-7 select-none items-center gap-2.5">
        <img src={logoBlack} alt="Falcon" className="h-7 w-7 opacity-[0.89]" />
      </div>

      {/* Stock search — centred in the top bar between brand and controls */}
      <DashboardSearchBar
        className="absolute left-1/2 top-4 z-50 w-[min(26rem,calc(100vw-28rem))] -translate-x-1/2"
        onSelect={(entry) => setPeek(entry)}
        onNavigate={() => setView("dashboard")}
      />

      {/* Sign out. App has always passed the handler down and the shell has
          always dropped it on the floor — the only button that called it
          lived in WorkspaceTopBar, which nothing mounts, so there was no way
          out of the session from inside the app. Sits left of the window
          controls, in their weight, so it reads as chrome and not as an
          action anyone hits by accident. */}
      <button
        type="button"
        onClick={onSignOut}
        aria-label="Sign out"
        title="Sign out"
        className="app-no-drag absolute right-[104px] top-5 z-50 flex h-7 w-7 items-center justify-center text-fg-faint transition hover:bg-black/[0.05] hover:text-fg-muted"
      >
        <LogOut className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
      </button>

      <WindowControls className="absolute right-3 top-5 z-50" />

      {/* No app-no-drag here — a full-height no-drag surface would punch out
          the whole top drag strip (Electron ignores stacking for app-region). */}
      <main
        className={cn("h-full pt-16", chartExpanded ? "overflow-hidden" : "overflow-y-auto")}
        aria-label={view === "stock" ? "Stock" : view === "graph" ? "Graph" : "Dashboard"}
      >
        {view === "graph" ? (
          <div className="app-no-drag flex h-full min-h-0 flex-col px-8 pb-6 pt-6">
            <button
              type="button"
              onClick={() => setView("dashboard")}
              className="mb-4 flex w-fit items-center gap-1.5 text-[13px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Dashboard
            </button>
            {/* GraphScreen sizes itself with flex-1 in every state, so it
                needs a flex column to grow into — a plain block collapses it. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <GraphScreen />
            </div>
          </div>
        ) : view === "stock" && stock ? (
          <div className="app-no-drag flex h-full min-h-0 flex-col px-8 pb-6 pt-6">
            <button
              type="button"
              onClick={() => setView("dashboard")}
              className="mb-4 flex w-fit items-center gap-1.5 text-[13px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Dashboard
            </button>
            <div className="min-h-0 flex-1">
              <StockView
                key={stock.symbol}
                symbol={stock.symbol}
                companyName={stock.companyName}
                exchange={stock.exchange}
              />
            </div>
          </div>
        ) : (
        <>
        {/* Greeting — in the scroll flow, so it slides away with content.
            Fades while the chart owns the workspace. */}
        <motion.div
          initial={false}
          animate={{ height: chartExpanded ? 0 : "auto", opacity: chartExpanded ? 0 : 1 }}
          transition={EXPAND_TWEEN}
          className={cn("select-none overflow-hidden pl-9", chartExpanded && "pointer-events-none")}
        >
          <span className="font-baskerville text-[30px] text-[#1d1b1b]">
            {greeting}, {firstName}
          </span>
        </motion.div>

        {/* Expanded, the block owns the viewport: the balance centres in the
            band above the plot and the plot takes the rest. Every size that
            changes is animated by framer (auto ↔ px), so the move glides
            instead of snapping — CSS can't tween from height:auto. */}
        <motion.div
          initial={false}
          animate={{ height: chartExpanded ? availableH : "auto" }}
          transition={EXPAND_TWEEN}
          className="flex flex-col"
        >
          {/* Headline band — timeframe controls on the right */}
          <motion.div
            initial={false}
            animate={{ marginTop: chartExpanded ? 0 : 48 }}
            transition={EXPAND_TWEEN}
            className="relative flex min-h-0 flex-1 items-center"
          >
            <div className="flex w-full justify-center">
              <PortfolioValueHeadline overrideValue={scrubValue} masked={privacyMode} />
            </div>
            <div className="absolute right-12 top-1/2 -translate-y-1/2">
              <TimeframeControls
                onChange={setTimeframe}
                expanded={chartExpanded}
                onToggleExpanded={toggleChartExpanded}
              />
            </div>
          </motion.div>

          {/* Near-full-bleed chart — a small breath of space at each edge.
              The dock slot on the left opens while the Assets card hovers
              over it (or lives there), and the chart narrows to the right.
              Full screen: the row takes half the viewport, or the docked
              card's own height if that is taller — the card never shrinks. */}
          <motion.div
            ref={chartRowRef}
            initial={false}
            animate={{
              height: chartExpanded ? expandedRowH : "auto",
              marginTop: chartExpanded ? 0 : 40,
              paddingLeft: chartExpanded && !assetsDocked ? 0 : 32,
              paddingRight: chartExpanded ? 0 : 32,
              paddingBottom: chartExpanded ? 0 : 40,
            }}
            transition={EXPAND_TWEEN}
            className="flex min-h-0 shrink-0 items-stretch"
          >
            <motion.div
              initial={false}
              animate={{
                width: dockVisible ? DOCK_WIDTH : 0,
                marginRight: dockVisible ? DOCK_GAP : 0,
              }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className={cn("relative shrink-0 self-stretch", assetsLifted && "z-20")}
            >
              {assetsDocked ? (
                assetsCard
              ) : dockOpen ? (
                <div
                  aria-hidden
                  className="h-full min-h-[300px] w-[340px] rounded-3xl border border-dashed border-[#1d1b1b]/55 bg-[#1d1b1b]/[0.07]"
                />
              ) : null}
            </motion.div>
            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                // With a card docked on the left, the plot fades in off its edge
                // instead of starting hard against it.
                dockVisible &&
                  "[mask-image:linear-gradient(to_right,transparent_0,#000_64px)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,#000_64px)]",
              )}
            >
              <PortfolioChart
                timeframe={timeframe}
                showGrowth
                showSp500
                expanded={chartExpanded}
                fill={assetsDocked || chartFill}
                onScrub={setScrubValue}
              />
            </div>
          </motion.div>
        </motion.div>

        {/* Card grid: four to a row, each column an equal share of the width.
            Past the fourth card the grid wraps on its own — scroll for it. */}
        <div
          className={cn(
            "-mt-2 origin-top transition-all duration-[550ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
            // A lifted card must be free to travel up past the row's edge.
            draggingCard != null && !chartExpanded ? "overflow-visible" : "overflow-hidden",
            // Going full screen the row sinks and fades rather than blinking
            // out: opacity and the downward slide lead, the height follows.
            chartExpanded
              ? "pointer-events-none max-h-0 translate-y-6 scale-[0.98] opacity-0"
              : "max-h-[1600px] translate-y-0 scale-100 opacity-100",
          )}
        >
          <div className="grid grid-cols-4 items-stretch gap-4 px-8 pb-12 pt-1">
            {rowCards.map(renderCard)}
          </div>
        </div>
        </>
        )}
      </main>

      <StockPeekModal entry={peek} onClose={() => setPeek(null)} />

      {/* Update notice — bottom-left, same inset as the brand mark up top. */}
      <UpdatePill className="absolute bottom-6 left-9 z-50" />
    </div>
  );
}
