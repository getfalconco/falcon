import type { Metadata } from "next";
import LegalDocument from "../components/LegalDocument";
import { TERMS_INTRO, TERMS_SECTIONS } from "./content";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that govern Falcon's desktop application, website and early-access programme, including its usage policy.",
};

export default function TermsPage() {
  return <LegalDocument title="Terms of Service" intro={TERMS_INTRO} sections={TERMS_SECTIONS} />;
}
