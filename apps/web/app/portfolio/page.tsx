import type { Metadata } from "next";
import Navbar from "../components/Navbar";
import Hero from "../components/Hero";
import SiteFooter from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "Portfolio tracking",
};

export default function PortfolioPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <Hero
        heading={
          // Two lines, like the home heading, so the subline sits the same
          // distance below it on every screen width.
          <>
            Your portfolio,
            <br />
            under real observation
          </>
        }
        subline="Connect your brokerages, and Falcon watches every position for the news that reaches it."
        showDemo={false}
        preview={{
          src: "/previews/portfolio.png",
          srcSet: "/previews/portfolio-1120.png 1120w, /previews/portfolio.png 1919w",
          alt: "Falcon portfolio view",
          width: 1919,
          height: 1079,
        }}
      />
      <SiteFooter />
    </div>
  );
}
