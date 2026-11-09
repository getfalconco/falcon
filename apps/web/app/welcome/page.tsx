import type { Metadata } from "next";
import WelcomeFlow from "./WelcomeFlow";

export const metadata: Metadata = {
  title: "Welcome · Falcon",
  description: "Set up Falcon around what you care about.",
  robots: { index: false, follow: false },
};

export default function WelcomePage() {
  return <WelcomeFlow />;
}
