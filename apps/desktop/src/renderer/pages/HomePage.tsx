import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, Gauge, LineChart, List, LogOut, Newspaper, Sparkles, type LucideIcon } from "lucide-react";
import logoBlack from "@/assets/brand/logo-black.png";
import GraphScreen from "@/components/graph/GraphScreen";
import StockView from "@/components/stock/StockView";
import DashboardSearchBar from "@/components/dashboard/DashboardSearchBar";
import StockPeekModal from "@/components/dashboard/StockPeekModal";
import ProfilePill from "@/components/dashboard/ProfilePill";
import AddModuleButton from "@/components/dashboard/AddModuleButton";
import UpdatePill from "@/components/UpdatePill";
import LiftableCard, { type DragPoint } from "@/components/dashboard/LiftableCard";
import PortfolioCard from "@/components/dashboard/PortfolioCard";
import PortfolioValueCard from "@/components/dashboard/PortfolioValueCard";
import InsightCard from "@/components/dashboard/InsightCard";
import OpportunitiesPanel from "@/components/dashboard/OpportunitiesPanel";
import NewsCard from "@/components/dashboard/NewsCard";
import CalendarCard from "@/components/dashboard/CalendarCard";
import BriefingHost from "@/components/briefing/BriefingHost";
import SettingsModal from "@/components/settings/SettingsModal";
import {
  bringToFront,
  canvasHeight,
  dragSeam,
  duplicateBox,
  layoutFromFlow,
  limitResizedBox,
  seamsOf,
  type Seam,
  loadCanvasLayout,
  moveBox,
  reconcileCanvasLayout,
  resizeBoxFromEdge,
  NO_GUIDES,
  saveCanvasLayout,
  snapMovedBox,
  snapResizedBox,
  zIndexOf,
  type CanvasLayout,
  type Edge,
  type ModuleBox,
  type SnapGuides,
} from "@/lib/canvas-layout";
import { isCardHidden } from "@/lib/dashboard-config";
import { toggleDemoMode } from "@/lib/demo-mode";
import { startPortfolioSync } from "@/lib/portfolio-sync";
import { startPortfolioCoverageSync } from "@/lib/portfolio-coverage";
import { startRiskAccountBridge } from "@/lib/risk-account-bridge";
import WindowControls from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { STOCK_OPEN_EVENT, type StockOpenDetail } from "@/lib/stock-open";
import type { StockCatalogEntry } from "../../shared/stock-catalog";

/**
 * Rebuilt shell: a bare frame with the brand mark top-left. Panels get
 * rebuilt into the content area step by step — every screen and service
 * is still intact in the codebase.
 *
 * The dashboard is one grid of cards. The balance card used to be a block of
 * its own above the grid — with a dock beside it for the holdings card, a
 * seam between the two, and a full-screen mode — and that made it a different
 * kind of thing from every card under it: it could not be dragged, sat where
 * it sat, and carried controls nothing else had. It is a card now, in the
 * same grid, with the same menu. A reader who wants the holdings beside the
 * chart drags them there.
 */

/** The height every dashboard card frame stands at. */
const CARD_H = 560;
/** Where earlier builds kept the balance card's own height; read once as
 *  the card's starting height, so a dragged edge is not lost in the move. */
const CHART_H_KEY = "falcon.ui.chartCardH";

/** Cards, in the order they sit — remembered across sessions. Every card
 *  lifts, drags, and drops onto a slot or onto another card to take its place. */
type CardBase = "portfolio" | "assets" | "calendar" | "news" | "insight" | "risk";
/** A card, or a copy of one made from its menu — `assets#1725...` reads as
 *  "an assets card", so everything keyed by base keeps working on copies. */
type CardId = CardBase | `${CardBase}#${number}`;
const baseOf = (id: CardId): CardBase => id.split("#")[0] as CardBase;

/** What the Add Module menu offers, in its order. A card the config hides is left out of it. */
const MODULES: ReadonlyArray<{ id: CardBase; label: string; icon: LucideIcon }> = [
  { id: "portfolio", label: "Portfolio Value", icon: LineChart },
  { id: "assets", label: "Positions", icon: List },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "news", label: "News", icon: Newspaper },
  { id: "risk", label: "Risk Score", icon: Gauge },
  { id: "insight", label: "Insight", icon: Sparkles },
];
const CARD_ORDER_KEY = "falcon.ui.cardOrder.v4";
/**
 * Per-card size — the share of the row's width, and the pixel height.
 * Remembered like the order. A share rather than a column count: widths used
 * to snap to quarters of the row, so a drag on the edge moved the card in
 * jumps; now the edge follows the pointer, and the row wraps wherever the
 * cards' widths add up to more than it has.
 */
const CARD_SIZE_KEY = "falcon.ui.cardSizes.v2";
/** Where the previous build kept sizes, in columns of four; read once to migrate. */
const CARD_SIZE_KEY_V1 = "falcon.ui.cardSizes.v1";
const GRID_GAP = 16;
/**
 * Where the canvas's own overlays (the seam handles between cards) draw:
 * above every card at rest (those start at ten), under the top bar's
 * backdrop (thirty). Nothing between the page root and the canvas makes a
 * stacking context, so an overlay shares one with the bar, and at sixty it
 * ran straight through the search box once the page had been scrolled.
 */
const GUIDE_Z = 29;
const CARD_MIN_W = 0.2;
const CARD_MIN_H = 320;
const CARD_MAX_H = 1400;
const CARD_DEFAULT_H = 560;

type CardSize = { w: number; h: number };
const clampW = (w: number): number => Math.min(1, Math.max(CARD_MIN_W, w));
const clampH = (h: number): number => Math.min(CARD_MAX_H, Math.max(CARD_MIN_H, Math.round(h)));

/** The size a card stands at until the reader drags it: the balance card
 *  takes the whole row, everything else a quarter of it. */
function defaultSize(id: CardId): CardSize {
  if (baseOf(id) !== "portfolio") return { w: 0.25, h: CARD_DEFAULT_H };
  let h = CARD_H;
  try {
    const raw = Number(localStorage.getItem(CHART_H_KEY));
    if (Number.isFinite(raw) && raw > 0) h = clampH(raw);
  } catch {
    /* the shared card height */
  }
  return { w: 1, h };
}

function loadCardSizes(): Record<string, CardSize> {
  try {
    const raw = localStorage.getItem(CARD_SIZE_KEY) ?? localStorage.getItem(CARD_SIZE_KEY_V1);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const out: Record<string, CardSize> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const v = value as Partial<CardSize & { cols: number }> | null;
        // A column count from the previous build is a share of four.
        const w = Number.isFinite(Number(v?.w)) ? Number(v?.w) : Number(v?.cols) / 4;
        const h = Number(v?.h);
        out[id] = {
          w: Number.isFinite(w) && w > 0 ? clampW(w) : 0.25,
          h: Number.isFinite(h) ? clampH(h) : CARD_DEFAULT_H,
        };
      }
      return out;
    }
  } catch {
    /* fall back to the defaults below */
  }
  return {};
}

const DEFAULT_CARD_ORDER: CardId[] = ["portfolio", "assets", "calendar", "news", "insight", "risk"];
function loadCardOrder(): CardId[] {
  try {
    const raw = localStorage.getItem(CARD_ORDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      const seen = parsed.filter(
        (id): id is CardId =>
          typeof id === "string" && DEFAULT_CARD_ORDER.includes(baseOf(id as CardId)),
      );
      const unique = Array.from(new Set(seen));
      const missing = DEFAULT_CARD_ORDER.filter((id) => !unique.includes(id));
      // The balance card goes first when an older arrangement has no place
      // for it — that is where it always stood; anything else goes on the end.
      return [
        ...missing.filter((id) => id === "portfolio"),
        ...unique,
        ...missing.filter((id) => id !== "portfolio"),
      ];
    }
  } catch {
    /* fall back */
  }
  return DEFAULT_CARD_ORDER;
}

type Props = {
  userName: string;
  /** The address the session is signed in with; shown at the head of the account menu. */
  userEmail?: string;
  skipGreeting?: boolean;
  onSignOut: () => void;
};

export default function HomePage({ userName, userEmail, onSignOut }: Props) {
  const enterStarted = useRef(false);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const firstName = userName.trim().split(/\s+/)[0];
  const [privacyMode, setPrivacyMode] = useState(false);
  /** Settings, opened from the account pill. Only its rail is built so far. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<"dashboard" | "stock" | "graph">("dashboard");
  // Ticker picked from the top search bar — opens the stock screen in place.
  const [stock, setStock] = useState<StockCatalogEntry | null>(null);
  // ⌘K's pick opens as a glass peek over the dashboard, not the stock view.
  const [peek, setPeek] = useState<StockCatalogEntry | null>(null);

  // Card ordering: hold a card to lift it and drag it; the card under the
  // pointer is marked as the swap target; dropping there exchanges the two.
  const [cardOrder, setCardOrder] = useState<CardId[]>(loadCardOrder);
  const [draggingCard, setDraggingCard] = useState<CardId | null>(null);
  /**
   * The box the card being dragged had when the press began. Every move is
   * the whole journey applied to that box, so a pointer that outruns a frame
   * lands in the same place as one that does not.
   */
  const dragOrigin = useRef<ModuleBox | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // The canvas every card sits on: its own box, its own place in the
  // stacking order, free to overlap the others. Seeded from the old row's
  // arrangement the first time, so nothing moves on the day it arrives.
  const [canvas, setCanvas] = useState<CanvasLayout | null>(() => loadCanvasLayout(localStorage));
  const [canvasW, setCanvasW] = useState(0);
  /** The lines a dragged edge is being held to right now, drawn while they hold. */
  // What a dragged edge is being held to. Kept as state so the snapping code
  // keeps its shape; nothing draws it any more (see the canvas below).
  const [, setGuides] = useState<SnapGuides>(NO_GUIDES);
  const canvasObserver = useRef<ResizeObserver | null>(null);
  /** Columns spanned + height, per card. Dragged from the grip on each card. */
  const [cardSizes, setCardSizes] = useState<Record<string, CardSize>>(loadCardSizes);
  /** Which card is being resized, and by which edge — so only that edge's
   *  bar lights up. */
  const [resizing, setResizing] = useState<{ id: CardId; edge: Edge } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Measured whenever the canvas mounts, since it leaves the tree with the
  // dashboard view and comes back with it.
  // Stable, so React calls it when the canvas mounts and unmounts and not on
  // every commit: an inline ref would rebuild the observer and force a
  // layout on each pointermove of a resize.
  const gridRefCb = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    canvasObserver.current?.disconnect();
    canvasObserver.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth));
    ro.observe(el);
    canvasObserver.current = ro;
    setCanvasW(el.clientWidth);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CARD_SIZE_KEY, JSON.stringify(cardSizes));
    } catch {
      /* non-fatal */
    }
  }, [cardSizes]);

  const sizeOf = (id: CardId): CardSize => cardSizes[id] ?? defaultSize(id);

  /**
   * A handle drags a card's size from any edge or corner, in pixels. Handles
   * carry `data-no-lift` — without it the press would pick the card up
   * instead. The right and bottom edges change only the size; the left and
   * top edges move that edge and keep the opposite one put.
   */
  /**
   * The gutter between cards that stand a gutter apart, taken hold of: both
   * sides resize at once and the gutter travels between them. Same shape as a
   * resize — the whole gesture applied to the boxes as they were at the press.
   */
  const [seaming, setSeaming] = useState<string | null>(null);
  const seamKey = (s: Seam) => `${s.kind}:${s.before.join()}|${s.after.join()}`;
  const startSeam = (seam: Seam, e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const base = layoutRef.current;
    if (!base || canvasW <= 0) return;
    const start = seam.kind === "v" ? e.clientX : e.clientY;
    const ids = [...seam.before, ...seam.after] as CardId[];
    const origins = Object.fromEntries(ids.map((id) => [id, base.boxes[id]]));
    setSeaming(seamKey(seam));

    const onMove = (ev: PointerEvent) => {
      const width = gridRef.current?.clientWidth || canvasW;
      const d = (seam.kind === "v" ? ev.clientX : ev.clientY) - start;
      updateCanvas((c) => dragSeam(c, seam, d, width, origins));
    };
    const onUp = () => {
      const now = layoutRef.current;
      if (now) {
        setCardSizes((prev) => {
          const next = { ...prev };
          for (const id of ids) {
            const b = now.boxes[id];
            if (b) next[id] = { w: b.w, h: b.h };
          }
          return next;
        });
      }
      setSeaming(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const startResize = (id: CardId, e: React.PointerEvent<HTMLElement>, edge: Edge) => {
    // preventDefault only: the press still has to reach the document, where
    // an open card menu is listening to close itself. The card's own lift
    // already ignores handles through data-no-lift.
    e.preventDefault();
    if (!layout || canvasW <= 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    // Every move is the whole gesture applied to the box as it was, so a
    // pointer that outruns a frame does not compound into a different size.
    const origin = layout.boxes[id];
    if (!origin) return;
    setResizing({ id, edge });
    touchCard(id);

    const onMove = (ev: PointerEvent) => {
      const base = layoutRef.current;
      if (!base) return;
      // The width as it is on this move, not as it was at the press: a corner
      // drag that takes the canvas past the fold brings the scrollbar in, and
      // the canvas is narrower from then on.
      const width = gridRef.current?.clientWidth || canvasW;
      const resized = resizeBoxFromEdge(
        { ...base, boxes: { ...base.boxes, [id]: origin } },
        id,
        edge,
        ev.clientX - startX,
        ev.clientY - startY,
        width,
      );
      // An edge that comes level with another card's edge, the gutter beside
      // it, or the canvas's own edge takes that line; failing a line, a width
      // or height that comes level with another card's takes that size. Alt
      // holds the snap off, for the one time the reader wants the in-between.
      // First the limit: an edge pushed at a card that faces it stops a
      // gutter short, which is where the seam between the two then appears.
      // The snap runs on what is left, and the limit once more after it, so
      // a line on the far side of a neighbour cannot pull the edge through.
      // Alt lifts both — the way to overlap on purpose, or sit in between.
      const limited = ev.altKey ? resized : limitResizedBox(resized, id, edge, width, origin);
      const pulled = ev.altKey
        ? { layout: limited, guides: NO_GUIDES }
        : snapResizedBox(limited, id, edge, width, origin.w * width);
      const held = ev.altKey ? pulled.layout : limitResizedBox(pulled.layout, id, edge, width, origin);
      const snapped = held === pulled.layout ? pulled : { layout: held, guides: NO_GUIDES };
      const box = snapped.layout.boxes[id];
      const key = (s: SnapGuides) => [s.v, s.h, s.sameW, s.sameH].map((a) => a.join()).join("|");
      setGuides((g) => (key(g) === key(snapped.guides) ? g : snapped.guides));
      updateCanvas((c) => ({ ...c, boxes: { ...c.boxes, [id]: box } }));
    };
    const onUp = () => {
      // The row's own size store learns the new size too: it is what a card
      // that is removed and later comes back is laid out from.
      const b = layoutRef.current?.boxes[id];
      if (b) setCardSizes((prev) => ({ ...prev, [id]: { w: b.w, h: b.h } }));
      setGuides(NO_GUIDES);
      window.requestAnimationFrame(() => setResizing(null));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /** One invisible strip per edge, lighting a short bar when the pointer is
   *  near it or it is being dragged; one small square per corner. */
  const resizeHandles = (id: CardId) => {
    const lit = (edges: Edge[]) => resizing?.id === id && edges.includes(resizing.edge);
    const bar = (on: boolean, vertical: boolean, group: string) =>
      cn(
        "rounded-full bg-[#1d1b1b]/30 transition-opacity duration-150",
        vertical ? "h-16 w-[3px]" : "h-[3px] w-16",
        on ? "opacity-100" : `opacity-0 ${group}`,
      );
    return (
      <>
        <div
          data-no-lift
          role="separator"
          aria-label={`Resize ${id} card from the left`}
          onPointerDown={(e) => startResize(id, e, "l")}
          className="group/rzl app-no-drag absolute inset-y-4 left-0 z-20 flex w-3 cursor-ew-resize items-center justify-center"
        >
          <span aria-hidden className={bar(lit(["l"]), true, "group-hover/rzl:opacity-100")} />
        </div>
        <div
          data-no-lift
          role="separator"
          aria-label={`Resize ${id} card from the right`}
          onPointerDown={(e) => startResize(id, e, "r")}
          className="group/rzr app-no-drag absolute inset-y-4 right-0 z-20 flex w-3 cursor-ew-resize items-center justify-center"
        >
          <span aria-hidden className={bar(lit(["r"]), true, "group-hover/rzr:opacity-100")} />
        </div>
        <div
          data-no-lift
          role="separator"
          aria-label={`Resize ${id} card from the top`}
          onPointerDown={(e) => startResize(id, e, "t")}
          className="group/rzt app-no-drag absolute inset-x-4 top-0 z-20 flex h-3 cursor-ns-resize items-center justify-center"
        >
          <span aria-hidden className={bar(lit(["t"]), false, "group-hover/rzt:opacity-100")} />
        </div>
        <div
          data-no-lift
          role="separator"
          aria-label={`Resize ${id} card from the bottom`}
          onPointerDown={(e) => startResize(id, e, "b")}
          className="group/rzb app-no-drag absolute inset-x-4 bottom-0 z-20 flex h-3 cursor-ns-resize items-center justify-center"
        >
          <span aria-hidden className={bar(lit(["b"]), false, "group-hover/rzb:opacity-100")} />
        </div>
        {/* Corners: three quiet squares, and the dotted glyph every card has
            always shown in its bottom-right. */}
        <div
          data-no-lift
          aria-label={`Resize ${id} card from the top left`}
          onPointerDown={(e) => startResize(id, e, "tl")}
          className="app-no-drag absolute left-0 top-0 z-20 h-4 w-4 cursor-nwse-resize"
        />
        <div
          data-no-lift
          aria-label={`Resize ${id} card from the top right`}
          onPointerDown={(e) => startResize(id, e, "tr")}
          className="app-no-drag absolute right-0 top-0 z-20 h-4 w-4 cursor-nesw-resize"
        />
        <div
          data-no-lift
          aria-label={`Resize ${id} card from the bottom left`}
          onPointerDown={(e) => startResize(id, e, "bl")}
          className="app-no-drag absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize"
        />
        <button
          type="button"
          data-no-lift
          aria-label={`Resize ${id} card`}
          title="Drag to resize"
          onPointerDown={(e) => startResize(id, e, "br")}
          className={cn(
            "app-no-drag absolute bottom-1.5 right-1.5 z-20 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded-lg text-[#9CA3AF] transition-opacity hover:text-[#4b5563]",
            resizing?.id === id ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
          )}
        >
          <svg viewBox="0 0 10 10" className="h-[10px] w-[10px]" aria-hidden>
            <path
              d="M9 1v8H1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeDasharray="2.4 2.2"
            />
          </svg>
        </button>
      </>
    );
  };

  useEffect(() => {
    try {
      localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(cardOrder));
    } catch {
      /* non-fatal */
    }
  }, [cardOrder]);

  const rowCards = cardOrder.filter((id) => !isCardHidden(baseOf(id)));

  /**
   * The layout the page draws. With a saved canvas, that canvas — with any
   * card the page shows but it lacks laid out underneath, and any it no
   * longer shows dropped. Without one, the old row's arrangement, worked out
   * afresh from the width the canvas has right now: the page mounts in the
   * login-sized window and only then grows to the workspace, and a seed
   * taken at the small size would have been kept at the wrong shares. So
   * the seed is only drawn, never written, until the reader's first gesture
   * makes it theirs. Until the canvas has been measured, nothing is drawn.
   */
  const seedSizes = Object.fromEntries(rowCards.map((id) => [id, sizeOf(id)]));
  const layout: CanvasLayout | null =
    canvasW > 0
      ? canvas
        ? reconcileCanvasLayout(canvas, rowCards, seedSizes, { w: 0.25, h: CARD_DEFAULT_H }, canvasW)
        : layoutFromFlow(rowCards, seedSizes, { w: 0.25, h: CARD_DEFAULT_H }, canvasW, GRID_GAP)
      : null;
  const layoutRef = useRef<CanvasLayout | null>(null);
  layoutRef.current = layout;

  // A reconciliation of a kept canvas is kept too, and the canvas is
  // written to storage whenever it changes.
  useEffect(() => {
    if (canvas && layout && layout !== canvas) setCanvas(layout);
  }, [layout, canvas]);
  useEffect(() => {
    if (canvas) saveCanvasLayout(localStorage, canvas);
  }, [canvas]);

  /**
   * Every change goes through here: the first one adopts whatever is being
   * drawn — the seed, at the width it was drawn at — as the canvas.
   */
  const updateCanvas = (fn: (c: CanvasLayout) => CanvasLayout) =>
    setCanvas((c) => {
      const base = c ?? layoutRef.current;
      return base ? fn(base) : c;
    });

  /** Whichever card is touched comes to the front. */
  const touchCard = (id: CardId) => updateCanvas((c) => bringToFront(c, id));

  const onCardLift = (id: CardId) => {
    setDraggingCard(id);
    touchCard(id);
    dragOrigin.current = layoutRef.current?.boxes[id] ?? null;
  };

  /**
   * Where a dragged card would come to rest: its box at the press, moved by
   * how far the pointer has travelled, then pulled onto any line it came
   * close to — another card's edge, the gutter beside it, the canvas's own
   * side, or another card's middle. Alt holds the snap off, as it does on a
   * resize.
   *
   * `nudge` is the difference between where the pointer has the card and
   * where it would land. The card carries it as part of its drag transform,
   * so the snap is seen while it holds instead of on release.
   */
  const dragPlacement = (id: CardId, offset: DragPoint, alt: boolean) => {
    const base = layoutRef.current;
    const origin = dragOrigin.current;
    const width = gridRef.current?.clientWidth || canvasW;
    if (!base || !origin || width <= 0) return null;
    const rawLeft = origin.x * width + offset.x;
    const rawTop = origin.y + offset.y;
    const moved = moveBox({ ...base, boxes: { ...base.boxes, [id]: origin } }, id, rawLeft, rawTop, width);
    const snapped = alt ? { layout: moved, guides: NO_GUIDES } : snapMovedBox(moved, id, width);
    const box = snapped.layout.boxes[id] ?? origin;
    return {
      box,
      guides: snapped.guides,
      nudge: { x: box.x * width - rawLeft, y: box.y - rawTop },
    };
  };

  const guideKey = (g: SnapGuides) => [g.v, g.h, g.sameW, g.sameH].map((a) => a.join()).join("|");

  // While the card travels, only the lines change hands: the box stays where
  // it was until the drop, and the card is carried by its own transform.
  const onCardDragMove = (id: CardId, offset: DragPoint, alt: boolean): DragPoint | void => {
    const at = dragPlacement(id, offset, alt);
    if (!at) return;
    setGuides((g) => (guideKey(g) === guideKey(at.guides) ? g : at.guides));
    return at.nudge;
  };

  // The drop is where the card was last seen: the same placement, written to
  // the box this time, so nothing shifts under the hand as it lets go.
  const onCardDragEnd = (id: CardId, offset: DragPoint, alt: boolean) => {
    const at = dragPlacement(id, offset, alt);
    setDraggingCard(null);
    setGuides(NO_GUIDES);
    dragOrigin.current = null;
    if (!at) return;
    updateCanvas((c) => ({ ...c, boxes: { ...c.boxes, [id]: at.box } }));
  };

  /**
   * The card menu's two verbs. Duplicate opens a copy right after the
   * original, at the original's size — the copy is a card like any other, so
   * it drags, resizes, and removes on its own. Remove takes the card off this
   * arrangement only: `loadCardOrder` re-appends any missing default card on
   * the next launch, so nobody can strand themselves with an empty grid.
   */
  const duplicateCard = (id: CardId): CardId => {
    const copy = `${baseOf(id)}#${Date.now()}` as CardId;
    setCardOrder((order) => {
      const at = order.indexOf(id);
      return at < 0
        ? [...order, copy]
        : [...order.slice(0, at + 1), copy, ...order.slice(at + 1)];
    });
    setCardSizes((prev) => ({ ...prev, [copy]: sizeOf(id) }));
    if (canvasW > 0) updateCanvas((c) => duplicateBox(c, id, copy, canvasW));
    return copy;
  };
  const removeCard = (id: CardId) => {
    setCardOrder((order) => order.filter((c) => c !== id));
  };

  /**
   * Add Module: a card that is not on the canvas comes back (the canvas lays
   * it out under the others, as it does for any card it lacks), and one that
   * is gets a copy beside it, the card menu's Duplicate. Either way the new
   * card is brought to the front and scrolled into view, because both land
   * where the reader may not be looking.
   */
  const [revealId, setRevealId] = useState<CardId | null>(null);
  const addModule = (base: CardBase) => {
    const present = cardOrder.find((id) => baseOf(id) === base);
    if (present) {
      setRevealId(duplicateCard(present));
    } else {
      setCardOrder((order) => (order.includes(base) ? order : [...order, base]));
      setRevealId(base);
    }
  };

  // By hand, not scrollIntoView, which would also scroll the page's own
  // clipped root and leave the top bar out of place.
  useEffect(() => {
    if (!revealId) return;
    const el = cardRefs.current[revealId];
    if (!el) return;
    setRevealId(null);
    touchCard(revealId);
    const main = el.closest("main");
    if (!main) return;
    const card = el.getBoundingClientRect();
    const view = main.getBoundingClientRect();
    const topRoom = 72;
    if (card.top < view.top + topRoom || card.bottom > view.bottom) {
      main.scrollTo({ top: Math.max(0, main.scrollTop + card.top - view.top - topRoom), behavior: "smooth" });
    }
  });

  const cardContent = (id: CardId) => {
    switch (baseOf(id)) {
      case "portfolio":
        return (
          <PortfolioValueCard
            masked={privacyMode}
            onDuplicate={() => duplicateCard(id)}
            onRemove={() => removeCard(id)}
          />
        );
      case "assets":
        return (
          <PortfolioCard
            masked={privacyMode}
            onToggleMasked={() => setPrivacyMode((v) => !v)}
            onDuplicate={() => duplicateCard(id)}
            onRemove={() => removeCard(id)}
          />
        );
      case "calendar":
        return <CalendarCard onDuplicate={() => duplicateCard(id)} onRemove={() => removeCard(id)} />;
      case "news":
        return <NewsCard onDuplicate={() => duplicateCard(id)} onRemove={() => removeCard(id)} />;
      case "insight":
        return <InsightCard />;
      case "risk":
        return <OpportunitiesPanel onDuplicate={() => duplicateCard(id)} onRemove={() => removeCard(id)} />;
    }
  };

  // One box per card: hold to lift, drag it anywhere, let go and it stays.
  // Cards may overlap; the one touched last is on top.
  const renderCard = (id: CardId) => {
    const box = layout?.boxes[id];
    if (!layout || !box) return null;
    return (
      <LiftableCard
        key={id}
        free
        // While the reader is dragging this card or any handle that sizes
        // it, the box goes exactly where the pointer is, on the frame the
        // pointer gets there.
        instant={resizing?.id === id || draggingCard === id}
        className="min-w-0"
        style={{
          position: "absolute",
          left: box.x * canvasW,
          top: box.y,
          width: box.w * canvasW,
          height: box.h,
          zIndex: zIndexOf(layout, id),
          // Grow from the corner the reader is dragging away from, never the
          // middle: the masthead stays put while the box changes.
          transformOrigin: "top left",
        }}
        onLift={() => onCardLift(id)}
        onDragMove={(_point, offset, alt) => onCardDragMove(id, offset, alt)}
        onDragEnd={(_point, offset, alt) => onCardDragEnd(id, offset, alt)}
      >
        <div
          ref={(el) => {
            cardRefs.current[id] = el;
          }}
          // Any press, on anything in the card, brings it to the front.
          onPointerDownCapture={() => touchCard(id)}
          // The cards carry their own resting min-height; once a reader has
          // set one by hand, the box is the authority.
          className="group/card relative h-full rounded-3xl [&>*]:!min-h-0"
        >
          {cardContent(id)}

          {resizeHandles(id)}
        </div>
      </LiftableCard>
    );
  };

  // Window sizing/animation system still runs so the frame behaves normally.
  useEffect(() => {
    if (enterStarted.current) return;
    enterStarted.current = true;
    void window.meridian?.enterWorkspace();
  }, []);

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

      {/* Who is signed in — a pill in the search bar's glass, standing just
          off its left end; Add Module stands off its right end on the
          dashboard. Both offsets are half the search bar's own width (the
          same min() it is sized with), plus a gap: the pill is placed by its
          right edge, so a longer name grows away from the search bar rather
          than into it. */}
      <ProfilePill
        name={firstName}
        email={userEmail}
        onSignOut={onSignOut}
        onSelect={(key) => {
          // The other rows lead to screens that do not exist yet; they stay
          // quiet rather than opening something half-built.
          if (key === "settings") setSettingsOpen(true);
        }}
        className="absolute top-4 z-50"
        style={{ right: "calc(50% + min(13rem, (100vw - 28rem) / 2) + 10px)" }}
      />
      {view === "dashboard" ? (
        <AddModuleButton
          className="absolute top-4 z-50"
          style={{ left: "calc(50% + min(13rem, (100vw - 28rem) / 2) + 10px)" }}
          modules={MODULES.filter((m) => !isCardHidden(m.id)).map((m) => ({
            ...m,
            onCanvas: rowCards.some((id) => baseOf(id) === m.id),
          }))}
          onAdd={(id) => addModule(id as CardBase)}
        />
      ) : null}

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
        className="h-full overflow-x-hidden overflow-y-auto pt-16"
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
            {/* Greeting — in the scroll flow, so it slides away with content. */}
            <div className="select-none pl-9">
              <span className="font-baskerville text-[30px] text-[#1d1b1b]">
                {greeting}, {firstName}
              </span>
            </div>

            {/* The canvas. Every card is a box at its own place, as wide a
                share of the width and as tall as it has been dragged to;
                it grows downward to fit the lowest card. Nothing here
                clips, so a lifted card can travel anywhere. */}
            <div className="mt-6 px-8 pb-12 pt-1">
              <div
                ref={gridRefCb}
                className="relative"
                style={{ height: layout ? canvasHeight(layout, 480) : 480 }}
              >
                {rowCards.map((id) => renderCard(id))}

                {/* Snapping is felt, not drawn: a dragged edge is still held
                    to the other cards' edges, the gutters and the canvas
                    sides (`guides` carries what it was held to), but no line
                    is laid over the canvas for it. The lines read as clutter
                    on a surface the reader is arranging by hand, and the
                    edge landing flush says the same thing. */}

                {/* The seams: wherever cards stand a gutter apart, the gutter
                    itself is a handle that resizes both sides. It lives in
                    the gap the cards already leave, so it costs no layout and
                    covers none of their own edge handles — nothing until the
                    pointer is in the gap, then the same short bar. Hidden
                    while a card is being moved or resized: the pairs it is
                    drawn from are changing under it. */}
                {layout && canvasW > 0 && !draggingCard && !resizing
                  ? seamsOf(layout, canvasW).map((s) => {
                      const lit = seaming === seamKey(s);
                      const v = s.kind === "v";
                      return (
                        <div
                          key={seamKey(s)}
                          data-no-lift
                          role="separator"
                          aria-orientation={v ? "vertical" : "horizontal"}
                          aria-label="Resize the cards on both sides"
                          title="Drag to resize both cards"
                          onPointerDown={(e) => startSeam(s, e)}
                          className={cn(
                            "group/seam app-no-drag absolute flex items-center justify-center",
                            v ? "cursor-col-resize" : "cursor-row-resize",
                          )}
                          style={
                            v
                              ? { left: s.at - GRID_GAP / 2, width: GRID_GAP, top: s.from, height: s.to - s.from, zIndex: GUIDE_Z - 1 }
                              : { top: s.at - GRID_GAP / 2, height: GRID_GAP, left: s.from, width: s.to - s.from, zIndex: GUIDE_Z - 1 }
                          }
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "rounded-full bg-[#1d1b1b]/30 transition-opacity duration-150",
                              v ? "h-16 w-[3px]" : "h-[3px] w-16",
                              lit ? "opacity-100" : "opacity-0 group-hover/seam:opacity-100",
                            )}
                          />
                        </div>
                      );
                    })
                  : null}

              </div>
            </div>
          </>
        )}
      </main>

      <StockPeekModal entry={peek} onClose={() => setPeek(null)} />

      {/* The handover briefing: opens by itself once per session before the
          US open, and from Shift+M or its card at any other time. One host,
          so the page carries none of its state. */}
      <BriefingHost masked={privacyMode} view={view} />

      {/* Settings. The rail only, for now. */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Update notice — bottom-left, same inset as the brand mark up top. */}
      <UpdatePill className="absolute bottom-6 left-9 z-50" />
    </div>
  );
}
