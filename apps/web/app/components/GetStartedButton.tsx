import Link from "next/link";

function PixelGrid() {
  const COLS = 9;
  const ROWS = 9;
  const CELL = 4;
  const DOT = 3;
  const RX = 0.75;
  const W = (COLS - 1) * CELL + DOT; // 35
  const H = (ROWS - 1) * CELL + DOT; // 35
  // 9x9 square-pixel grid; the lit arrow itself is a thin (single-pixel) right
  // arrow spanning 6 columns x 5 rows, centered inside the grid.
  const arrow = [
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

  const bg: React.ReactNode[] = [];
  const lit: { x: number; y: number }[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      bg.push(
        <rect
          key={`b-${x}-${y}`}
          x={x * CELL}
          y={y * CELL}
          width={DOT}
          height={DOT}
          rx={RX}
          fill="#ffffff"
          opacity={0.15}
        />,
      );
      if (arrow[y][x] === "#") lit.push({ x, y });
    }
  }

  const litRects = (offset: number, tag: string) =>
    lit.map(({ x, y }) => (
      <rect
        key={`${tag}-${x}-${y}`}
        x={x * CELL + offset}
        y={y * CELL}
        width={DOT}
        height={DOT}
        rx={RX}
        fill="#ffffff"
        opacity={0.95}
      />
    ));

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden
      className="shrink-0"
    >
      <g>{bg}</g>
      <g className="pixel-arrow-march">{litRects(0, "a")}</g>
    </svg>
  );
}

export default function GetStartedButton({
  className = "h-[45px] w-[260px] pl-4 pr-3.5",
  label = "Get started",
  href = "/early-access",
  onClick,
  type,
}: {
  className?: string;
  label?: string;
  /** Link target when rendering as a link (the default). */
  href?: string;
  /** When set (or `type` is given), renders a <button> for in-page actions instead of the link. */
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const sharedClassName = `inline-flex items-center justify-between rounded-lg bg-[#1c1917] transition-colors hover:bg-[#0f0d0b] ${className}`;
  const sharedStyle: React.CSSProperties = {
    fontFamily: "var(--font-geist-sans), sans-serif",
    fontWeight: 400,
    fontStyle: "normal",
    color: "rgb(231, 231, 231)",
    fontSize: "13px",
    lineHeight: "20px",
  };
  const content = (
    <>
      <span>{label}</span>
      <PixelGrid />
    </>
  );

  if (onClick || type) {
    return (
      <button type={type ?? "button"} onClick={onClick} className={sharedClassName} style={sharedStyle}>
        {content}
      </button>
    );
  }

  return (
    <Link href={href} className={sharedClassName} style={sharedStyle}>
      {content}
    </Link>
  );
}
