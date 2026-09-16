import { existsSync } from "node:fs";
import { join } from "node:path";

const GEIST = "var(--font-geist-sans), sans-serif";

/** Anthropic's Claude orange. */
const CLAUDE_ORANGE = "#d97757";

/**
 * Drop the official mark from Anthropic's brand kit at
 * public/brand/claude-mark.svg (or .png) and it is used verbatim; until then
 * the inline asterisk below stands in. Same resolve-at-render trick as
 * BrokerMarquee, so a missing file can never 404.
 */
function officialMarkUrl(): string | null {
  for (const ext of ["svg", "png"]) {
    if (existsSync(join(process.cwd(), "public", "brand", `claude-mark.${ext}`))) {
      return `/brand/claude-mark.${ext}`;
    }
  }
  return null;
}

/** Eleven tapered spokes radiating from the centre — the Claude asterisk. */
const SPOKE_LENGTHS = [9.4, 7.8, 9.0, 8.2, 9.4, 7.6, 9.2, 8.0, 9.4, 7.8, 8.8];

function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={className}
      fill={CLAUDE_ORANGE}
    >
      <g transform="translate(12 12)">
        {SPOKE_LENGTHS.map((len, i) => (
          <rect
            key={i}
            x={-1.05}
            y={-len}
            width={2.1}
            height={len - 0.9}
            rx={1.05}
            transform={`rotate(${(i * 360) / SPOKE_LENGTHS.length})`}
          />
        ))}
      </g>
    </svg>
  );
}

/**
 * Programme membership, stated as the fact it is: Anthropic runs the Claude
 * for Startups programme and Falcon is in it. Deliberately not "backed by" —
 * the programme is credits and access, not investment. Plain text, not a
 * link: it sits directly under the fixed header, where a click target would
 * compete with the nav.
 */
export default function ClaudeStartupsBadge({
  className = "",
}: {
  /** Padding that clears the fixed header on whichever page hosts it. */
  className?: string;
}) {
  const official = officialMarkUrl();
  return (
    <div className={`flex justify-center px-6 ${className}`}>
      <p
        className="max-w-full rounded-full border border-[#dcdcd6] bg-[#f2f2ef] px-4 py-2 text-center text-[13px] leading-[18px] text-[#1d1b1b]"
        style={{ fontFamily: GEIST }}
      >
        {/* The mark sits in the text flow rather than beside it, so a narrow
            screen wraps the line without stranding the icon on its own row. */}
        {official ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={official}
            alt=""
            className="mr-2 inline-block h-[13px] w-[13px] align-[-2px] object-contain"
          />
        ) : (
          <ClaudeMark className="mr-2 inline-block h-[13px] w-[13px] align-[-2px]" />
        )}
        Member of the Claude for Startups program
      </p>
    </div>
  );
}
