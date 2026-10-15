import { useState } from "react";
import { useShortcut } from "@/lib/use-shortcuts";
import BasePanel, { type BasePanelView } from "./BasePanel";

/**
 * Global Shift+B / Shift+A toggles for the Base Engine panel. Mounted once at
 * the root, reachable from any screen and ONLY by these shortcuts — like
 * Shift+T for the Tracker, nothing in the product UI links to it. Shift+B
 * opens on the incidents view; Shift+A opens straight on the analyst tab
 * (Analyst spec §9). Either key closes an open panel. Both can be rebound in
 * Settings → Shortcuts.
 */
export default function BaseHost() {
  const [open, setOpen] = useState<BasePanelView | null>(null);

  useShortcut("base", () => setOpen((current) => (current ? null : "incidents")));
  useShortcut("analyst", () => setOpen((current) => (current ? null : "analyst")));

  if (!open) return null;
  return <BasePanel key={open} initialView={open} onClose={() => setOpen(null)} />;
}
