import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Navbar from "../components/Navbar";
import GetStartedButton from "../components/GetStartedButton";
import SiteFooter from "../components/SiteFooter";
import TeamGrid, { type TeamMember } from "./TeamGrid";

export const metadata: Metadata = {
  title: "About",
};

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";

const PARAGRAPHS = [
  "Most traders we know sit somewhere between ten and thirty tabs deep. A news feed, a screener, two brokers, filings, earnings calls, someone's newsletter, a chart with too many indicators on it. The thing that actually moves your stocks is almost never in the tab you're looking at. It's buried in a supplier's 10-K you've never opened.",
  "AI was supposed to help with this. Instead, we got chat windows. You paste a headline in, get a confident paragraph back, then go check whether any of it is true. The AI hasn't read the filings. It doesn't know what you hold. It can't tell you which of your positions a piece of news actually reaches. So you end up doing the same digging as before, just with an extra tab open.",
  "Falcon reads the filings themselves and maps who depends on whom — suppliers, customers, partners, the exposure between them. Then it watches the news against that map. Not summaries. Not sentiment scores. Actual tracing: news lands on one company, Falcon walks the graph and tells you which stock it touches next, with the sentence it learned that from.",
  "The direction is simple: the research that billion-dollar desks keep to themselves should be sitting on your desk instead.",
  "We trade with Falcon ourselves every day. We think you'll find it useful too.",
];

// Drop each photo into public/team with these filenames and it appears here;
// until then the cell falls back to initials.
type TeamSeed = Omit<TeamMember, "photo"> & {
  photo: string;
  assistant?: Omit<NonNullable<TeamMember["assistant"]>, "photo"> & { photo: string };
};

const HIRING_ASSISTANT = {
  name: "",
  role: "Now Hiring",
  linkedin: "",
  photo: "placeholder.svg",
  hiring: true,
};

const TEAM: TeamSeed[] = [
  {
    name: "Kuzey Kovalak",
    role: "CEO",
    linkedin: "https://www.linkedin.com/in/kuzeykovalak/",
    photo: "kuzey.jpg",
    assistant: HIRING_ASSISTANT,
  },
  {
    name: "Umut Toprak Uslu",
    role: "CTO",
    linkedin: "https://www.linkedin.com/in/umutusluz/",
    photo: "umut.png",
    assistant: {
      name: "Aras Karaman",
      role: "Internal Tools & Talent Operations (Contract)",
      linkedin: "",
      photo: "aras.png",
    },
  },
  {
    name: "Can Kovalak",
    role: "CFO",
    linkedin: "https://www.linkedin.com/in/can-kovalak-509b101b8/",
    photo: "can.png",
    assistant: HIRING_ASSISTANT,
  },
  {
    name: "Vaibhav Bhaskar",
    role: "Product & Research Advisor",
    linkedin: "https://www.linkedin.com/in/vaibhav-bhaskar-717670290/",
    photo: "vaibhav.jpg",
    // Slide the picture a touch left inside the square crop.
    crop: "62% 50%",
    assistant: HIRING_ASSISTANT,
  },
];

/** Checked at render time on the server, so a missing file can't 404. */
function photoUrl(file: string): string | null {
  return existsSync(join(process.cwd(), "public", "team", file))
    ? `/team/${file}`
    : null;
}

function resolveMember(member: TeamSeed): TeamMember {
  return {
    ...member,
    photo: photoUrl(member.photo),
    assistant: member.assistant
      ? { ...member.assistant, photo: photoUrl(member.assistant.photo) }
      : undefined,
  };
}

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />

      <main className="mx-auto max-w-7xl px-6 pb-32 pt-32 sm:px-10">
        <div className="grid grid-cols-1 gap-16 lg:grid-cols-2 lg:gap-20">
          {/* Left: the letter. */}
          <div className="max-w-xl">
            <p
              style={{
                fontFamily: MONO,
                fontSize: "11px",
                lineHeight: "15px",
                letterSpacing: "0.12em",
                color: "#9a9a9a",
              }}
            >
              About Falcon
            </p>

            <h1
              className="mt-7"
              style={{
                fontFamily: HEADING_FONT,
                fontWeight: 400,
                fontSize: "44px",
                lineHeight: "54px",
                color: "rgb(29, 27, 27)",
              }}
            >
              The market moves first.
              <br />
              It shouldn&rsquo;t move without you.
            </h1>

            <div className="mt-12 space-y-6">
              {PARAGRAPHS.map((text) => (
                <p
                  key={text.slice(0, 24)}
                  style={{
                    fontFamily: GEIST,
                    fontSize: "16.5px",
                    lineHeight: 1.7,
                    color: "#4b4b48",
                  }}
                >
                  {text}
                </p>
              ))}
            </div>

            <p
              className="mt-12"
              style={{
                fontFamily: HEADING_FONT,
                fontStyle: "italic",
                fontSize: "22px",
                color: "rgb(29, 27, 27)",
              }}
            >
              Falcon Team
            </p>

            <div className="mt-10">
              <GetStartedButton className="h-[45px] w-full pl-5 pr-3.5" />
            </div>
          </div>

          {/* Right: portraits zigzag right-left-right-left, and every empty
              seat is a dotted square the same size as the photos. */}
          <TeamGrid members={TEAM.map(resolveMember)} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
