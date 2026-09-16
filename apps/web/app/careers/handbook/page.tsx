import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "../../components/Navbar";
import SiteFooter from "../../components/SiteFooter";

export const metadata: Metadata = {
  title: "Jobs ops handbook",
};

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";

const SECTIONS = [
  {
    title: "Open / close a cycle",
    body: "Applications write into the open internship_cycles row. Keep one cycle open at a time. Closing is done in Supabase (set status=closed) until the admin UI gains a cycle toggle.",
  },
  {
    title: "Score Stage 2",
    body: "In Admin → Internships, open a submitted applicant. Use the department task rubric. Pass advances them; Fail rejects. Notes are stored on the application.",
  },
  {
    title: "Run interviews",
    body: "Add 15-minute slots (America/New_York by default). Invite candidates after a Pass. They book from /careers/portal/[token]. Founders run the call; the system only schedules.",
  },
  {
    title: "Accept an intern",
    body: "After interview_booked (or interview_done), Accept creates an internship_interns row and emails the intern panel link at /careers/intern/[token]. Assign tasks from the Interns tab.",
  },
  {
    title: "Accounts & ownership",
    body: "All tooling runs on Falcon’s Netlify + Supabase. Candidate/intern portals use opaque tokens — no candidate root ownership of infra. Contractor access should be collaborator-only on Falcon-owned accounts (Madde 9).",
  },
];

export default function JobsHandbookPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <main className="mx-auto max-w-3xl px-6 pb-28 pt-32 sm:px-10">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
          Internal · handover
        </p>
        <h1 className="mt-4 text-[36px] leading-[44px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          Running an internship cycle
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-[#4b4b48]" style={{ fontFamily: GEIST }}>
          Written so someone who didn&rsquo;t build the system can still open a cohort end-to-end.
          Public entry:{" "}
          <Link href="/careers" className="underline">
            /jobs
          </Link>
          . Admin:{" "}
          <Link href="/admin/dashboard/jobs" className="underline">
            /admin/dashboard/jobs
          </Link>
          .
        </p>
        <ol className="mt-12 space-y-8">
          {SECTIONS.map((s, i) => (
            <li key={s.title}>
              <p className="text-[11px] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
                {String(i + 1).padStart(2, "0")}
              </p>
              <h2 className="mt-1 text-[20px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
                {s.title}
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-[#4b4b48]" style={{ fontFamily: GEIST }}>
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </main>
      <SiteFooter />
    </div>
  );
}
