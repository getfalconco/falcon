import type { Metadata, Viewport } from "next";
import { APP_HOST_METADATA, APP_HOST_VIEWPORT } from "@/lib/pwa";

export const metadata: Metadata = {
  ...APP_HOST_METADATA,
  title: "Falcon",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = APP_HOST_VIEWPORT;

/**
 * The Workspace owns the whole viewport on desktop; below 1024px it is a scrolling Today page.
 * The installed app draws edge to edge (viewport-fit=cover), so the page keeps clear of the
 * notch, the rounded corners and the home indicator.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-[#fdfdfd] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:pb-0">
      {children}
    </div>
  );
}
