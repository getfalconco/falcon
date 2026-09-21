import { currencyOr, type Currency, type FlagSpec } from "@/lib/currencies";

/**
 * A currency's flag at row-icon size, cropped to the same circle every other
 * icon in the holdings list uses.
 *
 * Drawn from the spec in `lib/currencies` rather than shipped as images or
 * emoji: Windows has no glyphs for regional-indicator pairs, so the emoji route
 * renders as bare letters on the one platform this app runs on.
 *
 * A currency whose flag has no spec falls back to its code on a neutral badge.
 * That is a deliberate floor, not an oversight — a maple leaf or a coat of arms
 * redrawn at twenty pixels reads as a smudge, and a smudge that claims to be a
 * flag is worse than three honest letters.
 */

const SIZE = 20;

/** Bands, equal unless weights say otherwise. */
function Bands({ dir, colors, weights }: { dir: "h" | "v"; colors: string[]; weights?: number[] }) {
  const w = weights ?? colors.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  let offset = 0;
  return (
    <>
      {colors.map((color, i) => {
        const span = (w[i] / total) * SIZE;
        const at = offset;
        offset += span;
        return dir === "h" ? (
          <rect key={i} y={at} width={SIZE} height={span} fill={color} />
        ) : (
          <rect key={i} x={at} width={span} height={SIZE} fill={color} />
        );
      })}
    </>
  );
}

/** The Nordic cross: vertical bar set left of centre, horizontal bar centred. */
function Nordic({ field, cross }: { field: string; cross: string }) {
  const bar = 4;
  const x = 6.5;
  return (
    <>
      <rect width={SIZE} height={SIZE} fill={field} />
      <rect x={x - bar / 2} width={bar} height={SIZE} fill={cross} />
      <rect y={SIZE / 2 - bar / 2} width={SIZE} height={bar} fill={cross} />
    </>
  );
}

function FlagShape({ spec }: { spec: FlagSpec }) {
  switch (spec.kind) {
    case "bands":
      return <Bands dir={spec.dir} colors={spec.colors} weights={"weights" in spec ? spec.weights : undefined} />;
    case "nordic":
      return <Nordic field={spec.field} cross={spec.cross} />;
    case "disc":
      return (
        <>
          <rect width={SIZE} height={SIZE} fill={spec.field} />
          <circle cx={SIZE / 2} cy={SIZE / 2} r={spec.r} fill={spec.disc} />
        </>
      );
    case "swiss": {
      const arm = 3.2;
      const len = 10;
      return (
        <>
          <rect width={SIZE} height={SIZE} fill={spec.field} />
          <rect x={SIZE / 2 - arm / 2} y={SIZE / 2 - len / 2} width={arm} height={len} fill={spec.cross} />
          <rect x={SIZE / 2 - len / 2} y={SIZE / 2 - arm / 2} width={len} height={arm} fill={spec.cross} />
        </>
      );
    }
    case "custom":
      return <Custom id={spec.id} />;
  }
}

/** A five-pointed star, point up, centred on (cx, cy). */
function star(cx: number, cy: number, r: number, rotate = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const outer = ((i * 72 - 90 + rotate) * Math.PI) / 180;
    const inner = (((i + 0.5) * 72 - 90 + rotate) * Math.PI) / 180;
    pts.push(`${cx + r * Math.cos(outer)},${cy + r * Math.sin(outer)}`);
    pts.push(`${cx + r * 0.382 * Math.cos(inner)},${cy + r * 0.382 * Math.sin(inner)}`);
  }
  return pts.join(" ");
}

function Custom({ id }: { id: "us" | "uk" | "tr" | "cn" | "eu" }) {
  if (id === "us") {
    const stripe = SIZE / 13;
    return (
      <>
        <rect width={SIZE} height={SIZE} fill="#FFFFFF" />
        {Array.from({ length: 7 }, (_, i) => (
          <rect key={i} y={i * 2 * stripe} width={SIZE} height={stripe} fill="#B22234" />
        ))}
        <rect width={8} height={stripe * 7} fill="#3C3B6E" />
      </>
    );
  }

  if (id === "uk") {
    // The Union Flag is entirely geometric, so it survives this size: white
    // saltire under a red one, then the white-fimbriated red cross of St George.
    return (
      <>
        <rect width={SIZE} height={SIZE} fill="#012169" />
        <path d="M0,0 L20,20 M20,0 L0,20" stroke="#FFFFFF" strokeWidth={4} />
        <path d="M0,0 L20,20 M20,0 L0,20" stroke="#C8102E" strokeWidth={2} />
        <path d="M10,0 V20 M0,10 H20" stroke="#FFFFFF" strokeWidth={6.4} />
        <path d="M10,0 V20 M0,10 H20" stroke="#C8102E" strokeWidth={3.6} />
      </>
    );
  }

  if (id === "tr") {
    // Crescent as one disc minus a smaller offset disc, then the star.
    return (
      <>
        <rect width={SIZE} height={SIZE} fill="#E30A17" />
        <mask id="tr-crescent">
          <rect width={SIZE} height={SIZE} fill="black" />
          <circle cx={8.6} cy={10} r={4.4} fill="white" />
          <circle cx={10.2} cy={10} r={3.5} fill="black" />
        </mask>
        <rect width={SIZE} height={SIZE} fill="#FFFFFF" mask="url(#tr-crescent)" />
        <polygon points={star(14.4, 10, 2.2)} fill="#FFFFFF" />
      </>
    );
  }

  if (id === "cn") {
    return (
      <>
        <rect width={SIZE} height={SIZE} fill="#EE1C25" />
        <polygon points={star(5.2, 5.6, 3)} fill="#FFDE00" />
        <polygon points={star(10.4, 2.6, 1.1)} fill="#FFDE00" />
        <polygon points={star(12.4, 5, 1.1)} fill="#FFDE00" />
        <polygon points={star(12.4, 8.2, 1.1)} fill="#FFDE00" />
        <polygon points={star(10.4, 10.4, 1.1)} fill="#FFDE00" />
      </>
    );
  }

  // EUR: twelve stars on a circle. Not a country's flag, but the currency's.
  return (
    <>
      <rect width={SIZE} height={SIZE} fill="#003399" />
      {Array.from({ length: 12 }, (_, i) => {
        const a = ((i * 30 - 90) * Math.PI) / 180;
        return (
          <polygon
            key={i}
            points={star(10 + 6 * Math.cos(a), 10 + 6 * Math.sin(a), 1.15)}
            fill="#FFCC00"
          />
        );
      })}
    </>
  );
}

export default function CurrencyFlag({
  code,
  className,
}: {
  code?: string | null;
  className?: string;
}) {
  const c: Currency = currencyOr(code);
  const label = `${c.name} (${c.code})`;

  if (!c.flag) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={
          className ??
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1d1b1b]/[0.06] text-[7.5px] font-semibold tracking-tight text-[#6b7280]"
        }
      >
        {c.code}
      </span>
    );
  }

  // The clip id has to be unique per currency, or two flags on one screen share
  // the first one's circle and the second renders unclipped.
  const clip = `flag-clip-${c.code}`;
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={className ?? "h-5 w-5 shrink-0"}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clip}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <FlagShape spec={c.flag} />
      </g>
    </svg>
  );
}
