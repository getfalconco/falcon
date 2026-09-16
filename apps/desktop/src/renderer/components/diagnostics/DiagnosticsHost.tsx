import { useEffect, useState } from "react";
import DiagnosticsPanel from "./DiagnosticsPanel";

/**
 * Global Shift+H toggle for the diagnostics panel. Mounted once at the root
 * like the other debug hosts (Shift+T/B/P/R/S/F); nothing in the product UI
 * links to it. Exists to verify a packaged build: provider key routing and
 * engine bootstrap differ between dev and the shipped exe.
 */
export default function DiagnosticsHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const isH = event.code === "KeyH" || event.key.toLowerCase() === "h";
      if (!isH) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;
  return <DiagnosticsPanel onClose={() => setOpen(false)} />;
}
