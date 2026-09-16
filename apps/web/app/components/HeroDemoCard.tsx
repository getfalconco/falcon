"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";
const INK = "rgb(29, 27, 27)";
const MUTED = "#9a938a";
const UP = "#158a52";
const DOWN = "#c0402c";

const ROTATE_MS = 7000;
const FADE_MS = 400;
const TYPE_MS = 42;
const TYPE_START_DELAY = 250;

const TEXT_STYLE: React.CSSProperties = {
  fontFamily: GEIST,
  fontWeight: 400,
  fontStyle: "normal",
  fontSize: "26px",
  lineHeight: 1.25,
};

type Segment =
  | { t: "chip"; ticker: string; dir: "up" | "down" }
  | { t: "text"; v: string }
  | { t: "ripple" };

const chip = (ticker: string, dir: "up" | "down"): Segment => ({
  t: "chip",
  ticker,
  dir,
});
const txt = (v: string): Segment => ({ t: "text", v });
const rip: Segment = { t: "ripple" };

const EXAMPLES: Segment[][] = [
  [
    chip("DE", "down"),
    txt(" weak farm equipment demand "),
    rip,
    chip("CAT", "down"),
    txt(" shared supplier softness "),
    rip,
    chip("CNH", "down"),
    txt(" ag exposure"),
  ],
  [
    chip("LLY", "up"),
    txt(" GLP-1 approval "),
    rip,
    chip("DXCM", "down"),
    txt(" diabetes device demand risk "),
    rip,
    chip("NVO", "down"),
    txt(" competitor pressure"),
  ],
  [
    chip("BA", "down"),
    txt(" production halt "),
    rip,
    chip("SPR", "down"),
    txt(" fuselage supplier "),
    rip,
    chip("GE", "down"),
    txt(" engine orders"),
  ],
  [
    chip("XOM", "up"),
    txt(" refining margins "),
    rip,
    chip("HAL", "up"),
    txt(" oilfield services demand "),
    rip,
    chip("CVX", "up"),
    txt(" peer read-through"),
  ],
  [
    chip("COST", "up"),
    txt(" membership growth "),
    rip,
    chip("V", "up"),
    txt(" payment volume "),
    rip,
    chip("SYF", "down"),
    txt(" competitive card pressure"),
  ],
];

function totalAtoms(ex: Segment[]) {
  return ex.reduce((n, s) => n + (s.t === "text" ? s.v.length : 1), 0);
}

function TickerChip({ ticker, dir }: { ticker: string; dir: "up" | "down" }) {
  const up = dir === "up";
  return (
    <span
      className="chip-pop mx-0.5 inline-flex items-center gap-1 rounded-md border border-black/[0.12] bg-[#fdfdfd] px-2 py-[3px] align-[0.09em] sm:px-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
      style={{ fontFamily: MONO, fontSize: "0.6em", lineHeight: 1 }}
    >
      <span style={{ color: INK, letterSpacing: "0.01em" }}>{ticker}</span>
      <span aria-hidden style={{ color: up ? UP : DOWN, fontSize: "1.05em" }}>
        {up ? "↑" : "↓"}
      </span>
    </span>
  );
}

function Ripple() {
  return (
    <span aria-hidden className="mx-1.5" style={{ color: INK }}>
      →
    </span>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block animate-pulse"
      style={{
        width: "2px",
        height: "1.05em",
        verticalAlign: "-0.15em",
        backgroundColor: INK,
      }}
    />
  );
}

// Reveal the first `reveal` atoms of an example (Infinity = whole thing).
function renderExample(ex: Segment[], reveal: number) {
  const nodes: React.ReactNode[] = [];
  let acc = 0;
  for (let i = 0; i < ex.length; i++) {
    const seg = ex[i];
    const len = seg.t === "text" ? seg.v.length : 1;
    const shown = Math.max(0, Math.min(reveal - acc, len));
    acc += len;
    if (shown <= 0) continue;
    if (seg.t === "text") {
      nodes.push(
        <span key={i} style={TEXT_STYLE}>
          {seg.v.slice(0, shown)}
        </span>,
      );
    } else if (seg.t === "ripple") {
      nodes.push(<Ripple key={i} />);
    } else {
      nodes.push(<TickerChip key={i} ticker={seg.ticker} dir={seg.dir} />);
    }
  }
  return nodes;
}

export default function HeroDemoCard() {
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);

  // Cross-fade rotation through the examples.
  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % EXAMPLES.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, []);

  // Typewriter for whichever example is currently active.
  useEffect(() => {
    setCount(0);
    const total = totalAtoms(EXAMPLES[index]);
    let n = 0;
    let intervalId = 0;
    const startId = window.setTimeout(() => {
      intervalId = window.setInterval(() => {
        n += 1;
        setCount(n);
        if (n >= total) window.clearInterval(intervalId);
      }, TYPE_MS);
    }, TYPE_START_DELAY);
    return () => {
      window.clearTimeout(startId);
      window.clearInterval(intervalId);
    };
  }, [index]);

  return (
    <div className="w-full max-w-[860px] rounded-2xl border border-black/[0.07] bg-[#fdfdfd] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)] sm:p-10">
      <p
        style={{
          fontFamily: MONO,
          fontSize: "11px",
          lineHeight: "15px",
          letterSpacing: "0.14em",
          color: MUTED,
        }}
      >
        SEE THE CHAIN
      </p>

      {/* Grid-stack: inactive examples render in full (invisible) so the card
          keeps the tallest example's height; the active one types in and
          cross-fades over the previous. */}
      <div className="mt-3 grid sm:mt-5">
        {EXAMPLES.map((example, i) => {
          const active = i === index;
          const total = totalAtoms(example);
          const reveal = active ? count : Number.POSITIVE_INFINITY;
          return (
            <p
              key={i}
              aria-hidden={!active}
              style={{
                gridArea: "1 / 1",
                margin: 0,
                fontFamily: SERIF,
                fontWeight: 400,
                fontSize: "clamp(15px, 2.9vw + 4px, 27px)",
                lineHeight: 1.3,
                color: INK,
                opacity: active ? 1 : 0,
                transition: `opacity ${FADE_MS}ms ease`,
              }}
            >
              {renderExample(example, reveal)}
              {active && count < total ? <Caret /> : null}
            </p>
          );
        })}
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:mt-8 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <span
          style={{
            fontFamily: MONO,
            fontSize: "clamp(10px, 2.8vw, 12px)",
            lineHeight: "17px",
            letterSpacing: "0.04em",
            color: MUTED,
            textTransform: "uppercase",
          }}
        >
          Sourced from company filings, not guesswork.
        </span>

        <Link
          href="#"
          className="inline-flex w-fit items-center gap-2 rounded-lg bg-[#1c1917] px-3.5 py-2 sm:px-4 sm:py-2.5 transition-colors hover:bg-[#0f0d0b]"
          style={{
            fontFamily: GEIST,
            fontSize: "clamp(12px, 3vw, 13px)",
            lineHeight: "20px",
            color: "rgb(231, 231, 231)",
          }}
        >
          See the ripple
          <span aria-hidden>→</span>
        </Link>
      </div>
    </div>
  );
}
