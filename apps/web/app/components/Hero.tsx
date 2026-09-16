import LandingDesktopPreview from "./LandingDesktopPreview";
import GetStartedButton from "./GetStartedButton";
import HeroDemoCard from "./HeroDemoCard";

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";

export default function Hero({
  heading = "When one stock moves, know which one moves next",
  subline = "See how one company's news moves the stocks around it, before consensus does.",
  showDemo = true,
  preview,
  topPaddingClass = "pt-[9rem]",
}: {
  heading?: React.ReactNode;
  subline?: string;
  /** The "See the chain" card floating over the glass. */
  showDemo?: boolean;
  /** An app screenshot floating over the glass instead — served as-is, so
      the original resolution is what reaches the screen. */
  preview?: { src: string; srcSet?: string; alt: string; width: number; height: number };
  /** Clears the fixed header by default; tighten it when something sits above. */
  topPaddingClass?: string;
}) {
  return (
    <section className={`${topPaddingClass} pb-12`}>
      <div className="mx-auto max-w-6xl px-6 sm:px-10 lg:px-16">
        {/* Top row: heading on the left, CTA block on the right */}
        <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:justify-between">
          <h1
            className="max-w-xl"
            style={{
              fontFamily: HEADING_FONT,
              fontWeight: 400,
              fontSize: "48px",
              lineHeight: "48px",
              color: "rgb(29, 27, 27)",
            }}
          >
            {heading}
          </h1>

          <div className="flex flex-col items-start gap-3 lg:items-end">
            <p
              style={{
                fontFamily: "var(--font-geist-mono), monospace",
                fontWeight: 400,
                fontStyle: "normal",
                color: "rgb(161, 161, 161)",
                fontSize: "12px",
                lineHeight: "17px",
              }}
              className="lg:text-right"
            >
              START WITH FALCON TODAY
              <br />
              AND SEE THE NEXT MOVE FIRST
            </p>

            <GetStartedButton />
          </div>
        </div>

        {/* Subline */}
        <p
          className="mt-16 text-center"
          style={{
            fontFamily: HEADING_FONT,
            fontWeight: 400,
            color: "rgb(29, 27, 27)",
            fontSize: "20px",
            lineHeight: "28px",
          }}
        >
          {subline}
        </p>
      </div>

      <div className="relative mx-auto max-w-[1180px]">
        <LandingDesktopPreview />
        {showDemo ? (
          <div className="absolute inset-0 flex items-center justify-center px-4 sm:px-8">
            <HeroDemoCard />
          </div>
        ) : null}
        {preview ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 sm:px-10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview.src}
              // 1x screens get a copy downscaled with a proper filter (sharper
              // than the browser's own), 2x screens get the original.
              srcSet={preview.srcSet}
              sizes={preview.srcSet ? "(min-width: 1280px) 1120px, 93vw" : undefined}
              alt={preview.alt}
              width={preview.width}
              height={preview.height}
              className="h-auto w-[93%] max-w-[1120px] rounded-[10px] shadow-[0_24px_60px_rgba(2,18,24,0.45),0_2px_8px_rgba(2,18,24,0.25)]"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
