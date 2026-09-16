import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ArrowUp, Loader2, X } from "lucide-react";
import SelectionGloss from "./SelectionGloss";
import StockIcon from "../stock/StockIcon";
import InsightPairFrame, { type InsightPairSubject } from "./InsightPairFrame";
import { formatPricedIn, pricedInColor } from "../../lib/second-order-card";
import { livePricedIn, targetPricedIn } from "../../../shared/propagation-progress";
import { useLivePrices } from "@/hooks/useLivePrices";
import { cn } from "../../lib/utils";
import type { PropagationTarget } from "../../../shared/propagation-run-types";
import type {
  InsightExplanation,
  InsightExplanationRequest,
} from "../../../shared/insight-explanation";
import type { PairExplanationRequest } from "../../../shared/pair-explanation";
import type { InsightChatTurn } from "../../../shared/insight-chat";

/**
 * The Insight card's detail surface: the same glass frame the cards and the
 * command menu use, blown up to ~70% of the window. It opens over a blurred
 * backdrop, and its masthead is a window drag region, so the app can still be
 * moved while the panel is open.
 *
 * The right side has two states. Resting, it is the cast of the event — the
 * company it happened to, then the names it reaches. Step into one of those
 * names and the same side widens into a frame on that pair, and the write-up
 * on the left narrows to make room.
 */

const PANEL_TWEEN = { type: "spring", stiffness: 260, damping: 28, mass: 0.9 } as const;

/** The rail's group headings, set like the panel's own masthead. */
const RAIL_LABEL =
  "select-none px-1 font-sans text-[10.5px] font-medium tracking-[0.08em] text-[#9CA3AF]";

/** Resting width of the panel's right side. */
const RAIL_W = 248;

/**
 * How wide the right side runs once a name is open: enough for a column of
 * prose and a year of days, but never so much that the headline beside it is
 * squeezed to nothing on a small window.
 */
function paneWidth(windowWidth: number, pairOpen: boolean): number {
  if (!pairOpen) return RAIL_W;
  // The panel is 70vw with a 24px pad each side.
  const content = windowWidth * 0.7 - 48;
  return Math.round(Math.max(RAIL_W, Math.min(560, content * 0.55)));
}

/**
 * One name in the right rail: the same glass surface as the cards, carrying
 * the ticker and — for the names the event reaches — how much of the move is
 * already priced in, in the calendar's own ramp. The group heading above it
 * says which list it belongs to, so the row itself stays a name.
 *
 * Two doors: the name opens that stock, the arrow beside it opens this pair's
 * frame without leaving the panel.
 */
function TickerButton({
  symbol,
  companyName,
  pricedIn,
  onPick,
  onOpen,
  prominent,
}: {
  symbol: string;
  companyName?: string;
  /** Signed share of the called move travelled; omitted for the root, which
   *  is the event itself rather than a name it reaches. */
  pricedIn?: number | null;
  onPick?: (ticker: string) => void;
  /** Only the names the event reaches have a pair to open. */
  onOpen?: (ticker: string) => void;
  prominent?: boolean;
}) {
  const share = pricedIn === undefined ? null : formatPricedIn(pricedIn);
  const glass =
    "border border-white/60 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-white/75 disabled:pointer-events-none";
  return (
    <div className="flex items-stretch gap-1.5">
      <button
        type="button"
        onClick={() => onPick?.(symbol)}
        disabled={!onPick}
        title={companyName ? `${symbol} — ${companyName}` : symbol}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl px-3 text-left",
          glass,
          prominent ? "py-3" : "py-2.5",
        )}
      >
        <StockIcon
          symbol={symbol}
          companyName={companyName}
          size="sm"
          className={cn("shrink-0", prominent ? "h-6 w-6" : "h-[18px] w-[18px]")}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-semibold leading-none text-[#1d1b1b]",
            prominent ? "text-[14px]" : "text-[12.5px]",
          )}
        >
          {symbol}
        </span>
        {share != null ? (
          <span
            className="flex shrink-0 items-center gap-1.5"
            title={`${share} of the called move`}
          >
            <span
              aria-hidden
              className="block h-[10px] w-[10px] rounded-[2px]"
              style={{ backgroundColor: pricedInColor(pricedIn) }}
            />
            <span className="w-[42px] text-right font-['Geist_Mono'] text-[10.5px] tabular-nums text-[#6b7280]">
              {share}
            </span>
          </span>
        ) : null}
      </button>

      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(symbol)}
          aria-label={`Why ${symbol} is affected`}
          title={`Why ${symbol} is affected`}
          className={cn(
            "flex w-9 shrink-0 items-center justify-center rounded-2xl text-[#4b5563] hover:text-[#1d1b1b]",
            glass,
          )}
        >
          <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export default function InsightDetailModal({
  open,
  onClose,
  title,
  headline,
  request,
  rootTicker,
  targets,
  onPickTicker,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Small label in the panel's masthead. */
  title?: string;
  /** The card's headline, verbatim — the panel opens on it. */
  headline?: string;
  /** Everything the write-up needs; main answers from cache or writes one. */
  request?: InsightExplanationRequest | null;
  /** The company the event happened to — the head of the right rail. */
  rootTicker?: string;
  /** The names it reaches, already in priority order (see `cardTargets`). */
  targets?: PropagationTarget[];
  /** Clicking a name in the rail. Without it the buttons are inert. */
  onPickTicker?: (ticker: string) => void;
  children?: ReactNode;
}) {
  const [explanation, setExplanation] = useState<InsightExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The composer's line, kept while the panel is open. */
  const [draft, setDraft] = useState("");
  /** The name the right side has stepped into; null is the rail. */
  const [pair, setPair] = useState<InsightPairSubject | null>(null);
  /** The conversation under the brief. Lives with the open event, and goes
   *  with it — a question is one reader's, and is never cached. */
  const [turns, setTurns] = useState<InsightChatTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Only names with a ticker can be a button, and only once each: a graph can
   * reach the same company through two edges (partner and competitor, say),
   * which is one row here — the first, so the caller's priority order decides
   * which reading survives.
   */
  const rail = useMemo(() => {
    const seen = new Set<string>();
    const rows: PropagationTarget[] = [];
    for (const t of targets ?? []) {
      const ticker = (t.ticker ?? "").trim().toUpperCase();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      rows.push(t);
    }
    return rows;
  }, [targets]);

  const railPrices = useLivePrices(
    useMemo(
      () =>
        (rail.map((t) => (t.ticker ?? "").toUpperCase()).filter(Boolean) as string[])
          .sort()
          .join(","),
      [rail],
    ),
  );

  /**
   * One reading of "how much of this is priced in", shared with the card:
   * measured off the price on screen when there is one, the engine's stored
   * figure when there is not.
   */
  const pricedInOf = (t: PropagationTarget): number | null => {
    const price = railPrices[(t.ticker ?? "").toUpperCase()];
    return livePricedIn(t, price) ?? targetPricedIn(t);
  };

  // The pane's width is read off the window because the panel is sized in vw.
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const paneW = paneWidth(windowWidth, pair != null);

  // A closed panel, or a different event, always reopens on the rail.
  useEffect(() => {
    if (!open) setPair(null);
  }, [open]);
  useEffect(() => {
    setPair(null);
  }, [request?.run_id]);

  const openPair = (ticker: string) => {
    const target = rail.find((t) => (t.ticker ?? "").toUpperCase() === ticker.toUpperCase());
    if (!target) return;
    setPair({
      ticker,
      label: target.label,
      role: target.relationship.role,
      tier: target.relationship.tier,
      mechanism: target.mechanism,
      pricedIn: pricedInOf(target),
    });
  };

  /** What the frame needs to commission its write-up; the record it fetches. */
  const pairRequest: Omit<PairExplanationRequest, "record" | "precedents"> | null = useMemo(() => {
    if (!pair || !request?.run_id || !rootTicker) return null;
    return {
      run_id: request.run_id,
      headline: request.headline,
      root_ticker: rootTicker,
      target_ticker: pair.ticker,
      target_label: pair.label,
      event_type: request.event_type,
      event_direction: request.event_direction,
      event_materiality: request.event_materiality,
      role: pair.role,
      tier: pair.tier,
      mechanism: pair.mechanism,
    };
  }, [pair, request, rootTicker]);

  const submit = () => {
    const text = draft.trim();
    if (!text || asking || !request?.run_id) return;
    const next: InsightChatTurn[] = [...turns, { role: "user", text }];
    setTurns(next);
    setDraft("");
    setChatError(null);
    setAsking(true);

    const pending = window.meridian?.askInsightChat?.({
      run_id: request.run_id,
      headline: request.headline,
      root_ticker: request.root_ticker,
      event_type: request.event_type,
      event_direction: request.event_direction,
      event_materiality: request.event_materiality,
      summary: explanation?.summary,
      points: explanation?.points,
      names: rail.map((t) => ({
        ticker: (t.ticker ?? "").toUpperCase(),
        label: t.label,
        mechanism: t.mechanism,
        priced_in: targetPricedIn(t),
      })),
      turns: next,
    });
    if (!pending) {
      setAsking(false);
      setChatError("No chat service available.");
      return;
    }
    void pending
      .then((res) => {
        if (res?.ok) setTurns((prev) => [...prev, { role: "assistant", text: res.reply }]);
        else setChatError(res?.error ?? "Couldn't answer that one.");
      })
      .catch(() => setChatError("Couldn't reach the chat service."))
      .finally(() => setAsking(false));
  };

  // A new answer, or a new question, brings the foot of the thread into view.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: turns.length > 1 ? "smooth" : "auto" });
  }, [turns.length, asking]);

  // The thread belongs to the event it was asked about.
  useEffect(() => {
    setTurns([]);
    setChatError(null);
  }, [request?.run_id]);

  // Asked for on open, not on mount: a closed panel costs nothing. Main serves
  // the file cache, then Supabase, and only writes a new one if neither has it.
  useEffect(() => {
    if (!open || !request?.run_id) return;
    let cancelled = false;
    setError(null);
    setExplanation(null);
    setLoading(true);
    // Optional chaining short-circuits the whole chain when the handler is
    // missing (an old preload, the preview harness) — without this the panel
    // would sit on "Writing the brief…" forever.
    const pending = window.meridian?.getInsightExplanation?.(request);
    if (!pending) {
      setLoading(false);
      setError("No explanation service available.");
      return;
    }
    void pending
      .then((res) => {
        if (cancelled) return;
        if (res?.ok) setExplanation(res.explanation);
        else setError(res?.error ?? "No explanation available.");
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't reach the explanation service.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, request?.run_id, request?.headline]);

  // Esc steps back out of a name first, and only then closes the panel. The
  // page behind never scrolls under it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (pair) setPair(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, pair]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="insight-detail"
          className="fixed inset-0 z-[80] flex items-center justify-center"
          initial={false}
          animate={{}}
          exit={{}}
        >
          {/* Backdrop — the dashboard blurs away behind the panel. */}
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          {/* Panel — the shared glass surface at ~70% of the window. */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title ?? "Insight details"}
            className="app-no-drag relative flex h-[70vh] w-[70vw] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            initial={{ opacity: 0, scale: 0.94, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={PANEL_TWEEN}
          >
            {/* The panel covers the window's own drag strip, so its masthead
                takes that job — the close button opts back out through the
                app-drag-region rule for interactive children. */}
            <motion.div
              className="app-drag-region flex items-center justify-between"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            >
              <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
                {title ?? "INSIGHT"}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="app-no-drag rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </motion.div>

            {/* Under the masthead the panel is two columns: the write-up and
                its composer on the left, the event's cast — or the name the
                reader stepped into — on the right. */}
            <div className="flex min-h-0 flex-1 gap-6">
              <div className="flex min-w-0 flex-1 flex-col">
                {/* Body: the headline verbatim, then the written explanation. */}
                <motion.div
                  ref={scrollerRef}
                  className="min-h-0 flex-1 overflow-y-auto pr-1"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.12, duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
                >
                  {headline ? (
                    <SelectionGloss context={headline} ticker={request?.root_ticker}>
                      <h2 className="max-w-[46ch] pt-4 font-sans text-[30px] font-medium leading-[1.24] tracking-[-0.015em] text-[#1d1b1b]">
                        {headline}
                      </h2>
                    </SelectionGloss>
                  ) : null}

                  <div className="mt-6 max-w-[62ch]">
                    <AnimatePresence mode="wait" initial={false}>
                      {loading ? (
                        <motion.div
                          key="loading"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="flex items-center gap-2 text-[13px] text-[#9CA3AF]"
                        >
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          Writing the brief…
                        </motion.div>
                      ) : explanation ? (
                        <motion.div
                          key="explanation"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
                        >
                          <SelectionGloss context={explanation.summary} ticker={request?.root_ticker}>
                            <p className="text-[15px] leading-[1.65] text-[#374151]">
                              {explanation.summary}
                            </p>
                          </SelectionGloss>
                          {explanation.points.length > 0 && (
                            <ul className="mt-5 space-y-2.5">
                              {explanation.points.map((point, i) => (
                                <motion.li
                                  key={point}
                                  initial={{ opacity: 0, y: 6 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ delay: 0.06 * i, duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                                  className="flex gap-2.5 text-[13.5px] leading-[1.55] text-[#4b5563]"
                                >
                                  <span
                                    aria-hidden
                                    className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-[#9CA3AF]"
                                  />
                                  <span>{point}</span>
                                </motion.li>
                              ))}
                            </ul>
                          )}
                        </motion.div>
                      ) : error ? (
                        <motion.p
                          key="error"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="text-[13px] text-[#9CA3AF]"
                        >
                          {error}
                        </motion.p>
                      ) : null}
                    </AnimatePresence>
                  </div>

                  {/* The conversation. The brief opens it; everything under
                      the rule is this reader's own thread. */}
                  {turns.length > 0 || asking || chatError ? (
                    <div className="mt-8 border-t border-black/[0.06] pt-6">
                      {turns.map((turn, i) =>
                        turn.role === "user" ? (
                          <p
                            key={`${i}-q`}
                            className="mt-6 text-[14px] font-medium leading-[1.55] text-[#1d1b1b] first:mt-0"
                          >
                            {turn.text}
                          </p>
                        ) : (
                          <motion.div
                            key={`${i}-a`}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                            className="mt-2.5"
                          >
                            <SelectionGloss context={turn.text} ticker={request?.root_ticker}>
                              <p className="text-[14px] leading-[1.62] text-[#374151]">
                                {turn.text}
                              </p>
                            </SelectionGloss>
                          </motion.div>
                        ),
                      )}

                      {asking ? (
                        <div className="mt-3 flex items-center gap-2 text-[13px] text-[#9CA3AF]">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          Thinking…
                        </div>
                      ) : null}

                      {chatError ? (
                        <p className="mt-3 text-[13px] text-[#9CA3AF]">{chatError}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {children}
                </motion.div>

                {/* Composer — the dashboard search pill, with a glass send button
                    beside it. Outside the scroller, so it never scrolls away.
                    It holds the headline's line rather than the panel's full
                    width: same 46ch, and the type utilities are only here so
                    that ch resolves against the headline's font, size and weight —
                    nothing in the form renders at them, the input and the icon set
                    their own. */}
                <motion.form
                  className="mt-4 flex w-full max-w-[46ch] shrink-0 items-center gap-2 font-sans text-[30px] font-medium"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.16, duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  <div className="flex h-10 min-w-0 flex-1 items-center rounded-full border border-white/60 bg-white/55 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors focus-within:bg-white/70">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={asking ? "Thinking…" : "Ask about this insight"}
                      aria-label="Ask about this insight"
                      disabled={asking}
                      className="min-w-0 flex-1 bg-transparent text-[13.5px] font-normal text-[#1d1b1b] outline-none placeholder:text-[#9CA3AF]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={draft.trim().length === 0 || asking}
                    aria-label="Send"
                    title="Send"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/60 bg-white/55 text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ArrowUp className="h-4 w-4" strokeWidth={2} aria-hidden />
                  </button>
                </motion.form>
              </div>

              {/* The right side. Resting it is the rail — the event's centre,
                  then the names it reaches in the order the card ranks them:
                  strongest relationship first, and within a tier the least
                  priced-in first. Stepping into a name widens it into that
                  pair's frame; the width is what makes the left column narrow,
                  so the two move as one. */}
              {rootTicker || rail.length > 0 ? (
                <motion.div
                  className="shrink-0 overflow-hidden"
                  initial={{ opacity: 0, x: 14, width: RAIL_W }}
                  animate={{ opacity: 1, x: 0, width: paneW }}
                  transition={{
                    opacity: { delay: 0.14, duration: 0.34, ease: [0.4, 0, 0.2, 1] },
                    x: { delay: 0.14, duration: 0.34, ease: [0.4, 0, 0.2, 1] },
                    width: { type: "spring", stiffness: 300, damping: 34, mass: 0.8 },
                  }}
                >
                  <div className="h-full pt-4" style={{ width: paneW }}>
                    <AnimatePresence mode="wait" initial={false}>
                      {pair ? (
                        <motion.div
                          key={`pair-${pair.ticker}`}
                          className="h-full"
                          initial={{ opacity: 0, x: 18 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 18 }}
                          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                        >
                          <InsightPairFrame
                            rootTicker={rootTicker ?? ""}
                            subject={pair}
                            request={pairRequest}
                            onBack={() => setPair(null)}
                          />
                        </motion.div>
                      ) : (
                        <motion.aside
                          key="rail"
                          aria-label="Companies in this event"
                          className="flex h-full flex-col gap-2 overflow-y-auto"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18 }}
                        >
                          {rootTicker ? (
                            <>
                              <span className={RAIL_LABEL}>EVENT CENTRE</span>
                              <TickerButton
                                symbol={rootTicker.toUpperCase()}
                                onPick={onPickTicker}
                                prominent
                              />
                            </>
                          ) : null}

                          {rail.length > 0 ? (
                            <>
                              <span className={cn(RAIL_LABEL, rootTicker && "mt-3")}>AFFECTED</span>
                              {rail.map((t) => (
                                <TickerButton
                                  key={t.target}
                                  symbol={(t.ticker ?? "").toUpperCase()}
                                  companyName={t.label}
                                  pricedIn={pricedInOf(t)}
                                  onPick={onPickTicker}
                                  onOpen={openPair}
                                />
                              ))}
                            </>
                          ) : null}
                        </motion.aside>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
