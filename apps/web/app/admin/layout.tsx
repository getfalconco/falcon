import type { Metadata } from "next";
import "../auth-theme.css";

export const metadata: Metadata = {
  title: "Admin — Falcon",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-theme auth-theme-light auth-theme-admin min-h-screen font-sans text-[#111111] antialiased">
      {children}
    </div>
  );
}
