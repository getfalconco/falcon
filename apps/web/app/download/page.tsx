import type { Metadata } from "next";
import Navbar from "../components/Navbar";
import SiteFooter from "../components/SiteFooter";
import GlassPanel from "../components/GlassPanel";
import DownloadButtons from "../components/DownloadButtons";
import DownloadDock from "../components/download/DownloadDock";

export const metadata: Metadata = {
  title: "Download",
};

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";

export default function DownloadPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />

      {/* Full viewport tall, content vertically centred — the footer starts
          only once you scroll past the fold. */}
      <main className="mx-auto flex min-h-[100svh] max-w-7xl items-center px-6 pb-20 pt-24 sm:px-10">
        <div className="grid w-full grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-20">
          {/* Left: heading, subline right under it, the three builds. */}
          <div className="max-w-xl">
            <h1
              style={{
                fontFamily: HEADING_FONT,
                fontWeight: 400,
                fontSize: "48px",
                lineHeight: "52px",
                color: "rgb(29, 27, 27)",
              }}
            >
              Meet Falcon on
              <br />
              your desktop
            </h1>

            <p
              className="mt-5"
              style={{
                fontFamily: GEIST,
                fontWeight: 400,
                fontSize: "17px",
                lineHeight: "26px",
                color: "rgb(90, 90, 90)",
              }}
            >
              The market doesn&apos;t wait for you to open a tab. Falcon
              watches while you work, and while you don&apos;t.
            </p>

            <div className="mt-9">
              <DownloadButtons />
            </div>
          </div>

          {/* Right: the glass, with the dock riding its lower edge — the
              "meet it on your desktop" nod. */}
          <GlassPanel className="aspect-[16/10] w-full">
            <div className="self-end pb-6">
              <DownloadDock />
            </div>
          </GlassPanel>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
