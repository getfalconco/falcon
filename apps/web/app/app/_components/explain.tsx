"use client";

import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, Minus, X } from "lucide-react";
import {
  SIGNAL_LABEL,
  STRENGTH,
  cardExplain,
  cardPricedIn,
  cardStrength,
  relationPhrase as plainRelation,
  shortCompany,
  type CardExplain,
  type CardStrength,
  type Direction,
  type RippleCard,
  type RippleHit,
} from "@falcon/ripple";
import { touchesFocus } from "@/lib/workspace/feed";
import { WorkspaceContext, useWorkspace } from "./context";
import { BacktestButton, DOWN, ExternalAnchor, MONO, NEUTRAL, PricedInTag, SERIF, UP, formatDate, timeAgo } from "./parts";

/*
 * How a Sighting reads, in plain words. Every surface (list cards, the
 * detail tab, the phone layout, the guide) takes its copy from
 * @falcon/ripple `cardExplain` so the same card says the same thing
 * everywhere.
 */

/** The card in plain words, memoized per card. */
export function useExplain(card: RippleCard): CardExplain {
  return useMemo(() => cardExplain(card), [card]);
}

/* ---------------------------------------------------------------- badges */

const STRENGTH_CLASS: Record<CardStrength["level"], string> = {
  measured: "border-[#1d1b1b] bg-[#1d1b1b] text-white",
  research: "border-transparent bg-black/[0.07] text-[#1d1b1b]",
  watching: "border-black/[0.14] bg-transparent text-[#8a8a85]",
};

/** "Backed by research" and friends; its title says what the level means. */
export function StrengthBadge({ strength, className = "" }: { strength: CardStrength; className?: string }) {
  return (
    <span
      className={`inline-flex h-[20px] shrink-0 items-center whitespace-nowrap rounded-full border px-2 text-[11px] leading-none ${STRENGTH_CLASS[strength.level]} ${className}`}
      title={strength.detail}
    >
      {strength.label}
    </span>
  );
}

/** Up / down / unclear as a plain word for one company. */
export const DIRECTION_WORD: Record<Direction, string> = { up: "Positive", down: "Risk", unclear: "Unclear" };

const DIRECTION_SIGNAL: Record<Direction, string> = {
  up: SIGNAL_LABEL.positive,
  down: SIGNAL_LABEL.negative,
  unclear: SIGNAL_LABEL.unclear,
};

function directionTone(direction: Direction): { color: string; tint: string } {
  if (direction === "up") return { color: UP, tint: "rgba(46,125,79,0.08)" };
  if (direction === "down") return { color: DOWN, tint: "rgba(179,67,47,0.08)" };
  return { color: NEUTRAL, tint: "rgba(0,0,0,0.045)" };
}

function DirectionIcon({ direction, size = 13 }: { direction: Direction; size?: number }) {
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return <Icon width={size} height={size} strokeWidth={2} aria-hidden className="shrink-0" />;
}

/** "Positive" in green with its arrow; "Risk" in red; "Unclear" in grey. */
export function DirectionWord({ direction }: { direction: Direction }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px]" style={{ color: directionTone(direction).color }}>
      <DirectionIcon direction={direction} />
      {DIRECTION_WORD[direction]}
    </span>
  );
}

/** Whether every hit is the event company itself (an own-company event). */
export function isSelfOnly(card: RippleCard): boolean {
  return card.hits.length > 0 && card.hits.every((h) => h.relation === "self" || h.ticker === card.event.ticker);
}

/** Opens a ticker's tab when the workspace is interactive; a plain span on the phone layout. */
function TickerAction({
  ticker,
  interactive,
  className,
  style,
  title,
  children,
}: {
  ticker: string;
  interactive: boolean;
  className: string;
  style?: React.CSSProperties;
  title?: string;
  children: ReactNode;
}) {
  // Optional: the guide renders example pills outside any card.
  const openTicker = useContext(WorkspaceContext)?.openTicker;
  if (!interactive || !openTicker) {
    return (
      <span className={className} style={style} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openTicker(ticker);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`${className} outline-none focus-visible:ring-2 focus-visible:ring-black/20`}
      style={style}
      title={title}
    >
      {children}
    </button>
  );
}

/** "↑ Positive signal for KGS": the one pill an own-company card shows. */
export function SignalPill({ hit, interactive = true }: { hit: Pick<RippleHit, "ticker" | "direction" | "companyName">; interactive?: boolean }) {
  const tone = directionTone(hit.direction);
  return (
    <TickerAction
      ticker={hit.ticker}
      interactive={interactive}
      className="inline-flex h-[26px] max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] leading-none"
      style={{ color: tone.color, background: tone.tint }}
      title={`${DIRECTION_SIGNAL[hit.direction]} for ${shortCompany(hit.companyName)}`}
    >
      <DirectionIcon direction={hit.direction} />
      <span>
        {DIRECTION_SIGNAL[hit.direction]} for{" "}
        <span style={{ fontFamily: MONO }} className="text-[12px]">
          {hit.ticker}
        </span>
      </span>
    </TickerAction>
  );
}

/** A linked company as a small chip: ticker and the way the news points for it. */
export function HitChip({ hit, interactive = true, mine = false }: { hit: RippleHit; interactive?: boolean; mine?: boolean }) {
  const tone = directionTone(hit.direction);
  return (
    <TickerAction
      ticker={hit.ticker}
      interactive={interactive}
      className={`inline-flex h-[24px] items-center gap-1 rounded-md border px-1.5 text-[11.5px] leading-none text-[#1d1b1b] transition-colors ${
        mine ? "border-black/25 bg-black/[0.04]" : "border-black/10 hover:border-black/30"
      }`}
      title={`${shortCompany(hit.companyName)}: ${DIRECTION_WORD[hit.direction].toLowerCase()}${mine ? ", on your focus list" : ""}`}
    >
      <span style={{ fontFamily: MONO }}>{hit.ticker}</span>
      <span style={{ color: tone.color }}>
        <DirectionIcon direction={hit.direction} size={12} />
      </span>
      <span className="sr-only">{DIRECTION_WORD[hit.direction]}</span>
    </TickerAction>
  );
}

/** The companies a card reaches: one pill for an own-company card, else chips. */
export function AffectedCompanies({
  card,
  highlight,
  maxHits = 4,
  interactive = true,
}: {
  card: RippleCard;
  highlight?: Set<string>;
  maxHits?: number;
  interactive?: boolean;
}) {
  if (!card.hits.length) return null;
  if (isSelfOnly(card)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {card.hits.map((h) => (
          <SignalPill key={h.ticker} hit={h} interactive={interactive} />
        ))}
      </div>
    );
  }
  const hits = highlight ? [...card.hits].sort((a, b) => Number(highlight.has(b.ticker)) - Number(highlight.has(a.ticker))) : card.hits;
  const shown = hits.slice(0, maxHits);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[12px] text-[#9a9a9a]">Affects</span>
      {shown.map((h) => (
        <HitChip key={h.ticker} hit={h} interactive={interactive} mine={highlight?.has(h.ticker)} />
      ))}
      {hits.length > shown.length ? <span className="text-[12px] text-[#9a9a9a]">+{hits.length - shown.length} more</span> : null}
    </div>
  );
}

/** "Insider buying · FUN · 3d ago". */
export function CardKicker({ card, ex, className = "" }: { card: RippleCard; ex: CardExplain; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[11px] text-[#1d1b1b]/50 ${className}`} style={{ fontFamily: MONO }}>
      <span className="truncate uppercase tracking-[0.12em]">{ex.kicker}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0 whitespace-nowrap text-[11.5px] text-[#1d1b1b]">{card.event.ticker}</span>
      <span aria-hidden>·</span>
      <span className="whitespace-nowrap">{timeAgo(card.event.occurredAt)}</span>
    </span>
  );
}

/* ------------------------------------------------------------- list card */

/** The inside of a list card; shared by the workspace card and the phone layout. */
export function SightingCardBody({
  card,
  highlight,
  maxHits = 4,
  interactive = true,
  footer,
}: {
  card: RippleCard;
  highlight?: Set<string>;
  maxHits?: number;
  interactive?: boolean;
  footer?: ReactNode;
}) {
  const ex = useExplain(card);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <CardKicker card={card} ex={ex} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {cardPricedIn(card) ? <PricedInTag since={card.hits.find((h) => h.pricedIn)?.sinceEvent} /> : null}
          <StrengthBadge strength={ex.strength} />
        </span>
      </div>
      <h3 className="mt-2 text-[15.5px] leading-[23px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
        {ex.title}
      </h3>
      <p className="mt-1 text-[13px] leading-[19px] text-[#767676]">{ex.whyShort}</p>
      <div className="mt-3">
        <AffectedCompanies card={card} highlight={highlight} maxHits={maxHits} interactive={interactive} />
      </div>
      {ex.pastShort || footer ? (
        <div className="mt-2.5 flex items-end gap-3">
          {ex.pastShort ? <p className="min-w-0 flex-1 text-[12px] leading-[17px] text-[#9a9a9a]">{ex.pastShort}</p> : <span className="flex-1" />}
          {footer}
        </div>
      ) : null}
    </>
  );
}

/** A Sightings list card in plain words. Opens its tab on click. */
export function SightingCard({ card, highlight, maxHits = 4 }: { card: RippleCard; highlight?: Set<string>; maxHits?: number }) {
  const { openSighting } = useWorkspace();
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => openSighting(card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openSighting(card.id);
        }
      }}
      className="group cursor-pointer rounded-lg border border-black/[0.08] bg-white px-4 py-3.5 outline-none transition-colors hover:border-black/20 focus-visible:border-black/40"
    >
      <SightingCardBody
        card={card}
        highlight={highlight}
        maxHits={maxHits}
        footer={
          <span className="-mb-1 shrink-0">
            <BacktestButton cardId={card.id} />
          </span>
        }
      />
    </article>
  );
}

/* ------------------------------------------------------- the four answers */

export const ANSWER_HEADINGS = ["What happened", "Why it matters", "After similar events", "Keep in mind"] as const;

/** The four answers every card gives, each under a plain heading. */
export function ExplainSections({ ex, columns = 1 }: { ex: CardExplain; columns?: 1 | 2 }) {
  const bodies = [ex.what, ex.why, ex.past, ex.caution];
  return (
    <div className={`grid grid-cols-1 gap-x-8 gap-y-5 ${columns === 2 ? "xl:grid-cols-2" : ""}`}>
      {ANSWER_HEADINGS.map((heading, i) => (
        <section key={heading}>
          <h2 className="text-[13px] font-medium text-[#1d1b1b]">{heading}</h2>
          <p className="mt-1.5 text-[14px] leading-[22px] text-[#4b4b48]">{bodies[i]}</p>
        </section>
      ))}
    </div>
  );
}

/** The filing behind the event, other filings it uses, and the paper for research-backed cards. */
export function SightingSources({ card, ex }: { card: RippleCard; ex: CardExplain }) {
  const { event } = card;
  const filings = [event.source, ...(event.sources ?? [])].filter((s, i, all) => s.url && all.findIndex((x) => x.url === s.url) === i);
  const doc = ex.strength.level === "watching" ? undefined : card.hits.find((h) => h.documentedBy)?.documentedBy;
  if (!filings.length && !doc) return null;
  return (
    <ul className="flex flex-col gap-2 text-[13px] leading-[19px]">
      {filings.slice(0, 6).map((s, i) => (
        <li key={s.url} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="w-[86px] shrink-0 text-[12px] text-[#9a9a9a]">{i === 0 ? (s.publisher === "SEC EDGAR" ? "SEC filing" : "Source") : "Also used"}</span>
          <ExternalAnchor href={s.url}>{s.title || "Filing"}</ExternalAnchor>
          {s.publishedAt ? <span className="text-[12px] text-[#9a9a9a]">{formatDate(s.publishedAt)}</span> : null}
        </li>
      ))}
      {filings.length > 6 ? <li className="pl-[94px] text-[12px] text-[#9a9a9a]">{filings.length - 6} more filings</li> : null}
      {doc?.citation ? (
        <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="w-[86px] shrink-0 text-[12px] text-[#9a9a9a]">Research</span>
          <ExternalAnchor href={doc.url}>{doc.citation}</ExternalAnchor>
          {doc.period ? <span className="text-[12px] text-[#9a9a9a]">data from {doc.period}</span> : null}
        </li>
      ) : null}
    </ul>
  );
}

/** How a hit is linked, in plain words: "a customer of TSMC", or nothing for the company itself. */
export function hitLinkText(hit: RippleHit, card: RippleCard): string | null {
  if (hit.relation === "self" || hit.ticker === card.event.ticker) return null;
  const from = hit.degree === 2 && hit.via ? hit.via : shortCompany(card.event.companyName);
  const phrase = plainRelation(hit.relation, from);
  return hit.degree === 2 && hit.via ? `${phrase}, which is linked to ${shortCompany(card.event.companyName)}` : phrase;
}

/* ------------------------------------------------------------ the guide */

const GUIDE_KEY = "falcon:how-to-read:v1";

function guideSeen(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_KEY) === "1";
  } catch {
    return true;
  }
}

function markGuideSeen() {
  try {
    window.localStorage.setItem(GUIDE_KEY, "1");
  } catch {
    /* storage blocked: the guide may show again, which is harmless */
  }
}

const ANSWER_HINTS: Record<(typeof ANSWER_HEADINGS)[number], string> = {
  "What happened": "The facts, taken from the filing.",
  "Why it matters": "Why this kind of event can affect the company.",
  "After similar events": "What stocks did after similar events in the past, when Falcon has measured it.",
  "Keep in mind": "Limits, and what to check before you rely on it.",
};

function GuideHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-medium text-[#1d1b1b]">{children}</h3>;
}

/** The "How to read a Sighting" content. */
export function HowToReadContent() {
  return (
    <div className="flex flex-col gap-5 text-[13.5px] leading-[21px] text-[#4b4b48]">
      <p>
        A Sighting is a public event, mostly an SEC filing, that may move a stock. Falcon reads the filing and writes it up in plain words.
      </p>
      <section>
        <GuideHeading>Every card answers four questions</GuideHeading>
        <dl className="mt-2 flex flex-col gap-1.5">
          {ANSWER_HEADINGS.map((h) => (
            <div key={h} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1 max-sm:gap-0">
              <dt className="text-[#1d1b1b]">{h}</dt>
              <dd>{ANSWER_HINTS[h]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <GuideHeading>How much evidence is behind it</GuideHeading>
        <ul className="mt-2 flex flex-col gap-2.5">
          {(["measured", "research", "watching"] as const).map((level) => (
            <li key={level} className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-3 max-sm:grid-cols-1 max-sm:gap-1">
              <span>
                <StrengthBadge strength={STRENGTH[level]} />
              </span>
              <span>{STRENGTH[level].detail}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <GuideHeading>Positive signal and Risk signal</GuideHeading>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <SignalPill hit={{ ticker: "ABC", direction: "up", companyName: "Example" }} interactive={false} />
          <SignalPill hit={{ ticker: "XYZ", direction: "down", companyName: "Example" }} interactive={false} />
        </div>
        <p className="mt-2">
          A Positive signal means the news has, on average, been followed by the stock doing better than the market; a Risk signal, by it doing worse. These are
          averages: many cases did not move that way.
        </p>
      </section>
      <section>
        <GuideHeading>Your portfolio and Opportunities</GuideHeading>
        <p className="mt-2">
          Your portfolio shows Sightings that touch a company on your focus list. Opportunities shows Sightings with evidence behind them about companies that are not
          on your list.
        </p>
      </section>
      <p className="border-t border-black/[0.06] pt-4 text-[12.5px] text-[#767676]">For information only, not investment advice.</p>
    </div>
  );
}

/** The guide as a modal dialog. */
export function HowToReadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[88dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-xl bg-[#fdfdfd] text-[#1d1b1b] shadow-[0_18px_48px_rgba(0,0,0,0.18)] sm:rounded-xl"
      >
        <div className="flex items-center gap-3 border-b border-black/[0.08] px-5 py-3.5">
          <h2 id={titleId} className="text-[19px] leading-[26px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            How to read a Sighting
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-black/[0.06] hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
          >
            <X width={16} height={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <HowToReadContent />
        </div>
        <div className="flex justify-end border-t border-black/[0.08] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-lg bg-[#1c1917] px-4 text-[13px] text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30"
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The "?" button that opens the guide. */
export function HowToReadButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    markGuideSeen();
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label="How to read a Sighting"
        title="How to read a Sighting"
        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-black/15 text-[12px] leading-none text-[#767676] outline-none transition-colors hover:border-black/35 hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20 ${className}`}
      >
        ?
      </button>
      <HowToReadDialog open={open} onClose={close} />
    </>
  );
}

/** Shows the guide once, on the first visit in this browser. */
export function HowToReadFirstVisit() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!guideSeen()) setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    markGuideSeen();
  }, []);
  return <HowToReadDialog open={open} onClose={close} />;
}

/* --------------------------------------------------------- Today sentence */

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "15 new Sightings today. 0 touch your portfolio, 15 are backed by research."
 * Counts by evidence level (cardStrength) and by focus list membership.
 */
export function todaySentence(cards: readonly RippleCard[], focus: Set<string>): string {
  if (!cards.length) return "No new Sightings today.";
  let measured = 0;
  let research = 0;
  let mine = 0;
  for (const c of cards) {
    const level = cardStrength(c).level;
    if (level === "measured") measured++;
    else if (level === "research") research++;
    if (touchesFocus(c, focus)) mine++;
  }
  const verb = (n: number) => (n === 1 ? "is" : "are");
  let evidence: string;
  if (measured && research) evidence = `${measured} ${verb(measured)} measured by Falcon and ${research} ${verb(research)} backed by research`;
  else if (measured) evidence = `${measured} ${verb(measured)} measured by Falcon`;
  else if (research) evidence = `${research} ${verb(research)} backed by research`;
  else evidence = "none has evidence behind it yet";
  const first = `${count(cards.length, "new Sighting", "new Sightings")} today.`;
  if (!focus.size) {
    return `${first} ${evidence.charAt(0).toUpperCase()}${evidence.slice(1)}. Add tickers to your focus list to see which touch your portfolio.`;
  }
  return `${first} ${mine} ${mine === 1 ? "touches" : "touch"} your portfolio, ${evidence}.`;
}
