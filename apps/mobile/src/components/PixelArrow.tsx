import { useEffect, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { G, Rect } from "react-native-svg";

/**
 * The website's GetStartedButton arrow: a 9x9 grid of square pixels with a
 * thin right arrow that marches across in 4px steps
 * (`pixel-arrow-march 3.4s steps(15, end) infinite` in apps/web globals.css:
 * from -28px to 32px over the first 78%, then a rest).
 */

const COLS = 9;
const ROWS = 9;
const CELL = 4;
const DOT = 3;
const RX = 0.75;
const W = (COLS - 1) * CELL + DOT; // 35
const H = (ROWS - 1) * CELL + DOT; // 35
const ARROW = [
  ".........",
  ".........",
  "....#....",
  ".....#...",
  ".######..",
  ".....#...",
  "....#....",
  ".........",
  ".........",
];

const CYCLE_MS = 3400;
const MARCH_MS = CYCLE_MS * 0.78;
const STEPS = 15;
const FROM = -28;
const TO = 32;

const BACKGROUND: { x: number; y: number }[] = [];
const LIT: { x: number; y: number }[] = [];
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    BACKGROUND.push({ x, y });
    if (ARROW[y][x] === "#") LIT.push({ x, y });
  }
}

function offsetAt(elapsed: number): number {
  const t = elapsed % CYCLE_MS;
  if (t >= MARCH_MS) return TO;
  return FROM + Math.floor((t / MARCH_MS) * STEPS) * ((TO - FROM) / STEPS);
}

export function PixelArrow() {
  const reduceMotion = useReducedMotion();
  const [offset, setOffset] = useState(reduceMotion ? 0 : FROM);

  useEffect(() => {
    if (reduceMotion) {
      setOffset(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      const next = offsetAt(Date.now() - start);
      setOffset((prev) => (prev === next ? prev : next));
    }, 40);
    return () => clearInterval(timer);
  }, [reduceMotion]);

  return (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <G>
        {BACKGROUND.map(({ x, y }) => (
          <Rect key={`b-${x}-${y}`} x={x * CELL} y={y * CELL} width={DOT} height={DOT} rx={RX} fill="#ffffff" opacity={0.15} />
        ))}
      </G>
      <G>
        {LIT.map(({ x, y }) => (
          <Rect
            key={`a-${x}-${y}`}
            x={x * CELL + offset}
            y={y * CELL}
            width={DOT}
            height={DOT}
            rx={RX}
            fill="#ffffff"
            opacity={0.95}
          />
        ))}
      </G>
    </Svg>
  );
}
