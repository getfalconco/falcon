"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { Direction, LinkEvidence, RippleSinceEvent } from "@falcon/ripple";
import { useWorkspace } from "./context";

/* The site's type and color, at desktop density. Colors read the theme tokens (app/globals.css). */
export const GEIST = "var(--f-font-sans)";
export const MONO = "var(--font-geist-mono), monospace";
export const SERIF = "var(--font-libre-baskerville), Georgia, serif";

export const INK = "rgb(var(--f-fore))";
export const UP = "rgb(var(--f-up))";
export const DOWN = "rgb(var(--f-down))";
export const NEUTRAL = "rgb(var(--f-flat))";
/** A theme token as a CSS color, optionally with an alpha: `tone("line", 0.08)`. */
export const tone = (name: string, alpha?: number) => (alpha === undefined ? `rgb(var(--f-${name}))` : `rgb(var(--f-${name}) / ${alpha})`);

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
      <h2 className="flex items-center gap-2 text-fs-11 uppercase tracking-[0.16em] text-fore/45" style={{ fontFamily: MONO }}>
        {children}
        {count !== undefined ? <span className="text-fore/30">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-line/[0.08] bg-surface ${className}`}>{children}</section>;
}

/** An empty state's title that is honest about the feed: loading, missing, or really empty. */
export function feedEmpty(status: "loading" | "ready" | "unavailable" | "error", readyTitle: string): string {
  if (status === "loading") return "Loading";
  if (status !== "ready") return "No sightings yet";
  return readyTitle;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line/[0.12] px-4 py-8 text-center">
      <p className="text-fs-13 text-quiet">{title}</p>
      {children}
    </div>
  );
}

/** "+1.9%" with a plain minus for falls. */
export function signedPct(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(1)}%`;
}

/** "Nov 11" from YYYY-MM-DD. */
export function shortDay(ymd: string): string {
  const t = Date.parse(`${ymd}T12:00:00Z`);
  if (!Number.isFinite(t)) return ymd;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Moved +1.9% vs SPY since the event, as of Nov 11 close". */
export function sinceEventText(x: RippleSinceEvent): string {
  return `Moved ${signedPct(x.movePct)} vs ${x.benchmark} since the event, as of ${shortDay(x.asOf)} close`;
}

/** The small "Priced in" label; its title says what it rests on. */
export function PricedInTag({ since }: { since?: RippleSinceEvent | null }) {
  const title = since
    ? `${sinceEventText(since)}${since.pricedInAtPct === null ? "" : `, past half its usual move (${signedPct(since.pricedInAtPct)})`}`
    : "Already moved past half its usual reaction";
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded border border-line/15 px-1.5 text-fs-10.5 uppercase leading-none tracking-[0.08em] text-fore-4"
      style={{ fontFamily: MONO }}
      title={title}
    >
      May be priced in
    </span>
  );
}

/** A ticker that opens its tab. */
export function TickerButton({ ticker, className = "", muted = false }: { ticker: string; className?: string; muted?: boolean }) {
  const { openTicker, portfolioSet } = useWorkspace();
  const owned = portfolioSet.has(ticker);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openTicker(ticker);
      }}
      className={`inline-flex h-[22px] shrink-0 items-center justify-self-start rounded-md border px-1.5 text-fs-11.5 leading-none outline-none transition-colors focus-visible:border-line/50 ${
        owned ? "border-line/25 bg-line/[0.04] text-fore" : "border-line/10 text-fore hover:border-line/30"
      } ${muted ? "text-quiet" : ""} ${className}`}
      style={{ fontFamily: MONO }}
      title={owned ? `${ticker}, in your portfolio` : ticker}
    >
      {ticker}
    </button>
  );
}

export function EvidenceQuote({ evidence }: { evidence: LinkEvidence }) {
  return (
    <figure className="border-l-2 border-line/[0.1] pl-3">
      <blockquote className="text-fs-13 leading-fs-20 text-fore-3" style={{ fontFamily: SERIF }}>
        {evidence.quote}
      </blockquote>
      <figcaption className="mt-1.5 flex items-center gap-2 text-fs-11.5 text-faint" style={{ fontFamily: MONO }}>
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
      className="inline-flex items-center text-fore-4 underline decoration-line/20 underline-offset-2 transition-colors hover:text-fore hover:decoration-line/50"
    >
      {children}
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
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone("line", 0.07)} strokeWidth={stroke} />
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
        <span className="tabular-nums leading-none text-fore" style={{ fontFamily: GEIST, fontSize: Math.round(size / 4.2), fontWeight: 400, color: value === null ? tone("faint") : INK }}>
          {value === null ? "0" : formatNet(value)}
        </span>
        <span
          className="mt-1.5 uppercase text-fore/45"
          style={{ fontFamily: MONO, fontSize: size >= 140 ? 10.5 : 9, letterSpacing: size >= 140 ? "0.14em" : "0.08em" }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

/**
 * Where one ticker's hits point on balance, as an arrow (and a word with
 * `showLabel`): up, down, or mixed when they roughly cancel out.
 */
export function NetMark({ value, showLabel = false, className = "" }: { value: number; showLabel?: boolean; className?: string }) {
  const lean = Math.abs(value) < 5 ? "mixed" : value > 0 ? "up" : "down";
  const Icon = lean === "up" ? ArrowUpRight : lean === "down" ? ArrowDownRight : Minus;
  const word = lean === "up" ? "Up" : lean === "down" ? "Down" : "Mixed";
  const title = lean === "mixed" ? "Today's hits are mixed" : `Today's hits point ${lean}`;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap ${className}`} style={{ color: netColor(value) }} title={title}>
      <Icon width={13} height={13} strokeWidth={2} aria-hidden />
      {showLabel ? <span className="text-fs-12">{word}</span> : <span className="sr-only">{title}</span>}
    </span>
  );
}

export function NetValue({ value, className = "" }: { value: number | null; className?: string }) {
  return (
    <span className={`tabular-nums ${className}`} style={{ color: netColor(value), fontFamily: MONO }}>
      {value === null ? "0" : formatNet(value)}
    </span>
  );
}
