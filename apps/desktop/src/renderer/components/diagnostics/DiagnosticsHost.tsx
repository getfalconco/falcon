import { useState } from "react";
import { useShortcut } from "@/lib/use-shortcuts";
import DiagnosticsPanel from "./DiagnosticsPanel";

/**
 * Global Shift+H toggle for the diagnostics panel (rebindable in Settings →
 * Shortcuts). Mounted once at the root like the other debug hosts
 * (Shift+T/B/P/R/S/F); nothing in the product UI links to it. Exists to verify a packaged build: provider key routing and
 * engine bootstrap differ between dev and the shipped exe.
 */
export default function DiagnosticsHost() {
  const [open, setOpen] = useState(false);

  useShortcut("diagnostics", () => setOpen((v) => !v));

  if (!open) return null;
  return <DiagnosticsPanel onClose={() => setOpen(false)} />;
}
