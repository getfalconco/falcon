import type { Metadata } from "next";
import LegalDocument from "../components/LegalDocument";
import { LEGAL } from "@/lib/marketing-copy";

export const metadata: Metadata = {
  title: "Privacy policy — Falcon",
  description: LEGAL.disclaimer,
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      title={LEGAL.privacy.title}
      updated={LEGAL.privacy.updated}
      sections={LEGAL.privacy.sections}
    />
  );
}
