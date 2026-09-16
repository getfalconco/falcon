import { FEATURE_ART } from "./FeatureArt";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const RAGE = "'Rage Italic', 'Segoe Script', 'Brush Script MT', cursive";
const INK = "rgb(29, 27, 27)";
const BODY = "#6b7280";
const NUMBER = "rgb(168, 100, 72)";
const DASH = "border-dashed border-black/[0.14]";
const INSET = "mx-auto max-w-7xl px-6 sm:px-10";
const POLKA_BG = "#f5f5f2";
const POLKA_IMG =
  "radial-gradient(rgba(0,0,0,var(--polka-alpha)) var(--polka-dot), transparent var(--polka-dot))";
const POLKA_SIZE = "var(--polka-gap) var(--polka-gap)";

const CELLS = [
  {
    title: "Falcon does the research",
    body: "Most tools give you a headline. Falcon traces where it travels next and shows you the connected stock before the market reacts.",
  },
  {
    title: "Every link, sourced",
    body: "Each connection is pulled from real company filings, not guesswork. You can see the exact sentence behind every claim.",
  },
  {
    title: "Only what touches you",
    body: "Follow the companies you care about. Falcon surfaces only the moves that reach your stocks, and stays quiet otherwise.",
  },
  {
    title: "Honest about timing",
    body: "Falcon tells you when a move is already priced in, not just when there's opportunity. No hype, no false urgency.",
  },
  {
    title: "The whole network",
    body: "See how one company connects to its suppliers, customers, and competitors — mapped as a living graph you can explore.",
  },
  {
    title: "It compounds",
    body: "The longer Falcon runs, the deeper its map and the stronger its track record. Every day makes it harder to replicate.",
  },
];

function HLine() {
  return <div className={`border-t ${DASH}`} aria-hidden />;
}

function NumberLabel({ n }: { n: number }) {
  return (
    <span
      style={{
        fontFamily: RAGE,
        fontWeight: 400,
        fontStyle: "italic",
        fontSize: "16px",
        color: NUMBER,
      }}
    >
      {String(n).padStart(2, "0")}
    </span>
  );
}

// Top-only "protrusion": numbers above the first line, with the vertical dashed
// lines running up through this strip. Desktop only — on a single mobile
// column this strip would render as three numbers with nothing beside them,
// detached from the cards they label, so each card carries its own number
// instead (below).
function NumberRow({ start }: { start: number }) {
  return (
    <div className={`${INSET} hidden sm:block`}>
      <div className={`grid grid-cols-1 border-l ${DASH} sm:grid-cols-3`}>
        {[0, 1, 2].map((j) => (
          <div key={j} className={`border-r ${DASH} px-6 pb-2 pt-3 sm:px-8`}>
            <NumberLabel n={start + j} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ContentRow({ cells, start }: { cells: typeof CELLS; start: number }) {
  return (
    <div className={INSET}>
      <div className={`grid grid-cols-1 border-l ${DASH} sm:grid-cols-3`}>
        {cells.map((cell, i) => (
          <div key={cell.title} className={`border-r ${DASH} pb-8`}>
            {/* Dotted ground with the cell's illustration sitting on it. */}
            <div
              aria-hidden
              className="flex w-full items-center justify-center px-6 py-4"
              style={{
                aspectRatio: "406 / 257",
                backgroundColor: POLKA_BG,
                backgroundImage: POLKA_IMG,
                backgroundSize: POLKA_SIZE,
              }}
            >
              {FEATURE_ART[start + i - 1]}
            </div>

            <div className="px-6 pt-6 sm:px-8">
              {/* Same number NumberRow shows above this column on desktop —
                  repeated inline here since that strip is hidden on mobile. */}
              <div className="mb-1.5 sm:hidden">
                <NumberLabel n={start + i} />
              </div>
              <h3
                style={{
                fontFamily: SERIF,
                fontWeight: 400,
                fontSize: "19px",
                lineHeight: 1.3,
                color: INK,
              }}
            >
              {cell.title}
            </h3>
            <p
              className="mt-2"
              style={{
                fontFamily: GEIST,
                fontWeight: 400,
                fontSize: "14.5px",
                lineHeight: 1.55,
                color: BODY,
              }}
            >
              {cell.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FeatureGrid() {
  return (
    <section className="pb-10 pt-4">
      <div className={INSET}>
        <h2
          className="max-w-xl"
          style={{
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: "36px",
            lineHeight: 1.15,
            color: INK,
          }}
        >
          You follow one. Falcon follows the chain.
        </h2>
      </div>

      <div className="mt-9">
        {/* Protrusion (lines sticking up into empty space) only at the very top. */}
        <NumberRow start={1} />
        <HLine />
        <ContentRow cells={CELLS.slice(0, 3)} start={1} />
        {/* Row-2 numbers sit above their line too, but with content above them
            so there is no empty protrusion. */}
        <NumberRow start={4} />
        <HLine />
        <ContentRow cells={CELLS.slice(3, 6)} start={4} />
        <HLine />
      </div>
    </section>
  );
}
