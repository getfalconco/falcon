import { existsSync } from "node:fs";
import { join } from "node:path";

const MONO = "var(--font-geist-mono), monospace";
const GEIST = "var(--font-geist-sans), sans-serif";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";

/**
 * Brokerages reachable through SnapTrade. Each entry renders its logo from
 * public/brokers/<slug>.svg (or .png) when that file exists; until then it
 * falls back to a typographic wordmark styled close to the brand, so the row
 * reads as logos either way.
 */
const BROKERS: {
  name: string;
  slug: string;
  style: React.CSSProperties;
  /** The file is a square mark, not a wordmark: show the name beside it. */
  iconOnly?: boolean;
}[] = [
  { name: "Robinhood", slug: "robinhood", style: { fontFamily: GEIST, fontWeight: 600, letterSpacing: "-0.01em" } , iconOnly: true },
  { name: "Fidelity", slug: "fidelity", style: { fontFamily: SERIF, fontWeight: 400, fontStyle: "italic" } },
  { name: "Charles Schwab", slug: "schwab", style: { fontFamily: GEIST, fontWeight: 700, letterSpacing: "-0.02em" }, iconOnly: true },
  { name: "E*TRADE", slug: "etrade", style: { fontFamily: GEIST, fontWeight: 600, letterSpacing: "0.02em" } },
  { name: "Interactive Brokers", slug: "ibkr", style: { fontFamily: GEIST, fontWeight: 500 } },
  { name: "Webull", slug: "webull", style: { fontFamily: GEIST, fontWeight: 700 } , iconOnly: true },
  { name: "Vanguard", slug: "vanguard", style: { fontFamily: SERIF, fontWeight: 400 } },
  { name: "Alpaca", slug: "alpaca", style: { fontFamily: MONO, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" } , iconOnly: true },
  { name: "Tradier", slug: "tradier", style: { fontFamily: GEIST, fontWeight: 500, letterSpacing: "0.02em" } , iconOnly: true },
  { name: "Questrade", slug: "questrade", style: { fontFamily: GEIST, fontWeight: 600 } },
  { name: "Wealthsimple", slug: "wealthsimple", style: { fontFamily: SERIF, fontWeight: 400 } },
  { name: "Trading 212", slug: "trading212", style: { fontFamily: GEIST, fontWeight: 600, letterSpacing: "-0.01em" } , iconOnly: true },
];

/** Resolved at render time on the server, so a missing file can never 404. */
function logoUrl(slug: string): string | null {
  for (const ext of ["svg", "png"]) {
    if (existsSync(join(process.cwd(), "public", "brokers", `${slug}.${ext}`))) {
      return `/brokers/${slug}.${ext}`;
    }
  }
  return null;
}

function Row({ ariaHidden = false }: { ariaHidden?: boolean }) {
  return (
    <ul
      aria-hidden={ariaHidden}
      className="flex shrink-0 items-center gap-4 pr-4"
    >
      {BROKERS.map((b) => {
        const logo = logoUrl(b.slug);
        return (
          <li key={b.slug} className="flex h-10 w-[176px] shrink-0 items-center justify-center">
            {logo && b.iconOnly ? (
              // Square marks get their name beside them, so they carry the
              // same weight in the row as the full wordmarks.
              <span className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logo}
                  alt=""
                  className="h-[22px] w-[22px] rounded-[5px] object-contain opacity-75 grayscale"
                />
                <span
                  className="whitespace-nowrap text-[17px] leading-none text-[#9a9a9a]"
                  style={b.style}
                >
                  {b.name}
                </span>
              </span>
            ) : logo ? (
              // Logos are shown desaturated and softened so every brand sits
              // in the same quiet grey as the rest of the page.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logo}
                alt={b.name}
                className="h-auto max-h-[22px] w-auto max-w-[136px] object-contain opacity-70 grayscale"
              />
            ) : (
              <span
                className="whitespace-nowrap text-[17px] leading-none text-[#9a9a9a]"
                style={b.style}
              >
                {b.name}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function BrokerMarquee() {
  return (
    <section className="flex flex-col items-center justify-center py-5">
      <p
        className="text-center text-[11px] uppercase tracking-[0.2em] text-[#8f8f8f]"
        style={{ fontFamily: MONO }}
      >
        Connects to
      </p>

      {/* Two copies of the row slide together; the second takes the first's
          place as it leaves, so the loop never shows a seam. Edges fade out. */}
      <div
        className="broker-marquee mt-6 w-full overflow-hidden"
        style={{
          WebkitMaskImage:
            "linear-gradient(to right, transparent, black 12%, black 88%, transparent)",
          maskImage:
            "linear-gradient(to right, transparent, black 12%, black 88%, transparent)",
        }}
      >
        <div className="broker-marquee-track flex w-max">
          <Row />
          <Row ariaHidden />
        </div>
      </div>
      <div aria-hidden className="h-[41px]" />
    </section>
  );
}
