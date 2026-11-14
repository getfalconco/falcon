"use client";

import { useBootTheme } from "@/lib/workspace/appearance";

/** Keeps the last theme on <html> while /app is open (also after a client-side visit) and takes it off on the way out. */
export function ThemeBoot() {
  useBootTheme();
  return null;
}
