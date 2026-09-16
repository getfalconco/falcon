/**
 * Small monochrome illustrations for the FeatureGrid cells, in the reference
 * style: white cards with hairline borders on the dotted ground, dark icon
 * chips, dark arrows, thin-line graphs. Pure markup, no client code.
 */

const MONO = "var(--font-geist-mono), monospace";
const GEIST = "var(--font-geist-sans), sans-serif";
const INK = "#1d1b1b";
const DARK = "rgba(29, 27, 27, 0.7)";
const CARD =
  "rounded-lg border border-black/[0.08] bg-[#fdfdfd]";

function Chip({ label }: { label: string }) {
  return (
    <span
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-[10px] text-white"
      style={{ backgroundColor: INK, fontFamily: MONO }}
    >
      {label}
    </span>
  );
}

function RowCard({ chip, text }: { chip: string; text: string }) {
  return (
    <div className={`flex items-center gap-2.5 px-2.5 py-[7px] ${CARD}`}>
      <Chip label={chip} />
      <span
        className="text-[11.5px] leading-[14px] text-[#3a3a38]"
        style={{ fontFamily: GEIST }}
      >
        {text}
      </span>
    </div>
  );
}

function DownArrow() {
  return (
    <svg
      width="10"
      height="14"
      viewBox="0 0 10 14"
      aria-hidden
      className="my-[3px] ml-[13px]"
    >
      <path
        d="M5 1v9M1.5 7.5 5 11l3.5-3.5"
        fill="none"
        stroke={DARK}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* 01 — headline in, graph walked, connected stock out. */
function ArtResearch() {
  return (
    <div className="flex w-full max-w-[236px] flex-col">
      <RowCard chip="N" text="Headline hits one company" />
      <DownArrow />
      <RowCard chip="G" text="Falcon walks its relationships" />
      <DownArrow />
      <RowCard chip="S" text="The connected stock surfaces" />
    </div>
  );
}

/* 02 — the sentence behind the claim, highlighted inside the filing. */
function ArtSourced() {
  return (
    <div className="flex w-full max-w-[220px] flex-col items-stretch">
      <div className={`px-3.5 py-3 ${CARD}`}>
        <div
          className="flex items-center justify-between text-[8.5px] tracking-[0.08em] text-[#9a9a9a]"
          style={{ fontFamily: MONO }}
        >
          <span>FORM 10-K</span>
          <span>P. 47</span>
        </div>
        <div className="mt-2.5 space-y-[6px]">
          <div className="h-[5px] w-full rounded bg-black/[0.08]" />
          <div className="h-[5px] w-[88%] rounded bg-black/[0.08]" />
          <div
            className="h-[5px] w-full rounded"
            style={{ backgroundColor: "rgba(29,27,27,0.26)" }}
          />
          <div
            className="h-[5px] w-[62%] rounded"
            style={{ backgroundColor: "rgba(29,27,27,0.26)" }}
          />
          <div className="h-[5px] w-[80%] rounded bg-black/[0.08]" />
        </div>
      </div>
      <svg
        width="10"
        height="12"
        viewBox="0 0 10 12"
        aria-hidden
        className="mx-auto my-[2px]"
      >
        <path
          d="M5 0v8M1.5 5.5 5 9l3.5-3.5"
          fill="none"
          stroke={DARK}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className={`flex items-center justify-center gap-2 px-3 py-[7px] ${CARD}`}>
        <span className="text-[10px] text-[#3a3a38]" style={{ fontFamily: MONO }}>
          TSM
        </span>
        <svg width="14" height="8" viewBox="0 0 14 8" aria-hidden>
          <path
            d="M0 4h11M8.5 1 12 4 8.5 7"
            fill="none"
            stroke={DARK}
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
        <span className="text-[10px] text-[#3a3a38]" style={{ fontFamily: MONO }}>
          AAPL
        </span>
      </div>
    </div>
  );
}

/* 03 — many moves out there; only the one that reaches you lights up. */
function ArtTouches() {
  return (
    <svg viewBox="0 0 220 150" className="w-full max-w-[230px]" aria-hidden>
      <line x1="42" y1="34" x2="103" y2="72" stroke="rgba(0,0,0,0.10)" strokeWidth="1.2" />
      <line x1="36" y1="112" x2="103" y2="78" stroke="rgba(0,0,0,0.10)" strokeWidth="1.2" />
      <line x1="112" y1="18" x2="111" y2="66" stroke="rgba(0,0,0,0.10)" strokeWidth="1.2" />
      <line x1="181" y1="40" x2="117" y2="72" stroke={DARK} strokeWidth="1.6" />
      <circle cx="42" cy="34" r="8" fill="#fdfdfd" stroke="rgba(0,0,0,0.14)" strokeWidth="1.2" />
      <circle cx="36" cy="112" r="8" fill="#fdfdfd" stroke="rgba(0,0,0,0.14)" strokeWidth="1.2" />
      <circle cx="112" cy="18" r="8" fill="#fdfdfd" stroke="rgba(0,0,0,0.14)" strokeWidth="1.2" />
      <circle cx="181" cy="40" r="9" fill="#fdfdfd" stroke={DARK} strokeWidth="1.5" />
      <rect x="86" y="62" width="52" height="24" rx="7" fill={INK} />
      <text x="112" y="78" textAnchor="middle" fill="#ffffff" fontSize="10" style={{ fontFamily: MONO }}>
        YOU
      </text>
      <text x="181" y="63" textAnchor="middle" fill={DARK} fontSize="8.5" style={{ fontFamily: MONO }}>
        SIGNAL
      </text>
      <text x="112" y="120" textAnchor="middle" fill="#9a9a9a" fontSize="8.5" style={{ fontFamily: MONO }}>
        THE REST STAYS QUIET
      </text>
    </svg>
  );
}

/* 04 — the move happened; Falcon says which side of it you are on. */
function ArtTiming() {
  return (
    <div className="flex w-full max-w-[220px] flex-col">
      <div className={`px-3.5 pb-3 pt-3.5 ${CARD}`}>
        <svg viewBox="0 0 180 56" className="w-full" aria-hidden>
          <path
            d="M2 46 C 30 44, 46 40, 62 36 S 92 26, 104 18"
            fill="none"
            stroke="rgba(0,0,0,0.28)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M104 18 C 122 8, 148 6, 176 8"
            fill="none"
            stroke="rgba(0,0,0,0.16)"
            strokeWidth="1.6"
            strokeDasharray="3 4"
            strokeLinecap="round"
          />
          <circle cx="104" cy="18" r="4" fill={DARK} />
          <text x="104" y="42" textAnchor="middle" fill="#9a9a9a" fontSize="8" style={{ fontFamily: MONO }}>
            NEWS
          </text>
        </svg>
      </div>
      <div className="mt-2.5 flex justify-center gap-2">
        <span
          className="rounded-full border px-2.5 py-[3px] text-[8.5px] tracking-[0.06em]"
          style={{ fontFamily: MONO, color: DARK, borderColor: "rgba(29,27,27,0.45)" }}
        >
          STILL EARLY
        </span>
        <span
          className="rounded-full border border-black/[0.12] px-2.5 py-[3px] text-[8.5px] tracking-[0.06em] text-[#9a9a9a]"
          style={{ fontFamily: MONO }}
        >
          PRICED IN
        </span>
      </div>
    </div>
  );
}

/* 05 — one company, its whole neighbourhood. */
function ArtNetwork() {
  return (
    <svg viewBox="0 0 220 150" className="w-full max-w-[230px]" aria-hidden>
      <line x1="110" y1="75" x2="46" y2="34" stroke="rgba(0,0,0,0.13)" strokeWidth="1.2" />
      <line x1="110" y1="75" x2="176" y2="32" stroke="rgba(0,0,0,0.13)" strokeWidth="1.2" />
      <line x1="110" y1="75" x2="188" y2="92" stroke="rgba(0,0,0,0.13)" strokeWidth="1.2" />
      <line x1="110" y1="75" x2="58" y2="116" stroke="rgba(0,0,0,0.13)" strokeWidth="1.2" />
      <line x1="46" y1="34" x2="176" y2="32" stroke="rgba(0,0,0,0.07)" strokeWidth="1" />
      <line x1="58" y1="116" x2="188" y2="92" stroke="rgba(0,0,0,0.07)" strokeWidth="1" />
      <circle cx="110" cy="75" r="13" fill={INK} />
      <circle cx="46" cy="34" r="9" fill="#fdfdfd" stroke="rgba(0,0,0,0.16)" strokeWidth="1.2" />
      <circle cx="176" cy="32" r="9" fill="#fdfdfd" stroke="rgba(0,0,0,0.16)" strokeWidth="1.2" />
      <circle cx="188" cy="92" r="9" fill="#fdfdfd" stroke="rgba(0,0,0,0.16)" strokeWidth="1.2" />
      <circle cx="58" cy="116" r="9" fill="#fdfdfd" stroke="rgba(0,0,0,0.16)" strokeWidth="1.2" />
      <text x="46" y="18" textAnchor="middle" fill="#9a9a9a" fontSize="8" style={{ fontFamily: MONO }}>
        SUPPLIER
      </text>
      <text x="176" y="16" textAnchor="middle" fill="#9a9a9a" fontSize="8" style={{ fontFamily: MONO }}>
        CUSTOMER
      </text>
      <text x="188" y="112" textAnchor="middle" fill="#9a9a9a" fontSize="8" style={{ fontFamily: MONO }}>
        RIVAL
      </text>
      <text x="58" y="136" textAnchor="middle" fill="#9a9a9a" fontSize="8" style={{ fontFamily: MONO }}>
        PARTNER
      </text>
    </svg>
  );
}

/* 06 — the map filling in, week over week. */
function ArtCompounds() {
  const cols = 9;
  const rows = 4;
  return (
    <div className="flex w-full max-w-[220px] flex-col">
      <div
        className="grid gap-[5px]"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {Array.from({ length: cols * rows }, (_, i) => {
          const col = i % cols;
          const strength = (col + 1) / cols;
          return (
            <div
              key={i}
              className="aspect-square rounded-[3px]"
              style={{
                backgroundColor: `rgba(29,27,27,${(0.06 + strength * 0.5).toFixed(2)})`,
              }}
            />
          );
        })}
      </div>
      <div
        className="mt-2 flex justify-between text-[8.5px] tracking-[0.08em] text-[#9a9a9a]"
        style={{ fontFamily: MONO }}
      >
        <span>WEEK 1</span>
        <span>WEEK 12</span>
      </div>
    </div>
  );
}

export const FEATURE_ART = [
  <ArtResearch key="research" />,
  <ArtSourced key="sourced" />,
  <ArtTouches key="touches" />,
  <ArtTiming key="timing" />,
  <ArtNetwork key="network" />,
  <ArtCompounds key="compounds" />,
];
