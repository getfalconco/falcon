import { Bell } from "lucide-react";

/**
 * Small SVG and CSS visuals for the welcome flow's in-between screens. Same
 * Turkish blue disc language as MarketOrbit; animations live in welcome.css
 * and stop under prefers-reduced-motion.
 */

const DISC_SIZE = "min(72vw, 40dvh, 360px)";

function DiscDefs({ id }: { id: string }) {
  return (
    <defs>
      <radialGradient id={id} cx="38%" cy="30%" r="78%">
        <stop offset="0%" stopColor="#ffffff" />
        <stop offset="55%" stopColor="#e4f7fa" />
        <stop offset="100%" stopColor="#b3e9f1" />
      </radialGradient>
    </defs>
  );
}

/** "You're not alone": a ripple spreading from one event to nearby stocks. */
export function RippleArt() {
  const nodes = [
    { x: 92, y: 132, d: "1.1s" },
    { x: 300, y: 112, d: "1.5s" },
    { x: 318, y: 266, d: "1.9s" },
    { x: 112, y: 296, d: "1.3s" },
    { x: 214, y: 340, d: "1.7s" },
  ];
  return (
    <div className="welcome-float shrink-0" style={{ width: DISC_SIZE, height: DISC_SIZE }} aria-hidden>
      <svg viewBox="0 0 400 400" className="h-full w-full overflow-visible" style={{ filter: "drop-shadow(0 28px 48px rgba(15, 84, 104, 0.14))" }}>
        <DiscDefs id="ripple-disc" />
        <circle cx="200" cy="200" r="170" fill="url(#ripple-disc)" />
        <circle cx="200" cy="200" r="169" fill="none" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="1.5" />
        {[0, 1, 2].map((i) => (
          <circle
            key={i}
            className="welcome-ripple"
            style={{ animationDelay: `${i * 1.2}s` }}
            cx="200"
            cy="200"
            r="40"
            fill="none"
            stroke="#1a7f95"
            strokeWidth="1.5"
          />
        ))}
        {nodes.map((n) => (
          <g key={`${n.x}-${n.y}`}>
            <line x1="200" y1="200" x2={n.x} y2={n.y} stroke="#0f5468" strokeOpacity="0.12" strokeDasharray="2 5" />
            <circle className="welcome-node" style={{ animationDelay: n.d }} cx={n.x} cy={n.y} r="7" fill="#ffffff" stroke="#34a8bd" strokeWidth="2.5" />
          </g>
        ))}
        <circle cx="200" cy="200" r="13" fill="#0f5468" />
        <circle cx="200" cy="200" r="5" fill="#ffffff" />
      </svg>
    </div>
  );
}

/** "What matters in 30 seconds": a 30s dial beside a three line brief. */
export function BriefArt() {
  return (
    <div
      className="welcome-float flex w-full max-w-[420px] items-center gap-5 rounded-3xl border border-white/80 bg-white/70 p-5 shadow-[0_24px_60px_rgba(15,84,104,0.12)] backdrop-blur-md sm:gap-6 sm:p-7"
      aria-hidden
    >
      <div className="relative h-24 w-24 shrink-0 sm:h-28 sm:w-28">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="44" fill="#e4f7fa" stroke="#0f5468" strokeOpacity="0.08" strokeWidth="6" />
          <circle
            className="welcome-dial"
            cx="50"
            cy="50"
            r="44"
            fill="none"
            stroke="#1a7f95"
            strokeWidth="6"
            strokeLinecap="round"
            pathLength={1}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-serif text-[1.6rem] text-[#0f5468] [font-variant-numeric:lining-nums] sm:text-[1.9rem]">
          30s
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {["82%", "100%", "64%"].map((w, i) => (
          <div key={w} className="flex items-center gap-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#34a8bd]" style={{ opacity: 1 - i * 0.25 }} />
            <span
              className="welcome-bar block h-2.5 rounded-full bg-[#0f5468]/[0.12]"
              style={{ width: w, animationDelay: `${0.5 + i * 0.35}s` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Notifications step: an alert card, content left abstract on purpose. */
export function AlertArt() {
  return (
    <div className="welcome-float w-full max-w-[380px]" aria-hidden>
      <div className="welcome-alert flex items-start gap-3.5 rounded-2xl border border-white/80 bg-white/85 p-4 shadow-[0_24px_60px_rgba(15,84,104,0.14)] backdrop-blur-md">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#0f5468] text-white">
          <Bell className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center justify-between text-[12px] text-[#5f6a6d]">
            <span className="font-medium text-[#1d1b1b]">Falcon</span>
            <span>now</span>
          </div>
          <span className="mt-2 block h-2.5 w-[88%] rounded-full bg-[#0f5468]/[0.14]" />
          <span className="mt-2 block h-2.5 w-[62%] rounded-full bg-[#0f5468]/[0.09]" />
        </div>
      </div>
    </div>
  );
}
