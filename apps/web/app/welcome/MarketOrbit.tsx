import { TrendingDown, TrendingUp } from "lucide-react";

/**
 * The welcome visual: a glassy Turkish blue disc where a choppy price line
 * draws itself and turns into a steady rising curve, with a few tickers on a
 * slow orbit around it. Pure SVG and CSS (welcome.css); every animation stops
 * under prefers-reduced-motion and the finished state shows instead.
 */

const LINE =
  "M 60 252 L 80 243 L 98 258 L 118 238 L 136 250 L 154 230 L 172 243 L 190 224 C 216 218, 240 204, 260 180 S 296 132, 316 120";
const AREA = `${LINE} L 316 360 L 60 360 Z`;

const CHIPS: { ticker: string; up: boolean; angle: number }[] = [
  { ticker: "NVDA", up: true, angle: 205 },
  { ticker: "SPX", up: true, angle: 325 },
  { ticker: "BTC", up: false, angle: 85 },
];

export default function MarketOrbit() {
  return (
    <div
      className="welcome-float relative shrink-0"
      style={
        {
          "--s": "min(76vw, 44dvh, 400px)",
          width: "var(--s)",
          height: "var(--s)",
        } as React.CSSProperties
      }
      aria-hidden
    >
      <svg
        viewBox="0 0 400 400"
        className="absolute inset-0 h-full w-full overflow-visible"
        style={{ filter: "drop-shadow(0 28px 48px rgba(15, 84, 104, 0.16))" }}
      >
        <defs>
          <radialGradient id="welcome-disc" cx="38%" cy="30%" r="78%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="55%" stopColor="#e4f7fa" />
            <stop offset="100%" stopColor="#b3e9f1" />
          </radialGradient>
          <linearGradient id="welcome-stroke" x1="60" y1="0" x2="316" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#63d2e2" />
            <stop offset="55%" stopColor="#1a7f95" />
            <stop offset="100%" stopColor="#0f5468" />
          </linearGradient>
          <linearGradient id="welcome-fill" x1="0" y1="120" x2="0" y2="350" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#34a8bd" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#34a8bd" stopOpacity="0" />
          </linearGradient>
          <clipPath id="welcome-clip">
            <circle cx="200" cy="200" r="150" />
          </clipPath>
        </defs>

        <circle cx="200" cy="200" r="186" fill="none" stroke="#0f5468" strokeOpacity="0.14" strokeDasharray="1 7" strokeLinecap="round" strokeWidth="1.5" />
        <circle cx="200" cy="200" r="150" fill="url(#welcome-disc)" />

        <g clipPath="url(#welcome-clip)">
          {[110, 155, 200, 245, 290].map((y) => (
            <line key={y} x1="50" x2="350" y1={y} y2={y} stroke="#0f5468" strokeOpacity="0.06" />
          ))}
          <g className="welcome-area">
            <path d={AREA} fill="url(#welcome-fill)" />
            <line x1="316" x2="316" y1="132" y2="350" stroke="#0f5468" strokeOpacity="0.28" strokeDasharray="2 5" strokeLinecap="round" strokeWidth="1.25" />
          </g>
        </g>

        <path
          className="welcome-line"
          d={LINE}
          pathLength={1}
          fill="none"
          stroke="url(#welcome-stroke)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <g className="welcome-tip">
          <circle className="welcome-tip-halo" cx="316" cy="120" r="7" fill="#1a7f95" />
          <circle cx="316" cy="120" r="7" fill="#ffffff" stroke="#0f5468" strokeWidth="3" />
        </g>

        <circle cx="200" cy="200" r="149.25" fill="none" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="1.5" />
      </svg>

      <div className="welcome-orbit absolute inset-0">
        {CHIPS.map((chip) => (
          <div
            key={chip.ticker}
            className="absolute left-1/2 top-1/2"
            style={{
              transform: `rotate(${chip.angle}deg) translateX(calc(var(--s) * 0.465)) rotate(${-chip.angle}deg)`,
            }}
          >
            <div className="welcome-orbit-chip h-0 w-0">
              <div className="absolute left-0 top-0 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#0f5468]/10 bg-white/90 px-2.5 py-1 text-[11px] font-medium tracking-[0.02em] text-[#1d1b1b] shadow-[0_6px_18px_rgba(15,84,104,0.10)] backdrop-blur sm:text-xs">
                {chip.up ? (
                  <TrendingUp className="h-3 w-3 text-[#1a7f95]" strokeWidth={2.25} />
                ) : (
                  <TrendingDown className="h-3 w-3 text-[#8a8f91]" strokeWidth={2.25} />
                )}
                {chip.ticker}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
