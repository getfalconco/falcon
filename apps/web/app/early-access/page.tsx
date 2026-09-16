import EarlyAccessGate from "../components/EarlyAccessGate";
import Navbar from "../components/Navbar";

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";

// Shown on the focus stage once the ticket is clicked.
const STAGE_HEADING =
  "A founding member is more than an early user. They're a builder.";
const STAGE_PARAGRAPHS = [
  "At Falcon, founding members don't just get in first, they help decide what Falcon becomes. They test what's next before anyone else, shape the features that ship, and get full, unlimited access to everything the product does. We're looking for traders who believe desk-level research shouldn't be locked behind institutional walls: people who think in edges, move before consensus, and want to help build the tool they always wished existed.",
  "Whether you trade every day or spend your nights mapping how one company's move ripples to the next, there's a place for you in the first group.",
];

// Second screen, reached from the stage's "Continue".
const STAGE_STEP_2 = {
  intro:
    "Full, unlimited access to Falcon, and a hand in shaping it.",
  paragraphs: [
    "Tell us how you trade and what you're after. We review every application and approve the members who fit. Once you're in, you claim your membership and lock a discount on every plan we ever release.",
    "This is a selective process. We keep the first group small on purpose, so we can listen closely and build with the people who were here first.",
  ],
};

export default function EarlyAccessPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <div className="pb-32 pt-[15rem]">
        <div className="mx-auto max-w-6xl px-6 sm:px-10 lg:px-16">
          {/* Copy on the left, the ticket alongside it on the right. */}
          <div className="flex flex-col gap-16 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
            <div className="max-w-xl">
              <h1
                style={{
                  fontFamily: HEADING_FONT,
                  fontWeight: 400,
                  fontSize: "48px",
                  lineHeight: "48px",
                  color: "rgb(29, 27, 27)",
                }}
              >
                Being early has its perks
              </h1>

              <p
                className="mt-6"
                style={{
                  fontFamily: "var(--font-geist-sans), sans-serif",
                  fontWeight: 400,
                  fontSize: "17px",
                  lineHeight: "26px",
                  color: "rgb(90, 90, 90)",
                }}
              >
                Only a few get in. And they get more than access.
              </p>
            </div>

            <div className="shrink-0">
              <EarlyAccessGate
                stageHeading={STAGE_HEADING}
                stageParagraphs={STAGE_PARAGRAPHS}
                stageStep2={STAGE_STEP_2}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
