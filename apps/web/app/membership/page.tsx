import Navbar from "../components/Navbar";
import { TierGrid } from "../components/TierTickets";

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";

export default function MembershipPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <div className="pb-32 pt-[9rem]">
        {/* Same container + left alignment as the homepage hero heading. */}
        <div className="mx-auto max-w-6xl px-6 sm:px-10 lg:px-16">
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
            Memberships that fit how you move
          </h1>

          <p
            className="mt-6 max-w-xl"
            style={{
              fontFamily: "var(--font-geist-sans), sans-serif",
              fontWeight: 400,
              fontSize: "17px",
              lineHeight: "26px",
              color: "rgb(90, 90, 90)",
            }}
          >
            Pick the tier that matches your pace. Upgrade whenever you&rsquo;re ready.
          </p>
        </div>
        <div className="mt-32">
          <TierGrid
            firstName="John"
            lastName="Doe"
            tierKeys={["silver", "gold", "platinum"]}
          />
        </div>
      </div>
    </div>
  );
}
