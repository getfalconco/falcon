import { useEffect, useMemo, useState } from "react";
import useMeasure from "react-use-measure";
import type { PropagationRun, PropagationTarget } from "../../../shared/propagation-run-types";
import { GROUP_LABEL, layoutRipple } from "./ripple-layout";
import { ACCENT, AMBER, AMBER_LINE, AMBER_SOFT, FAINT, HAIRLINE, INK, MUTED, directionColor, pricingWord, tierStroke } from "./ripple-format";

/**
 * The ripple map (spec §8): root node centred, targets fanned out by role in
 * fixed sectors, edge colour = transmitted direction (grey = unclear),
 * thickness = propagation tier, chips carry the pricing badge — OPEN in the
 * accent (the most alive thing on screen), PRICED receded, PARTIAL between,
 * UNTRACKED ghosted on a dashed edge. Targets stagger outward from the root
 * once per run load (~400ms total).
 */

type Props = {
  run: PropagationRun;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
};

const CHIP_W = 92;
const CHIP_H = 44;

function chipTone(t: PropagationTarget): { fill: string; stroke: string; text: string; badgeFill: string; badgeText: string; badgeStroke: string; ghost: boolean } {
  const vetoed = t.stage2?.verdict === "vetoed";
  if (vetoed) {
    return { fill: "#f7f7f4", stroke: HAIRLINE, text: FAINT, badgeFill: "transparent", badgeText: FAINT, badgeStroke: HAIRLINE, ghost: true };
  }
  if (!t.tracked) {
    return { fill: "#fbfbf9", stroke: HAIRLINE, text: MUTED, badgeFill: "transparent", badgeText: FAINT, badgeStroke: HAIRLINE, ghost: true };
  }
  switch (t.pricing.status) {
    case "open":
      return { fill: "#ffffff", stroke: ACCENT, text: INK, badgeFill: ACCENT, badgeText: "#ffffff", badgeStroke: ACCENT, ghost: false };
    case "partial":
      return { fill: "#ffffff", stroke: "#d6d6cf", text: INK, badgeFill: "#eef6f5", badgeText: "#11706d", badgeStroke: "#bfe0de", ghost: false };
    case "contradicted":
      // The third neutral: the tape moved the other way — neither an opening
      // nor an absorption.
      return { fill: "#ffffff", stroke: AMBER_LINE, text: INK, badgeFill: AMBER_SOFT, badgeText: AMBER, badgeStroke: AMBER_LINE, ghost: false };
    case "stale":
      return { fill: "#fbfbf9", stroke: HAIRLINE, text: MUTED, badgeFill: "transparent", badgeText: FAINT, badgeStroke: HAIRLINE, ghost: false };
    case "priced":
      return { fill: "#f7f7f4", stroke: HAIRLINE, text: MUTED, badgeFill: "transparent", badgeText: FAINT, badgeStroke: HAIRLINE, ghost: false };
    default:
      return { fill: "#fbfbf9", stroke: HAIRLINE, text: MUTED, badgeFill: "transparent", badgeText: FAINT, badgeStroke: HAIRLINE, ghost: true };
  }
}

function shortLabel(t: PropagationTarget): string {
  if (t.ticker) return t.ticker;
  const words = t.label.replace(/,?\s+(Inc\.?|Corp\.?|Corporation|Co\.?,? Ltd\.?|Ltd\.?|LLC|N\.A\.|plc|Limited|Company)$/i, "").trim();
  return words.length > 13 ? `${words.slice(0, 12)}…` : words;
}

export default function RippleMap({ run, selectedKey, onSelect }: Props) {
  const [ref, bounds] = useMeasure();
  const width = Math.max(320, bounds.width);
  const height = Math.max(320, bounds.height);
  const layout = useMemo(() => layoutRipple(run.targets, width, height), [run.targets, width, height]);

  // Reveal once per run: chips start on the root and travel outward, staggered.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setRevealed(true)));
    return () => cancelAnimationFrame(id);
  }, [run.run_id]);

  const n = Math.max(1, layout.placed.length);
  const perChip = Math.min(40, 400 / n);

  return (
    <div ref={ref} className="relative h-full w-full select-none">
      <svg width={width} height={height} className="absolute inset-0" onClick={() => onSelect(null)}>
        <defs>
          <radialGradient id="ripple-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1d1b1b" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#1d1b1b" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Quiet concentric rings — the ripple ground. */}
        {[0.36, 0.64, 1].map((k) => (
          <ellipse
            key={k}
            cx={layout.cx}
            cy={layout.cy}
            rx={layout.rx * k}
            ry={layout.ry * k}
            fill="none"
            stroke={HAIRLINE}
            strokeOpacity={0.75}
            strokeDasharray={k === 1 ? "2 6" : undefined}
          />
        ))}
        <circle cx={layout.cx} cy={layout.cy} r={Math.min(layout.rx, layout.ry) * 0.5} fill="url(#ripple-halo)" />

        {/* Sector labels. */}
        {layout.groups.map((g) => (
          <text
            key={g.group}
            x={g.labelX}
            y={g.labelY}
            textAnchor={g.anchor}
            dominantBaseline="middle"
            fill={FAINT}
            fontSize={10}
            letterSpacing={1.2}
            fontFamily="Geist Sans, system-ui, sans-serif"
            style={{ textTransform: "uppercase" }}
          >
            {GROUP_LABEL[g.group].toUpperCase()} · {g.count}
          </text>
        ))}

        {/* Edges. */}
        {layout.placed.map((p) => {
          const t = p.target;
          const vetoed = t.stage2?.verdict === "vetoed";
          const color = vetoed ? HAIRLINE : directionColor(t.transmission.direction);
          const dashed = !t.tracked || vetoed;
          const selected = selectedKey === p.key;
          const dimmed = selectedKey !== null && !selected;
          const delay = p.order * perChip;
          return (
            <line
              key={`e-${p.key}`}
              x1={layout.cx}
              y1={layout.cy}
              x2={revealed ? p.x : layout.cx}
              y2={revealed ? p.y : layout.cy}
              stroke={color}
              strokeWidth={selected ? tierStroke(t.transmission.tier) + 1 : tierStroke(t.transmission.tier)}
              strokeOpacity={dimmed ? 0.25 : vetoed ? 0.6 : 0.85}
              strokeDasharray={dashed ? "4 5" : undefined}
              strokeLinecap="round"
              style={{ transition: `x2 420ms cubic-bezier(.2,.7,.2,1) ${delay}ms, y2 420ms cubic-bezier(.2,.7,.2,1) ${delay}ms, stroke-opacity 200ms` }}
            />
          );
        })}

        {/* Root. */}
        <g>
          <circle cx={layout.cx} cy={layout.cy} r={40} fill="#1d1b1b" />
          <text
            x={layout.cx}
            y={layout.cy + 1}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#f7f7f4"
            fontSize={run.root_ticker.length > 4 ? 15 : 18}
            fontFamily="Libre Baskerville, Georgia, serif"
          >
            {run.root_ticker}
          </text>
        </g>

        {/* Target chips. */}
        {layout.placed.map((p) => {
          const t = p.target;
          const tone = chipTone(t);
          const selected = selectedKey === p.key;
          const dimmed = selectedKey !== null && !selected;
          const delay = p.order * perChip;
          const x = revealed ? p.x : layout.cx;
          const y = revealed ? p.y : layout.cy;
          const open = t.tracked && t.pricing.status === "open" && t.stage2?.verdict !== "vetoed";
          const badge = pricingWord(t);
          return (
            <g
              key={p.key}
              transform={`translate(${x - CHIP_W / 2}, ${y - CHIP_H / 2})`}
              style={{
                cursor: "pointer",
                opacity: dimmed ? 0.35 : revealed ? 1 : 0,
                transition: `transform 420ms cubic-bezier(.2,.7,.2,1) ${delay}ms, opacity 280ms ease ${delay}ms`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(selected ? null : p.key);
              }}
            >
              {open && (
                <rect
                  x={-4}
                  y={-4}
                  width={CHIP_W + 8}
                  height={CHIP_H + 8}
                  rx={12}
                  fill="none"
                  stroke={ACCENT}
                  strokeOpacity={0.35}
                  className="ripple-pulse"
                />
              )}
              <rect
                width={CHIP_W}
                height={CHIP_H}
                rx={9}
                fill={tone.fill}
                stroke={selected ? INK : tone.stroke}
                strokeWidth={selected ? 1.5 : 1}
                strokeDasharray={tone.ghost && !selected ? "3 3" : undefined}
              />
              <text
                x={CHIP_W / 2}
                y={15}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={tone.text}
                fontSize={t.ticker ? 13 : 10.5}
                fontWeight={500}
                fontFamily="Geist Sans, system-ui, sans-serif"
                style={{ textDecoration: t.stage2?.verdict === "vetoed" ? "line-through" : undefined }}
              >
                {shortLabel(t)}
              </text>
              <rect x={CHIP_W / 2 - 31} y={25} width={62} height={13} rx={6.5} fill={tone.badgeFill} stroke={tone.badgeStroke} strokeWidth={0.75} />
              <text
                x={CHIP_W / 2}
                y={32}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={tone.badgeText}
                fontSize={8}
                fontWeight={600}
                letterSpacing={0.8}
                fontFamily="Geist Sans, system-ui, sans-serif"
              >
                {badge}
              </text>
            </g>
          );
        })}
      </svg>
      <style>{`
        @keyframes ripple-pulse { 0% { stroke-opacity: .45; transform: scale(1); } 100% { stroke-opacity: 0; transform: scale(1.12); } }
        .ripple-pulse { transform-box: fill-box; transform-origin: center; animation: ripple-pulse 2.4s ease-out infinite; }
      `}</style>
    </div>
  );
}

