import type { Metadata } from "next";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import StoryHero from "../components/story/StoryHero";
import DeskInfrastructure from "../components/story/DeskInfrastructure";
import {
  FalconRebuildSection,
  DifferentFromAiSection,
  MissionSection,
  StoryCtaSection,
} from "../components/story/MissionSection";
import { SEO } from "@/lib/marketing-copy";

export const metadata: Metadata = {
  title: "Story — Falcon",
  description: SEO.description,
};

export default function StoryPage() {
  return (
    <div className="min-h-screen bg-[#090909] text-white">
      <Navbar />
      <main className="pt-[6.75rem] sm:pt-[7.25rem]">
        <StoryHero />
        <DeskInfrastructure />
        <FalconRebuildSection />
        <DifferentFromAiSection />
        <MissionSection />
        <StoryCtaSection />
      </main>
      <Footer />
    </div>
  );
}
