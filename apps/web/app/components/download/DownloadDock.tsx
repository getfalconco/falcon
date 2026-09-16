"use client";

import MacOSDock from "@/components/ui/mac-os-dock";

// The desktop-at-a-glance nod: a handful of familiar macOS apps with Falcon
// sitting among them, already "running". Icons come from the same CDN the
// component's demo ships with; Falcon uses our own brand mark.
const DOCK_APPS = [
  // Everything except Falcon is set dressing: it magnifies but ignores clicks.
  {
    id: "finder",
    name: "Finder",
    icon: "https://cdn.jim-nielsen.com/macos/1024/finder-2021-09-10.png?rf=1024",
    inert: true,
  },
  {
    id: "safari",
    name: "Safari",
    icon: "https://cdn.jim-nielsen.com/macos/1024/safari-2021-06-02.png?rf=1024",
    inert: true,
  },
  {
    id: "photos",
    name: "Photos",
    icon: "https://cdn.jim-nielsen.com/macos/1024/photos-2021-05-28.png?rf=1024",
    inert: true,
  },
  {
    id: "falcon",
    name: "Falcon",
    icon: "/brand/falcon-dock-tile.png?v=3",
  },
  {
    id: "notes",
    name: "Notes",
    icon: "https://cdn.jim-nielsen.com/macos/1024/notes-2021-05-25.png?rf=1024",
    inert: true,
  },
  {
    id: "terminal",
    name: "Terminal",
    icon: "https://cdn.jim-nielsen.com/macos/1024/terminal-2021-06-03.png?rf=1024",
    inert: true,
  },
  {
    id: "mail",
    name: "Mail",
    icon: "https://cdn.jim-nielsen.com/macos/1024/mail-2021-05-25.png?rf=1024",
    inert: true,
  },
];

export default function DownloadDock() {
  // Falcon is the only clickable app; the click just bounces it, the
  // "running" dot stays lit.
  const openApps = ["falcon"];

  const handleAppClick = () => {};

  return (
    <MacOSDock
      apps={DOCK_APPS}
      onAppClick={handleAppClick}
      openApps={openApps}
    />
  );
}
