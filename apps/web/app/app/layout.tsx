import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Falcon",
  robots: { index: false, follow: false },
};

/** The Workspace owns the whole viewport on desktop; below 1024px it is a scrolling Today page. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-[100dvh] bg-[#fdfdfd]">{children}</div>;
}
