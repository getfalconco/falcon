import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import EarningsLogo from "@/components/earnings/EarningsLogo";

/**
 * A country's flag as a small round mark, for the calendar's rows: drawn here
 * as inline SVG, so nothing is fetched and a flag never fails to load. Each is
 * simplified to read at 14 to 16 pixels across (no stars counted, no coats of
 * arms); the circle crops it the way round flag sets do.
 *
 * Every country a reader can pick as their region (shared/economic-calendar.ts
 * REGION_CHOICES) and the euro area have one; any other code draws a neutral
 * disc with nothing on it.
 */

const W = "#FFFFFF";
const K = "#1D1B1B";

/** Horizontal bands, top to bottom, in equal shares unless weights are given. */
function bands(colors: string[], weights?: number[]): ReactNode {
  const w = weights ?? colors.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  let y = 0;
  return colors.map((c, i) => {
    const h = (24 * w[i]!) / total;
    const rect = <rect key={i} x="0" y={y} width="24" height={h + 0.05} fill={c} />;
    y += h;
    return rect;
  });
}

/** Vertical bands, left to right. */
function columns(colors: string[], weights?: number[]): ReactNode {
  const w = weights ?? colors.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  let x = 0;
  return colors.map((c, i) => {
    const width = (24 * w[i]!) / total;
    const rect = <rect key={i} x={x} y="0" width={width + 0.05} height="24" fill={c} />;
    x += width;
    return rect;
  });
}

/** A Nordic cross, offset towards the hoist. */
function nordic(field: string, cross: string, inner?: string): ReactNode {
  return (
    <>
      <rect width="24" height="24" fill={field} />
      <rect x="6" y="0" width="5" height="24" fill={cross} />
      <rect x="0" y="9.5" width="24" height="5" fill={cross} />
      {inner ? (
        <>
          <rect x="7.4" y="0" width="2.2" height="24" fill={inner} />
          <rect x="0" y="10.9" width="24" height="2.2" fill={inner} />
        </>
      ) : null}
    </>
  );
}

/** A five-pointed star centred on (cx, cy) with outer radius r. */
function star(cx: number, cy: number, r: number, fill: string, key?: string | number): ReactNode {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return <polygon key={key} points={pts.join(" ")} fill={fill} />;
}

/** The Union Jack, in a box from (0,0) to (w,h). */
function unionJack(w: number, h: number): ReactNode {
  return (
    <>
      <rect width={w} height={h} fill="#012169" />
      <path d={`M0 0 L${w} ${h} M${w} 0 L0 ${h}`} stroke={W} strokeWidth={h * 0.2} />
      <path d={`M0 0 L${w} ${h} M${w} 0 L0 ${h}`} stroke="#C8102E" strokeWidth={h * 0.08} />
      <path d={`M${w / 2} 0 V${h} M0 ${h / 2} H${w}`} stroke={W} strokeWidth={h * 0.32} />
      <path d={`M${w / 2} 0 V${h} M0 ${h / 2} H${w}`} stroke="#C8102E" strokeWidth={h * 0.18} />
    </>
  );
}

const FLAGS: Readonly<Record<string, ReactNode>> = {
  US: (
    <>
      {bands(Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? "#B22234" : W)))}
      <rect width="12" height="13" fill="#3C3B6E" />
      {[2.5, 6, 9.5].flatMap((x) => [2.5, 6.5, 10.5].map((y) => <circle key={`${x}-${y}`} cx={x + 0.5} cy={y} r="0.8" fill={W} />))}
    </>
  ),
  EU: (
    <>
      <rect width="24" height="24" fill="#003399" />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6;
        return star(12 + 6.6 * Math.cos(a), 12 + 6.6 * Math.sin(a), 1.35, "#FFCC00", i);
      })}
    </>
  ),
  GB: unionJack(24, 24),
  DE: bands([K, "#DD0000", "#FFCE00"]),
  FR: columns(["#0055A4", W, "#EF4135"]),
  IT: columns(["#009246", W, "#CE2B37"]),
  ES: bands(["#AA151B", "#F1BF00", "#AA151B"], [1, 2, 1]),
  NL: bands(["#AE1C28", W, "#21468B"]),
  BE: columns([K, "#FDDA24", "#EF3340"]),
  AT: bands(["#ED2939", W, "#ED2939"]),
  CH: (
    <>
      <rect width="24" height="24" fill="#DA291C" />
      <rect x="10" y="5" width="4" height="14" fill={W} />
      <rect x="5" y="10" width="14" height="4" fill={W} />
    </>
  ),
  SE: nordic("#006AA7", "#FECC00"),
  NO: nordic("#BA0C2F", W, "#00205B"),
  DK: nordic("#C8102E", W),
  FI: nordic(W, "#002F6C"),
  PL: bands([W, "#DC143C"]),
  PT: (
    <>
      {columns(["#006600", "#FF0000"], [2, 3])}
      <circle cx="9.6" cy="12" r="3.6" fill="#FFCC00" />
      <circle cx="9.6" cy="12" r="2.2" fill="#FF0000" />
    </>
  ),
  IE: columns(["#169B62", W, "#FF883E"]),
  GR: (
    <>
      {bands(Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? "#0D5EAF" : W)))}
      <rect width="13.3" height="13.3" fill="#0D5EAF" />
      <rect x="5.3" y="0" width="2.7" height="13.3" fill={W} />
      <rect x="0" y="5.3" width="13.3" height="2.7" fill={W} />
    </>
  ),
  CZ: (
    <>
      {bands([W, "#D7141A"])}
      <path d="M0 0 L12 12 L0 24 Z" fill="#11457E" />
    </>
  ),
  HU: bands(["#CE2939", W, "#477050"]),
  TR: (
    <>
      <rect width="24" height="24" fill="#E30A17" />
      <circle cx="10" cy="12" r="6" fill={W} />
      <circle cx="11.5" cy="12" r="4.8" fill="#E30A17" />
      {star(16.4, 12, 2.6, W)}
    </>
  ),
  RU: bands([W, "#0039A6", "#D52B1E"]),
  JP: (
    <>
      <rect width="24" height="24" fill={W} />
      <circle cx="12" cy="12" r="5.6" fill="#BC002D" />
    </>
  ),
  CN: (
    <>
      <rect width="24" height="24" fill="#EE1C25" />
      {star(7.5, 8, 3.6, "#FFFF00")}
      {star(12.5, 4.2, 1.1, "#FFFF00", 1)}
      {star(14.6, 6.6, 1.1, "#FFFF00", 2)}
      {star(14.6, 9.8, 1.1, "#FFFF00", 3)}
      {star(12.5, 12.2, 1.1, "#FFFF00", 4)}
    </>
  ),
  HK: (
    <>
      <rect width="24" height="24" fill="#DE2910" />
      {Array.from({ length: 5 }, (_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        return <ellipse key={i} cx={12 + 3.3 * Math.cos(a)} cy={12 + 3.3 * Math.sin(a)} rx="1.9" ry="3.4" transform={`rotate(${(i * 72).toFixed(0)} ${12 + 3.3 * Math.cos(a)} ${12 + 3.3 * Math.sin(a)})`} fill={W} />;
      })}
    </>
  ),
  KR: (
    <>
      <rect width="24" height="24" fill={W} />
      <path d="M6.5 12 A5.5 5.5 0 0 1 17.5 12 Z" fill="#CD2E3A" />
      <path d="M6.5 12 A5.5 5.5 0 0 0 17.5 12 Z" fill="#0047A0" />
      <circle cx="9.25" cy="12" r="2.75" fill="#CD2E3A" />
      <circle cx="14.75" cy="12" r="2.75" fill="#0047A0" />
      <g fill={K}>
        <rect x="2.6" y="5" width="3.6" height="0.8" transform="rotate(-35 4.4 5.4)" />
        <rect x="17.8" y="5" width="3.6" height="0.8" transform="rotate(35 19.6 5.4)" />
        <rect x="2.6" y="18.2" width="3.6" height="0.8" transform="rotate(35 4.4 18.6)" />
        <rect x="17.8" y="18.2" width="3.6" height="0.8" transform="rotate(-35 19.6 18.6)" />
      </g>
    </>
  ),
  TW: (
    <>
      <rect width="24" height="24" fill="#FE0000" />
      <rect width="13" height="12" fill="#000095" />
      <circle cx="6.5" cy="6" r="3" fill={W} />
    </>
  ),
  IN: (
    <>
      {bands(["#FF9933", W, "#138808"])}
      <circle cx="12" cy="12" r="2.8" fill="none" stroke="#000080" strokeWidth="0.8" />
      <circle cx="12" cy="12" r="0.7" fill="#000080" />
    </>
  ),
  ID: bands(["#FF0000", W]),
  SG: (
    <>
      {bands(["#EF3340", W])}
      <circle cx="7" cy="6" r="3.6" fill={W} />
      <circle cx="8.4" cy="6" r="3.3" fill="#EF3340" />
      {[0, 1, 2, 3, 4].map((i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        return <circle key={i} cx={11 + 1.8 * Math.cos(a)} cy={6 + 1.8 * Math.sin(a)} r="0.55" fill={W} />;
      })}
    </>
  ),
  AU: (
    <>
      <rect width="24" height="24" fill="#012169" />
      <svg x="0" y="0" width="12" height="12" viewBox="0 0 12 12">
        {unionJack(12, 12)}
      </svg>
      {star(6, 18, 2.3, W)}
      {star(18, 6.5, 1.1, W, 1)}
      {star(15, 12, 1.1, W, 2)}
      {star(18.5, 19.5, 1.1, W, 3)}
      {star(21, 11, 1.1, W, 4)}
    </>
  ),
  NZ: (
    <>
      <rect width="24" height="24" fill="#012169" />
      <svg x="0" y="0" width="12" height="12" viewBox="0 0 12 12">
        {unionJack(12, 12)}
      </svg>
      {star(18, 6.5, 1.4, "#C8102E", 1)}
      {star(15, 12, 1.4, "#C8102E", 2)}
      {star(18.5, 19.5, 1.4, "#C8102E", 3)}
      {star(21, 11.5, 1.2, "#C8102E", 4)}
    </>
  ),
  CA: (
    <>
      {columns(["#D80621", W, "#D80621"], [1, 2, 1])}
      <path d="M12 6 L13.2 8.6 L15.4 8 L14.6 11.6 L16.4 10.8 L16 12.8 L13 15 L13.3 17.2 L12.4 17 L12 19 L11.6 17 L10.7 17.2 L11 15 L8 12.8 L7.6 10.8 L9.4 11.6 L8.6 8 L10.8 8.6 Z" fill="#D80621" />
    </>
  ),
  MX: (
    <>
      {columns(["#006847", W, "#CE1126"])}
      <circle cx="12" cy="12" r="2.4" fill="#8C5A2B" />
      <path d="M9.8 13.6 Q12 15.4 14.2 13.6" stroke="#006847" strokeWidth="0.8" fill="none" />
    </>
  ),
  BR: (
    <>
      <rect width="24" height="24" fill="#009C3B" />
      <path d="M12 3.5 L22 12 L12 20.5 L2 12 Z" fill="#FFDF00" />
      <circle cx="12" cy="12" r="4.6" fill="#002776" />
      <path d="M7.6 11 Q12 9.6 16.4 12.6" stroke={W} strokeWidth="0.8" fill="none" />
    </>
  ),
  ZA: (
    <>
      {bands(["#E03C31", "#001489"])}
      <path d="M0 0 L10 12 L0 24 Z" fill="#FFB81C" />
      <path d="M0 2.6 L8 12 L0 21.4 Z" fill={K} />
      <path d="M0 0 H4 L13 9 H24 V15 H13 L4 24 H0 Z" fill={W} />
      <path d="M0 1.5 H2.6 L11.8 10.4 H24 V13.6 H11.8 L2.6 22.5 H0 L9.4 12 Z" fill="#007749" />
      <path d="M0 3.6 L7.4 12 L0 20.4 Z" fill={K} />
    </>
  ),
  SA: (
    <>
      <rect width="24" height="24" fill="#006C35" />
      <rect x="6" y="8" width="12" height="2.6" rx="1" fill={W} opacity="0.9" />
      <path d="M6.5 15 H17 L18.2 14.2" stroke={W} strokeWidth="1" fill="none" />
    </>
  ),
  AE: (
    <>
      {bands(["#00732F", W, K])}
      <rect width="7" height="24" fill="#FF0000" />
    </>
  ),
  IL: (
    <>
      <rect width="24" height="24" fill={W} />
      <rect y="3.5" width="24" height="2.8" fill="#0038B8" />
      <rect y="17.7" width="24" height="2.8" fill="#0038B8" />
      <path d="M12 7.8 L15.6 14 H8.4 Z M12 16.2 L8.4 10 H15.6 Z" fill="none" stroke="#0038B8" strokeWidth="0.9" strokeLinejoin="round" />
    </>
  ),
};

/** The codes a flag is drawn for. */
export const FLAG_CODES: ReadonlySet<string> = new Set(Object.keys(FLAGS));

export function hasFlag(code: string | null | undefined): boolean {
  return Boolean(code && FLAG_CODES.has(code));
}

/**
 * The round flag. `label` is the country's name, for the hover title and
 * screen readers; left out, the mark is decoration beside a title that
 * already says enough.
 */
export function Flag({ code, size = 14, label, className }: { code: string; size?: number; label?: string; className?: string }) {
  const art = FLAGS[code];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      className={cn("relative inline-flex shrink-0 overflow-hidden rounded-full ring-1 ring-black/[0.08]", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} preserveAspectRatio="xMidYMid slice" aria-hidden>
        {art ?? <rect width="24" height="24" fill="#D1D5DB" />}
      </svg>
    </span>
  );
}

/**
 * What sits to the right of a row's dot: the company's logo for a company's
 * date, the country's flag for a release, nothing for the reader's own.
 */
export function RowMark({ ticker, country, size = 14, label }: { ticker?: string | null; country?: string | null; size?: number; label?: string }) {
  if (ticker) return <EarningsLogo ticker={ticker} size={size} />;
  if (country) return <Flag code={country} size={size} label={label} />;
  return null;
}

