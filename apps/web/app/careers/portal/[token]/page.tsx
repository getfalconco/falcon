import Navbar from "../../../components/Navbar";
import SiteFooter from "../../../components/SiteFooter";
import CandidatePortal from "./CandidatePortal";

export default async function JobsPortalPage({
  params,
}: {
  params: { token: string };
}) {
  const { token } = params;
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <main className="mx-auto max-w-2xl px-6 pb-28 pt-32 sm:px-10">
        <CandidatePortal token={token} />
      </main>
      <SiteFooter />
    </div>
  );
}
