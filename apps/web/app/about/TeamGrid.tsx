"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";
const MONO = "var(--font-geist-mono), monospace";
const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const POLKA =
  "radial-gradient(rgba(0,0,0,var(--polka-alpha)) var(--polka-dot), transparent var(--polka-dot))";

export type TeamAssistant = {
  name: string;
  role: string;
  linkedin: string;
  photo: string | null;
  crop?: string;
  photoScale?: number;
  placeholder?: boolean;
  /** Open role — shown instead of a portrait when the seat is unfilled. */
  hiring?: boolean;
};

export type TeamMember = {
  name: string;
  role: string;
  linkedin: string;
  photo: string | null;
  crop?: string;
  /** Scale down inside the square frame so tall portraits fit (0–1). */
  photoScale?: number;
  placeholder?: boolean;
  assistant?: TeamAssistant;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
}

function EmptyCell({ className = "aspect-square" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-2xl bg-[#f5f5f2] ${className}`}
      style={{ backgroundImage: POLKA, backgroundSize: "var(--polka-gap) var(--polka-gap)" }}
    />
  );
}

/** Left-pointing pixel arrow in the same family as GetStartedButton. */
function PixelArrowLeft({ className }: { className?: string }) {
  const COLS = 9;
  const ROWS = 9;
  const CELL = 4;
  const DOT = 3;
  const RX = 0.75;
  const W = (COLS - 1) * CELL + DOT;
  const H = (ROWS - 1) * CELL + DOT;
  const arrow = [
    ".........",
    ".........",
    "....#....",
    "...#.....",
    "..######.",
    "...#.....",
    "....#....",
    ".........",
    ".........",
  ];

  const rects: React.ReactNode[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (arrow[y][x] !== "#") continue;
      rects.push(
        <rect
          key={`${x}-${y}`}
          x={x * CELL}
          y={y * CELL}
          width={DOT}
          height={DOT}
          rx={RX}
          fill="currentColor"
        />,
      );
    }
  }

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className={className}>
      <g>{rects}</g>
    </svg>
  );
}

function Portrait({
  name,
  role,
  linkedin,
  photo,
  crop,
  photoScale,
  placeholder,
  hiring,
  revealAssistant,
  assistantOpen,
  arrowSide,
}: {
  name: string;
  role: string;
  linkedin: string;
  photo: string | null;
  crop?: string;
  photoScale?: number;
  placeholder?: boolean;
  hiring?: boolean;
  revealAssistant?: () => void;
  assistantOpen?: boolean;
  arrowSide?: "left" | "right";
}) {
  const arrowPointsRight = arrowSide === "right";

  return (
    <div>
      <div
        className="relative flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-[#f5f5f2]"
        style={{ backgroundImage: POLKA, backgroundSize: "var(--polka-gap) var(--polka-gap)" }}
      >
        {hiring ? (
          <span
            className="px-4 text-center uppercase text-[#9a9a9a]"
            style={{
              fontFamily: MONO,
              fontSize: "11px",
              lineHeight: "15px",
              letterSpacing: "0.12em",
            }}
          >
            Now Hiring
          </span>
        ) : photo && placeholder ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" className="h-full w-full object-cover" />
        ) : photo ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo}
              alt={name}
              className="h-full w-full object-cover"
              style={{
                filter: "sepia(0.22) saturate(0.86) contrast(1.05) brightness(1.02)",
                objectPosition: crop ?? "50% 50%",
                ...(photoScale ? { transform: `scale(${photoScale})` } : {}),
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-[0.5] mix-blend-overlay"
              style={{ backgroundImage: GRAIN, backgroundSize: "140px 140px" }}
            />
          </>
        ) : (
          <span
            aria-hidden
            className="text-[34px] text-[#b4b2ac]"
            style={{ fontFamily: HEADING_FONT, fontWeight: 400 }}
          >
            {initials(name)}
          </span>
        )}

        {revealAssistant ? (
          <button
            type="button"
            onClick={revealAssistant}
            aria-expanded={assistantOpen}
            aria-label={assistantOpen ? "Hide executive assistant" : "Show executive assistant"}
            className={`absolute bottom-3 flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.08] bg-white/90 text-[#1d1b1b] shadow-sm backdrop-blur-sm transition-colors hover:bg-white ${
              arrowPointsRight ? "right-3" : "left-3"
            }`}
          >
            <PixelArrowLeft
              className={`transition-transform duration-300 ${
                arrowPointsRight
                  ? `-scale-x-100 ${assistantOpen ? "rotate-180" : ""}`
                  : assistantOpen
                    ? "rotate-180"
                    : ""
              }`}
            />
          </button>
        ) : null}
      </div>

      <div
        className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
        style={{
          fontFamily: MONO,
          fontSize: "11px",
          lineHeight: "15px",
          letterSpacing: "0.04em",
        }}
      >
        <span className="text-[#6b7280]">
          {name ? (
            <>
              {name} <span>- {role}</span>
            </>
          ) : (
            role
          )}
        </span>
        {linkedin ? (
          <a
            href={linkedin}
            className="shrink-0 text-[#6b7280] underline decoration-black/25 underline-offset-4 transition-colors hover:text-[#1d1b1b] hover:decoration-black/60"
          >
            LinkedIn
          </a>
        ) : null}
      </div>
    </div>
  );
}

function AssistantSlot({
  open,
  assistant,
}: {
  open: boolean;
  assistant?: TeamAssistant;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {open && assistant ? (
        <motion.div
          key="assistant"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.32, ease: EASE_SOFT }}
        >
          <Portrait {...assistant} />
        </motion.div>
      ) : (
        <motion.div
          key="empty"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: EASE_SOFT }}
        >
          <EmptyCell />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Zigzag grid: each member sits beside a companion slot for their assistant. */
const GRID = [
  { kind: "companion" as const, memberIndex: 0 },
  { kind: "member" as const, memberIndex: 0, arrowSide: "left" as const },
  { kind: "member" as const, memberIndex: 1, arrowSide: "right" as const },
  { kind: "companion" as const, memberIndex: 1 },
  { kind: "companion" as const, memberIndex: 2 },
  { kind: "member" as const, memberIndex: 2, arrowSide: "left" as const },
  { kind: "member" as const, memberIndex: 3, arrowSide: "right" as const },
  { kind: "companion" as const, memberIndex: 3 },
];

export default function TeamGrid({ members }: { members: TeamMember[] }) {
  const [openAssistantIndex, setOpenAssistantIndex] = useState<number | null>(null);

  const toggleAssistant = (index: number) => {
    setOpenAssistantIndex((current) => (current === index ? null : index));
  };

  return (
    <div className="grid max-w-[490px] grid-cols-2 items-start gap-3 lg:pt-2">
      {GRID.map((slot) => {
        const member = members[slot.memberIndex];
        if (!member) return null;

        if (slot.kind === "companion") {
          return (
            <AssistantSlot
              key={`companion-${slot.memberIndex}`}
              open={openAssistantIndex === slot.memberIndex}
              assistant={member.assistant}
            />
          );
        }

        const showArrow = Boolean(member.assistant);

        return (
          <Portrait
            key={`member-${slot.memberIndex}`}
            {...member}
            arrowSide={slot.arrowSide}
            revealAssistant={showArrow ? () => toggleAssistant(slot.memberIndex) : undefined}
            assistantOpen={openAssistantIndex === slot.memberIndex}
          />
        );
      })}
    </div>
  );
}
