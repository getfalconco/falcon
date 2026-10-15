import type { Metadata } from "next";
import LegalDocument from "../components/LegalDocument";
import { PRIVACY_INTRO, PRIVACY_SECTIONS } from "./content";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What personal data Falcon collects through its desktop application, website and early-access programme, why, who receives it, and your rights.",
};

export default function PrivacyPage() {
  return <LegalDocument title="Privacy Policy" intro={PRIVACY_INTRO} sections={PRIVACY_SECTIONS} />;
}
