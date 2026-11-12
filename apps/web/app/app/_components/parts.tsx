"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ExternalLink, Minus } from "lucide-react";
import type { Confidence, Direction, LinkEvidence, RippleCard, RippleHit } from "@falcon/ripple";
import { KIND_LABEL, relationPhrase } from "@/lib/workspace/feed";
import { useWorkspace } from "./context";

/* The site's type and color, at desktop density. */
export const GEIST = "var(--font-geist-sans), sans-serif";
export const MONO = "var(--font-geist-mono), monospace";
export const SERIF = "var(--font-libre-baskerville), Georgia, serif";

export const INK = "#1d1b1b";
export const UP = "#2e7d4f";
export const DOWN = "#b3432f";
export const NEUTRAL = "#8a8a85";

export function directionColor(direction: Direction | null): string {
  return direction === "up" ? UP : direction === "down" ? DOWN : NEUTRAL;
}

export function netColor(value: number | null): string {
  if (value === null || Math.abs(value) < 5) return NEUTRAL;
  return value > 0 ? UP : DOWN;
}

export function formatNet(value: number | null): string {
  if (value === null) return "0";
  return value > 0 ? `+${value}` : `${value}`;
}

export const DIRECTION_LABEL: Record<Direction, string> = { up: "Up", down: "Down", unclear: "Unclear" };
export const CONFIDENCE_LABEL: Record<Confidence, string> = { low: "Low", medium: "Medium", high: "High" };

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Small uppercase mono label above a section. */
export function SectionTitle({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
        {children}
        {count !== undefined ? <span className="text-[#1d1b1b]/30">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-black/[0.08] bg-white ${className}`}>{children}</section>;
}

/** An empty state's title that is honest about the feed: loading, missing, or really empty. */
export function feedEmpty(status: "loading" | "ready" | "unavailable" | "error", readyTitle: string): string {
  if (status === "loading") return "Loading";
  if (status !== "ready") return "No sightings yet";
  return readyTitle;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-black/[0.12] px-4 py-8 text-center">
      <p className="text-[13px] text-[#767676]">{title}</p>
      {children}
    </div>
  );
}

export function DirectionMark({ direction, showLabel = true, size = 13 }: { direction: Direction; showLabel?: boolean; size?: number }) {
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" style={{ color: directionColor(direction) }}>
      <Icon width={size} height={size} strokeWidth={2} aria-hidden />
      {showLabel ? <span className="text-[12px]">{DIRECTION_LABEL[direction]}</span> : <span className="sr-only">{DIRECTION_LABEL[direction]}</span>}
    </span>
  );
}

/** Three short bars, filled up to the confidence level. */
export function ConfidenceMark({ confidence }: { confidence: Confidence }) {
  const level = confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-[#767676]" title={`${CONFIDENCE_LABEL[confidence]} confidence`}>
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className="w-[3px] rounded-[1px]" style={{ height: 4 + i * 2, background: i <= level ? INK : "rgba(0,0,0,0.14)" }} />
        ))}
      </span>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

/** A ticker that opens its tab. */
export function TickerButton({ ticker, className = "", muted = false }: { ticker: string; className?: string; muted?: boolean }) {
  const { openTicker, focusSet } = useWorkspace();
  const inFocus = focusSet.has(ticker);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openTicker(ticker);
      }}
      className={`inline-flex h-[22px] shrink-0 items-center justify-self-start rounded-md border px-1.5 text-[11.5px] leading-none outline-none transition-colors focus-visible:border-black/50 ${
        inFocus ? "border-black/25 bg-black/[0.04] text-[#1d1b1b]" : "border-black/10 text-[#1d1b1b] hover:border-black/30"
      } ${muted ? "text-[#767676]" : ""} ${className}`}
      style={{ fontFamily: MONO }}
      title={inFocus ? `${ticker}, on your focus list` : ticker}
    >
      {ticker}
    </button>
  );
}

export function KindLabel({ kind }: { kind: RippleCard["event"]["kind"] }) {
  return (
    <span className="text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
      {KIND_LABEL[kind]}
    </span>
  );
}

/**
 * One hit on a single line: ticker, how it is linked, direction, confidence
 * and, with `wide`, the expected window.
 */
export function HitRow({ hit, eventTicker, wide = false }: { hit: RippleHit; eventTicker: string; wide?: boolean }) {
  const from = hit.degree === 2 && hit.via ? hit.via : eventTicker;
  return (
    <div
      className={`grid items-center gap-3 ${
        wide ? "grid-cols-[60px_minmax(0,1fr)_76px_84px_minmax(0,140px)]" : "grid-cols-[60px_minmax(0,1fr)_68px_76px]"
      }`}
    >
      <TickerButton ticker={hit.ticker} />
      <span className="min-w-0 truncate text-[12.5px] text-[#4b4b48]" title={relationPhrase(hit.relation, from)}>
        {relationPhrase(hit.relation, from)}
        {hit.degree === 2 ? <span className="text-[#9a9a9a]">, 2nd degree</span> : null}
      </span>
      <DirectionMark direction={hit.direction} />
      <ConfidenceMark confidence={hit.confidence} />
      {wide ? <span className="truncate text-[12px] text-[#9a9a9a]">{hit.window}</span> : null}
    </div>
  );
}

/** A Sightings card: the event and the companies it reaches. Opens its tab on click. */
export function RippleCardView({ card, highlight, maxHits = 4, wide = false }: { card: RippleCard; highlight?: Set<string>; maxHits?: number; wide?: boolean }) {
  const { openSighting } = useWorkspace();
  const hits = highlight
    ? [...card.hits].sort((a, b) => Number(highlight.has(b.ticker)) - Number(highlight.has(a.ticker)))
    : card.hits;
  const shown = hits.slice(0, maxHits);
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
      <div className="flex items-center gap-2">
        <TickerButton ticker={card.event.ticker} />
        <KindLabel kind={card.event.kind} />
        <span className="ml-auto text-[12px] text-[#9a9a9a]">{timeAgo(card.event.occurredAt)}</span>
      </div>
      <h3 className="mt-2 text-[14px] leading-[20px] text-[#1d1b1b]">{card.event.headline}</h3>
      {shown.length ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-black/[0.06] pt-3">
          {shown.map((h) => (
            <HitRow key={h.ticker} hit={h} eventTicker={card.event.ticker} wide={wide} />
          ))}
          {hits.length > shown.length ? (
            <span className="text-[12px] text-[#9a9a9a]">{hits.length - shown.length} more</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function EvidenceQuote({ evidence }: { evidence: LinkEvidence }) {
  return (
    <figure className="border-l-2 border-black/[0.1] pl-3">
      <blockquote className="text-[13px] leading-[20px] text-[#3d3b3a]" style={{ fontFamily: SERIF }}>
        {evidence.quote}
      </blockquote>
      <figcaption className="mt-1.5 flex items-center gap-2 text-[11.5px] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
        <span>{evidence.form}</span>
        <span>{formatDate(evidence.filedAt)}</span>
        <ExternalAnchor href={evidence.url}>Filing</ExternalAnchor>
      </figcaption>
    </figure>
  );
}

export function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https?:\/\//i.test(href) ? href : undefined;
  if (!safe) return <span>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[#4b4b48] underline decoration-black/20 underline-offset-2 transition-colors hover:text-[#1d1b1b] hover:decoration-black/50"
    >
      {children}
      <ExternalLink width={11} height={11} aria-hidden />
    </a>
  );
}

/**
 * Net direction ring, v0 of the Today hero metric: -100 to 100. The arc runs
 * clockwise from the top for positive values and the other way for negative.
 */
export function NetRing({ value, size = 148, label = "Net direction" }: { value: number | null; size?: number; label?: string }) {
  const stroke = Math.max(6, Math.round(size / 18));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const share = value === null ? 0 : Math.min(1, Math.abs(value) / 100);
  const color = netColor(value);
  const dash = `${share * c} ${c}`;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth={stroke} />
        {share > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={dash}
            transform={value !== null && value < 0 ? `translate(${size} 0) scale(-1 1) rotate(-90 ${size / 2} ${size / 2})` : `rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" role="img" aria-label={`${label} ${value === null ? "no data" : formatNet(value)}`}>
        <span className="tabular-nums leading-none text-[#1d1b1b]" style={{ fontFamily: GEIST, fontSize: Math.round(size / 4.2), fontWeight: 400, color: value === null ? "#9a9a9a" : INK }}>
          {value === null ? "0" : formatNet(value)}
        </span>
        <span
          className="mt-1.5 uppercase text-[#1d1b1b]/45"
          style={{ fontFamily: MONO, fontSize: size >= 140 ? 10.5 : 9, letterSpacing: size >= 140 ? "0.14em" : "0.08em" }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

export function NetValue({ value, className = "" }: { value: number | null; className?: string }) {
  return (
    <span className={`tabular-nums ${className}`} style={{ color: netColor(value), fontFamily: MONO }}>
      {value === null ? "0" : formatNet(value)}
    </span>
  );
}
