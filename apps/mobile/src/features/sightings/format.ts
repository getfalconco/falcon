import type { Confidence, Direction, RippleEvent, Relation } from "@falcon/ripple";
import { signal } from "@/theme";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Thursday, Nov 12" */
export function longDate(d: Date): string {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Feb 21, 2026" */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Nov 11" from YYYY-MM-DD. */
export function shortDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** "Just now", "12m ago", "3h ago", "Yesterday", "Nov 9". */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export const EVENT_KIND: Record<RippleEvent["kind"], string> = {
  earnings_surprise: "Earnings",
  guidance: "Guidance",
  filing: "Filing",
  news: "News",
};

export const RELATION: Record<Relation, string> = {
  customer: "Customer",
  supplier: "Supplier",
  competitor: "Competitor",
  peer: "Peer",
};

export const CONFIDENCE: Record<Confidence, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

export const DIRECTION: Record<Direction, string> = {
  up: "Up",
  down: "Down",
  unclear: "Unclear",
};

export function directionColor(direction: Direction): string {
  return direction === "up" ? signal.up : direction === "down" ? signal.down : signal.unclear;
}

export function directionSoft(direction: Direction): string {
  return direction === "up" ? signal.upSoft : direction === "down" ? signal.downSoft : signal.unclearSoft;
}

/** "+3.2%" / "−1.4%" with a real minus sign. */
export function signedPct(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
}

/** "+42" / "−18" / "0". */
export function signedInt(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
}

export type Band = { word: string; color: string; soft: string };

/** Net direction bands for the Today ring. */
export function netBand(value: number | null): Band {
  if (value === null) return { word: "", color: signal.unclear, soft: signal.unclearSoft };
  if (value >= 25) return { word: "Mostly upside", color: signal.up, soft: signal.upSoft };
  if (value <= -25) return { word: "Mostly downside", color: signal.down, soft: signal.downSoft };
  return { word: "Mixed", color: signal.mixed, soft: signal.mixedSoft };
}
