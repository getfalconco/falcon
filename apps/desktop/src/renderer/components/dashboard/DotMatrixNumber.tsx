import { memo } from "react";

/**
 * A number drawn as an LED sign: every character a grid of dots, seven rows
 * tall, lit where the glyph is and faintly there where it is not. Digits are
 * all five dots wide, so the figure is tabular and does not shuffle sideways
 * as it changes; separators are narrower, the way they are in type.
 *
 * Dots are SVG circles, so the figure stays crisp at any size, and a change
 * fades each dot on or off in place (`.dot-matrix` in globals.css), the
 * columns a beat apart, instead of swapping a picture. Cells are keyed from
 * the right, so the ones digit stays the ones digit when the figure gains a
 * place on the left.
 *
 * The glyph set is what a balance needs in any of the app's languages: the
 * digits, both separators, the dollar sign and the letters of "US$" and
 * "USD", plus and minus, and the star a masked figure is drawn in. Anything
 * else (a space of any width) is a gap.
 */

const ROWS = 7;

/** Each glyph as rows of '1' (lit) and '0' (unlit), top to bottom; the width is the row's length. */
const GLYPHS: Record<string, readonly string[]> = {
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  $: ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "*": ["00000", "10101", "01110", "11111", "01110", "10101", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "-": ["000", "000", "000", "111", "000", "000", "000"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
  ",": ["00", "00", "00", "00", "00", "01", "10"],
};
/** A space, a no-break space, a narrow one, or a character with no glyph: two columns of nothing. */
const GAP: readonly string[] = ["00", "00", "00", "00", "00", "00", "00"];

function glyphOf(ch: string): readonly string[] {
  if (ch === "−") return GLYPHS["-"];
  return GLYPHS[ch] ?? GAP;
}

/** How many dot columns a string takes, the one-column gap between characters included. */
export function matrixColumns(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  return chars.reduce((sum, ch) => sum + glyphOf(ch)[0].length, 0) + (chars.length - 1);
}

/** Lit dots are drawn at full strength; unlit ones in the `--glow-dot-off` colour. */
const Cell = memo(function Cell({ ch, x, pitch, radius }: { ch: string; x: number; pitch: number; radius: number }) {
  const glyph = glyphOf(ch);
  const cols = glyph[0].length;
  const dots = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      const on = glyph[r][c] === "1";
      dots.push(
        <circle
          key={`${r}-${c}`}
          cx={x + c * pitch + pitch / 2}
          cy={r * pitch + pitch / 2}
          r={radius}
          style={{
            fill: on ? "currentColor" : "var(--glow-dot-off)",
            // Left to right across the cell: a digit redraws as a sweep.
            transitionDelay: `${c * 22}ms`,
          }}
        />,
      );
    }
  }
  return <g>{dots}</g>;
});

export default function DotMatrixNumber({
  text,
  pitch,
  fast = false,
  className,
}: {
  /** What to draw, already formatted. */
  text: string;
  /** Centre to centre distance between dots, in pixels; the figure is seven of these tall. */
  pitch: number;
  /** Changes land almost at once (scrubbing), with no sweep across the columns. */
  fast?: boolean;
  className?: string;
}) {
  const chars = [...text];
  const radius = pitch * 0.32;
  let x = 0;
  const cells = chars.map((ch, i) => {
    const cell = { ch, x, key: chars.length - i };
    x += (glyphOf(ch)[0].length + 1) * pitch;
    return cell;
  });
  const width = Math.max(0, x - pitch);
  const height = ROWS * pitch;

  return (
    <svg
      aria-hidden
      className={className ? `dot-matrix ${className}` : "dot-matrix"}
      data-fast={fast ? "" : undefined}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // The figure is the only thing here, and it is a picture of text: no stretching.
      preserveAspectRatio="xMinYMid meet"
      style={{ overflow: "visible", display: "block" }}
    >
      {cells.map((cell) => (
        <Cell key={cell.key} ch={cell.ch} x={cell.x} pitch={pitch} radius={radius} />
      ))}
    </svg>
  );
}
