import type { Metadata } from "next";
import LegalDocument from "../components/LegalDocument";
import { LEGAL } from "@/lib/marketing-copy";

export const metadata: Metadata = {
  title: "Terms of service — Falcon",
  description: LEGAL.disclaimer,
};

export default function TermsPage() {
  return (
    <LegalDocument
      title={LEGAL.terms.title}
      updated={LEGAL.terms.updated}
      sections={LEGAL.terms.sections}
    />
  );
}
