import { Iphone16Pro } from "./ui/iphone-16-pro";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";
const INK = "rgb(29, 27, 27)";
const BODY = "rgb(70, 66, 66)";
const MUTED = "#9a938a";

export default function RunAnywhere() {
  return (
    <section className="mx-auto max-w-7xl px-6 pb-24 pt-10 sm:px-10">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-20">
        {/* Left: heading + copy */}
        <div className="max-w-xl">
          <h2
            style={{
              fontFamily: SERIF,
              fontWeight: 400,
              fontSize: "36px",
              lineHeight: "41px",
              color: INK,
            }}
          >
            Run it from anywhere.
          </h2>
          <p
            className="mt-6"
            style={{
              fontFamily: GEIST,
              fontWeight: 400,
              fontSize: "16px",
              lineHeight: "22px",
              color: BODY,
            }}
          >
            Falcon runs on your desktop, but the work follows you. Check a
            signal from your phone on the way in, then pick the research back
            up when you sit down.
          </p>
          <p
            className="mt-4"
            style={{
              fontFamily: GEIST,
              fontWeight: 400,
              fontSize: "16px",
              lineHeight: "22px",
              color: BODY,
            }}
          >
            Your watchlist and everything Falcon has turned up for you live
            with your account, not on one laptop.
          </p>
        </div>

        {/* Right: iPhone frame with live mobile dashboard screenshot */}
        <div className="flex flex-col items-center">
          {/* drop-shadow, not box-shadow: the frame is an SVG, so the shadow
              has to follow its rounded silhouette instead of a square box. */}
          <div
            className="w-[280px] sm:w-[300px]"
            style={{
              filter:
                "drop-shadow(0 18px 30px rgba(8, 12, 18, 0.18)) drop-shadow(0 4px 8px rgba(8, 12, 18, 0.10))",
            }}
          >
            <Iphone16Pro
              className="w-full text-[#fdfdfd]"
              width={300}
              height={600}
              src="/run-anywhere-phone.png"
              alt="Falcon mobile dashboard"
            />
          </div>
          <p
            className="mt-7"
            style={{
              fontFamily: MONO,
              fontSize: "11px",
              lineHeight: "15px",
              letterSpacing: "0.12em",
              color: MUTED,
            }}
          >
            THE SAME DESK, IN YOUR POCKET
          </p>
        </div>
      </div>
    </section>
  );
}
