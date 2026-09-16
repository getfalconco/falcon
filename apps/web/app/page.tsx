import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import BrokerMarquee from "./components/BrokerMarquee";
import ClaudeStartupsBadge from "./components/ClaudeStartupsBadge";
import RunAnywhere from "./components/RunAnywhere";
import SiteFooter from "./components/SiteFooter";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <ClaudeStartupsBadge className="pt-24" />
      <Hero topPaddingClass="pt-8" />
      <BrokerMarquee />
      <RunAnywhere />
      <SiteFooter />
    </div>
  );
}
