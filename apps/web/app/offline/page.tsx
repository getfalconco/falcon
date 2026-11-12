import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "You're offline",
  robots: { index: false, follow: false },
};

/**
 * What the installed app shows when a page can't load without a connection
 * (served from the service worker cache). Inline styles only, so it renders
 * even when no stylesheet is cached.
 */
export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fdfdfd",
        color: "#1d1b1b",
        padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>You&apos;re offline</h1>
    </main>
  );
}
