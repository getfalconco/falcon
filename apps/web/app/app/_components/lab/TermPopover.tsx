"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageCircleQuestion, SquareSlash } from "lucide-react";
import { CLASS_LABEL, PLACE_INFO, glossaryEntry } from "@/lib/desk/glossary";
import type { GlossaryEntry, GlossaryLang } from "@/lib/desk/glossary";

/**
 * A highlighted finance term in a Falcon AI reply and its glossary card, laid
 * out like a dictionary look-up: "Glossary" with the term, its class and
 * numbered definitions; the other language's equivalent; action rows (ask
 * Falcon AI, prefill the related command); tabs for Definition / Example /
 * In Falcon (only those with content). Definitions always come from the fixed
 * glossary (lib/desk/glossary.ts); a value the model attached shows on its own
 * labelled "In this reply" row. Kept compact (at most two definitions until
 * "more", the other language's term on one line) so it fits without scrolling.
 *
 * Opens on hover (after a short delay; it stays open while the pointer moves
 * into the card), on keyboard focus, and on tap or click (which pins it).
 * Enter or Space toggles, Escape closes, Tab moves into the card. It sits
 * above or below the term, kept inside the chat panel ([data-term-panel])
 * and below the top of the message list ([data-term-bounds]).
 */

/** The composer hooks the card's action rows use (LabChat provides them). */
export const GlossaryActions = createContext<{ ask: (text: string) => void; prefill: (text: string) => void } | null>(null);

const OPEN_DELAY = 280;
const CLOSE_DELAY = 160;
const GAP = 8;
const SERIF = "[font-family:ui-serif,Georgia,'Times_New_Roman',serif]";
const EDGE = 8;
/** Definitions shown before the "more" link. */
const MAX_DEFS = 2;

const UI = {
  tr: { glossary: "Sözlük", pair: "Türkçe–İngilizce", now: "Bu yanıtta", more: (n: number) => `${n} tanım daha`, ask: "Falcon AI'a sor", open: (c: string) => `${c} ile aç`, tabs: { def: "Tanım", ex: "Örnek", app: "Falcon'da" }, question: (t: string) => `${t} nedir, örnekle anlat.`, label: (t: string) => `${t}: sözlük` },
  en: { glossary: "Glossary", pair: "English–Turkish", now: "In this reply", more: (n: number) => `${n} more`, ask: "Ask Falcon AI", open: (c: string) => `Open with ${c}`, tabs: { def: "Definition", ex: "Example", app: "In Falcon" }, question: (t: string) => `What is ${t}? Explain with an example.`, label: (t: string) => `${t}: glossary` },
} as const;

type Tab = "def" | "ex" | "app";

/** Only one card at a time: opening one closes the last. */
let closeOpen: (() => void) | null = null;

export function Term({ termKey, lang, value, children }: { termKey: string; lang: GlossaryLang; value?: string; children: ReactNode }) {
  const entry = glossaryEntry(termKey);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  // Focus put back on the term after Escape must not reopen the card.
  const quiet = useRef(false);
  const id = useId();

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPinned(false);
  }, []);
  const show = useCallback(
    (pin: boolean) => {
      window.clearTimeout(timer.current);
      if (closeOpen && closeOpen !== close) closeOpen();
      closeOpen = close;
      setOpen(true);
      if (pin) setPinned(true);
    },
    [close],
  );
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) {
      if (closeOpen === close) closeOpen = null;
      return;
    }
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !card.current?.contains(t)) close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);

  if (!entry) return <>{children}</>;

  const hoverIn = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch") return;
    if (open) window.clearTimeout(timer.current);
    else later(() => show(false), OPEN_DELAY);
  };
  const hoverOut = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch") return;
    if (pinned) return;
    later(() => setOpen(false), open ? CLOSE_DELAY : 0);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) close();
      else show(true);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if ((e.key === "Tab" && !e.shiftKey) || e.key === "ArrowDown") {
      const first = card.current?.querySelector<HTMLElement>("button");
      if (open && first) {
        e.preventDefault();
        setPinned(true);
        first.focus();
      }
    }
  };

  return (
    <>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-term={termKey}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onClick={() => (open && pinned ? close() : show(true))}
        onFocus={(e) => {
          if (quiet.current) quiet.current = false;
          else if (e.currentTarget.matches(":focus-visible")) show(false);
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!pinned && !(next && card.current?.contains(next))) later(() => setOpen(false), 0);
        }}
        onKeyDown={onKey}
        className={`cursor-help rounded-[3px] text-quiet underline decoration-quiet/55 decoration-dotted decoration-[1.5px] underline-offset-[3px] transition-colors duration-150 [box-decoration-break:clone] hover:text-fore-3 hover:decoration-quiet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25 ${
          open ? "bg-line/[0.07] text-fore-3 decoration-quiet" : ""
        }`}
      >
        {children}
      </span>
      {open ? (
        <TermCard
          id={id}
          entry={entry}
          lang={lang}
          value={value}
          anchor={anchor}
          card={card}
          onEnter={() => window.clearTimeout(timer.current)}
          onLeave={() => {
            if (!pinned) later(() => setOpen(false), CLOSE_DELAY);
          }}
          onClose={(refocus) => {
            close();
            if (refocus) {
              quiet.current = true;
              anchor.current?.focus({ preventScroll: true });
            }
          }}
          onFocusIn={() => setPinned(true)}
        />
      ) : null}
    </>
  );
}

/** Where a popover card sits: its fixed position, a height cap when it must scroll, and the side of its anchor. */
export type PopoverPos = { left: number; top: number; maxH?: number; above: boolean };

/**
 * Places a fixed popover `card` next to `anchor` (the glossary card here; the source card, lab/SourceCite.tsx).
 * `deps`: what changes the card's size (its tab, "more").
 */
export function usePopoverPlacement(anchor: RefObject<HTMLElement>, card: RefObject<HTMLElement>, deps: unknown[]): PopoverPos | null {
  const [pos, setPos] = useState<PopoverPos | null>(null);
  // Vertically inside the chat panel's visible area: from the top of the message
  // list (never over the panel header or the top bar) to the bottom of the panel.
  // Below the term when it fits there and that side has more room, else the side
  // where it fits; if neither fits, beside the term when the panel is wide enough,
  // and only then the roomier side with the card capped (it scrolls).
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current;
      const c = card.current;
      if (!a || !c) return;
      const rects = a.getClientRects();
      const r = rects[0] ?? a.getBoundingClientRect();
      const list = a.closest("[data-term-bounds]")?.getBoundingClientRect();
      const panel = a.closest("[data-term-panel]")?.getBoundingClientRect() ?? list;
      const left0 = Math.max(panel?.left ?? 0, 0) + EDGE;
      const right0 = Math.min(panel?.right ?? window.innerWidth, window.innerWidth) - EDGE;
      const top0 = Math.max(list?.top ?? 0, 0) + EDGE;
      const bottom0 = Math.min(panel?.bottom ?? window.innerHeight, window.innerHeight) - EDGE;
      // Natural height, measured without the cap from a previous placement.
      const cap = c.style.maxHeight;
      c.style.maxHeight = "none";
      const h = c.offsetHeight;
      const w = c.offsetWidth;
      c.style.maxHeight = cap;
      const spaceAbove = r.top - GAP - top0;
      const spaceBelow = bottom0 - r.bottom - GAP;
      const fitsAbove = h <= spaceAbove;
      const fitsBelow = h <= spaceBelow;
      if (!fitsAbove && !fitsBelow && h <= bottom0 - top0) {
        // Fits on neither side (a term mid-thread in a short window): beside the term when the panel is wide enough.
        const box = a.getBoundingClientRect();
        const side = right0 - box.right - GAP >= w ? box.right + GAP : box.left - GAP - left0 >= w ? box.left - GAP - w : null;
        if (side !== null) {
          setPos({ left: side, top: Math.min(Math.max(r.top + r.height / 2 - h / 2, top0), bottom0 - h), above: false });
          return;
        }
      }
      const above = fitsAbove && fitsBelow ? spaceAbove > spaceBelow : fitsAbove ? true : fitsBelow ? false : spaceAbove > spaceBelow;
      const room = Math.max(160, above ? spaceAbove : spaceBelow);
      const height = Math.min(h, room);
      const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, left0), Math.max(left0, right0 - w));
      const top = above ? r.top - GAP - height : r.bottom + GAP;
      setPos({ left, top, maxH: h > room ? room : undefined, above });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, card, ...deps]);
  return pos;
}

function TermCard({
  id,
  entry,
  lang,
  value,
  anchor,
  card,
  onEnter,
  onLeave,
  onClose,
  onFocusIn,
}: {
  id: string;
  entry: GlossaryEntry;
  lang: GlossaryLang;
  value?: string;
  anchor: RefObject<HTMLSpanElement>;
  card: RefObject<HTMLDivElement>;
  onEnter: () => void;
  onLeave: () => void;
  onClose: (refocus: boolean) => void;
  onFocusIn: () => void;
}) {
  const ui = UI[lang];
  const other: GlossaryLang = lang === "tr" ? "en" : "tr";
  const main = entry[lang];
  const alt = entry[other];
  const place = entry.at ? PLACE_INFO[entry.at] : undefined;
  const actions = useContext(GlossaryActions);
  const tabs = (["def", "ex", "app"] as Tab[]).filter((t) => t === "def" || (t === "ex" ? !!(main.example || alt.example) : !!place));
  const [tab, setTab] = useState<Tab>("def");
  const [more, setMore] = useState(false);
  const pos = usePopoverPlacement(anchor, card, [tab, more]);


  const focusables = () => Array.from(card.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (e.key === "Tab") {
      const list = focusables();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        anchor.current?.focus({ preventScroll: true });
      } else if (!e.shiftKey && at === list.length - 1) {
        e.preventDefault();
        list[0]?.focus();
      }
    }
  };
  const tabKey = (e: ReactKeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next);
    card.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  const run = (fn: () => void) => {
    onClose(false);
    fn();
  };

  const defs = more ? main.defs : main.defs.slice(0, MAX_DEFS);
  const hidden = main.defs.length - defs.length;

  const body = (
    <div
      ref={card}
      id={id}
      role="dialog"
      aria-label={ui.label(main.term)}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onFocusIn}
      onKeyDown={onKey}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxH, visibility: pos ? "visible" : "hidden" }}
      className={`fixed z-[90] flex w-[min(340px,calc(100vw-16px))] flex-col overflow-hidden rounded-[16px] border border-line/[0.1] bg-raised/[0.86] text-fore shadow-[0_20px_50px_-14px_rgba(0,0,0,0.28),0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur-2xl backdrop-saturate-150 dark:border-line/[0.12] dark:bg-raised/[0.82] dark:shadow-[0_20px_50px_-10px_rgba(0,0,0,0.75),0_0_0_0.5px_rgba(255,255,255,0.04)] ${
        pos ? `animate-in fade-in-0 zoom-in-[0.98] duration-150 ease-out motion-reduce:animate-none ${pos.above ? "slide-in-from-bottom-1" : "slide-in-from-top-1"}` : ""
      }`}
    >
      <div
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-1 pt-2.5 ${pos?.maxH ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]" : ""}`}
      >
        {tab === "def" ? (
          <>
            <Section title={ui.glossary}>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className={`${SERIF} text-fs-17 font-bold leading-fs-22 tracking-[-0.005em] text-fore`}>{main.term}</span>
                <span className="text-fs-12 italic text-quiet">{CLASS_LABEL[lang][entry.cls]}</span>
              </p>
              <ol className="mt-0.5 flex flex-col">
                {defs.map((d, i) => (
                  <li key={i} className={`flex gap-2 ${SERIF} text-fs-13.5 leading-fs-19 text-fore-2`}>
                    <span aria-hidden className="w-2.5 shrink-0 text-right font-sans text-fs-11.5 font-semibold leading-fs-19 text-faint [font-variant-numeric:tabular-nums]">
                      {i + 1}
                    </span>
                    <span className="min-w-0">{d}</span>
                  </li>
                ))}
              </ol>
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={() => setMore(true)}
                  className="ml-[18px] mt-0.5 rounded text-fs-11.5 font-medium leading-fs-17 text-quiet underline decoration-quiet/40 underline-offset-2 transition-colors hover:text-fore-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25"
                >
                  {ui.more(hidden)}
                </button>
              ) : null}
              {value ? (
                <div className="mt-1.5 flex items-baseline gap-2 rounded-[9px] border border-line/[0.08] bg-line/[0.045] px-2 py-1">
                  <span className="shrink-0 text-fs-10 font-semibold uppercase tracking-[0.06em] text-faint">{ui.now}</span>
                  <span className="min-w-0 text-fs-12.5 font-medium leading-fs-17 text-fore [font-variant-numeric:tabular-nums]">{value}</span>
                </div>
              ) : null}
            </Section>
            {/* One line: label, rule, the other language's term; a long term wraps below the label. */}
            <p className="flex flex-wrap items-baseline gap-x-2 pb-1.5">
              <span className="shrink-0 text-fs-12.5 font-semibold leading-fs-18 tracking-[-0.01em] text-fore-3">{ui.pair}</span>
              <span aria-hidden className="h-px min-w-3 flex-1 self-center bg-line/[0.16]" />
              <span className={`min-w-0 ${SERIF} text-fs-14 font-semibold leading-fs-19 text-fore`}>
                {equivalents(main.term, [alt.term, ...alt.forms]).join(" · ")}
              </span>
            </p>
          </>
        ) : tab === "ex" ? (
          <Section title={ui.tabs.ex}>
            {main.example ? <p className={`${SERIF} text-fs-13.5 leading-fs-19 text-fore-2`}>{main.example}</p> : null}
            {alt.example ? <p className="mt-1 text-fs-12 leading-fs-17 text-quiet">{alt.example}</p> : null}
          </Section>
        ) : place ? (
          <Section title={ui.tabs.app}>
            <p className="text-fs-13 leading-fs-19 text-fore-2">{place[lang]}</p>
          </Section>
        ) : null}
      </div>

      {actions ? (
        <div className="mx-1.5 shrink-0 divide-y divide-line/[0.09] border-t border-line/[0.09]">
          <ActionRow label={ui.ask} icon={<MessageCircleQuestion width={15} height={15} strokeWidth={1.6} aria-hidden />} onClick={() => run(() => actions.ask(ui.question(main.term)))} />
          {place?.command ? (
            <ActionRow label={ui.open(place.command)} icon={<SquareSlash width={15} height={15} strokeWidth={1.6} aria-hidden />} onClick={() => run(() => actions.prefill(`${place.command} `))} />
          ) : null}
        </div>
      ) : null}

      {tabs.length > 1 ? (
        <div role="tablist" aria-label={ui.label(main.term)} className="m-1.5 flex shrink-0 gap-0.5 rounded-[11px] bg-line/[0.055] p-0.5 dark:bg-line/[0.07]">
          {tabs.map((t, i) => (
            <button
              key={t}
              type="button"
              role="tab"
              data-tab={t}
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => tabKey(e, i)}
              className={`h-[26px] flex-1 rounded-[9px] text-fs-12 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25 ${
                tab === t ? "bg-surface/90 text-fore shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-line/[0.12]" : "text-quiet hover:text-fore-3"
              }`}
            >
              {ui.tabs[t]}
            </button>
          ))}
        </div>
      ) : (
        <div className="h-1.5 shrink-0" />
      )}
    </div>
  );
  return createPortal(body, document.body);
}

/** The other language's names for the term, without repeating the term itself (OPRA → Options Price Reporting Authority). */
function equivalents(term: string, names: string[]): string[] {
  const seen = new Set([term.toLocaleLowerCase("tr")]);
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.replace(/^=/, "");
    const k = n.toLocaleLowerCase("tr");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return (out.length ? out : [term]).slice(0, 2);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pb-1.5">
      <h3 className="mb-0.5 flex items-center gap-2 text-fs-12.5 font-semibold leading-fs-18 tracking-[-0.01em] text-fore-3">
        <span className="shrink-0">{title}</span>
        <span aria-hidden className="h-px flex-1 bg-line/[0.16]" />
      </h3>
      <div className="pl-2">{children}</div>
    </section>
  );
}

function ActionRow({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[30px] w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-fs-13 font-semibold text-fore-2 transition-colors hover:bg-line/[0.05] hover:text-fore focus-visible:bg-line/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-line/20"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-quiet">{icon}</span>
    </button>
  );
}
