import type { Metadata } from "next";
import LoginPageClient from "./LoginPageClient";

export const metadata: Metadata = {
  title: "Log in — Falcon",
  description: "Log in to your Falcon account.",
};

export default function LoginPage() {
  return <LoginPageClient />;
}
