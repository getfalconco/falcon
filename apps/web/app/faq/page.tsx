import type { Metadata } from "next";
import Navbar from "../components/Navbar";
import FaqAccordion, { type FaqItem } from "../components/FaqAccordion";
import SiteFooter from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "FAQ",
};

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";

const ITEMS: FaqItem[] = [
  {
    question: "What is Falcon?",
    answer:
      "Falcon is a research desk for individual traders. It reads company filings to map who depends on whom, watches the news against that map, and tells you which of your positions a move actually reaches. You get the reasoning and the source, not a headline.",
  },
  {
    question: "How does Falcon find second-order moves?",
    answer:
      "Every relationship comes out of a real filing: suppliers, customers, partners, the exposure between them. When news lands on one company, Falcon walks that graph outward and weighs each path, so a chip shortage in one name surfaces the two companies downstream that quietly depend on it.",
  },
  {
    question: "Where does the data come from?",
    answer:
      "SEC filings for the relationships, live market data for prices, and a news feed that runs around the clock. Every claim Falcon makes links back to the sentence it came from, so you can check it yourself instead of taking our word for it.",
  },
  {
    question: "Do I need to install anything? Which platforms are supported?",
    answer:
      "Falcon runs as a native desktop app for Mac and Windows. Your research and your watchlist live with your account, so signing in on another machine picks up where you left off.",
  },
  {
    question: "Is this investment advice?",
    answer:
      "No. Falcon is research infrastructure: it surfaces relationships, events and reasoning. What you do with that is your call, and nothing in the product is a recommendation to buy or sell.",
  },
  {
    question: "How much does Falcon cost?",
    answer:
      "Pricing opens up with the tiers. Founding members lock a discount on every plan we ever release, which is the main reason to get in during early access rather than after.",
  },
  {
    question: "How do I get in?",
    answer:
      "Apply through early access. We read every application and approve the people who fit, then reach out by email and phone to walk you through setting up your desk.",
  },

  {
    question: "How is Falcon different from a stock screener?",
    answer:
      "A screener filters on numbers you already knew to ask about. Falcon starts from an event and works outward: it knows which companies are tied to the one in the news and how, so it hands you names you would not have thought to screen for.",
  },
  {
    question: "Can I track my own portfolio?",
    answer:
      "Yes. Connect your brokerage and your positions come in automatically, then Falcon watches each one against the news it is already reading. Holdings refresh in the background, so the book you see is the book you hold.",
  },
  {
    question: "How often does Falcon check the news?",
    answer:
      "The feed is polled every minute, around the clock. Anything that lands is read and scored straight away, and the pass that walks it through the relationship graph runs every fifteen minutes, so a second-order signal reaches you the same hour, not the next morning.",
  },
  {
    question: "What happens when a signal turns out to be wrong?",
    answer:
      "It stays on the record. Falcon checks every signal against what the market actually did afterwards and keeps the running track record, so you see the misses next to the hits instead of a wall of calls that worked.",
  },
  {
    question: "Does Falcon cover markets outside the US?",
    answer:
      "Coverage follows SEC filings, so it is US-listed companies, including foreign ones that list here and file a 20-F. A company that never files with the SEC is not in the graph yet.",
  },
  {
    question: "Can I export a report or share it with someone?",
    answer:
      "You can select and copy anything out of the tables today. A proper report export and shareable links are on the list but not shipped, and we would rather say that than describe a button that is not there.",
  },
  {
    question: "Who is Falcon built for?",
    answer:
      "Individual traders who do their own work. People who read filings, hold real positions, and want the relationship map a desk analyst would build without the institutional price tag.",
  },
  {
    question: "What do founding members get that others won't?",
    answer:
      "Full, unlimited access to everything the product does, a discount locked on every plan we ever release, and a hand in what ships next. Founding members see new work before anyone else and tell us what is wrong with it.",
  },
  {
    question: "How do you handle my data and my watchlist?",
    answer:
      "Your watchlist and your research live with your account, so they follow you from one machine to the next. We do not sell your data and we do not trade on it; the full detail is in the privacy policy.",
  },
  {
    question: "Can I cancel or change my plan later?",
    answer:
      "Yes. You can move up a tier, move down, or cancel from your account whenever you want. The founding-member discount is tied to the account, so it carries across whichever plan you land on.",
  },
];

export default function FaqPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />

      <main className="mx-auto max-w-7xl px-6 pb-32 pt-40 sm:px-10">
        {/* Heading sits in its own column and stays put while the list scrolls. */}
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-3">
            <h1
              className="lg:sticky lg:top-32"
              style={{
                fontFamily: HEADING_FONT,
                fontWeight: 400,
                fontSize: "44px",
                lineHeight: "48px",
                color: "rgb(29, 27, 27)",
              }}
            >
              FAQ
            </h1>
          </div>

          <div className="lg:col-span-8 lg:col-start-5">
            <FaqAccordion items={ITEMS} />
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
