import { useEffect, useState } from "react";
import { useShortcut } from "@/lib/use-shortcuts";
import GaugePanel from "./GaugePanel";

/**
 * Global Shift+F toggle for the Gauge panel (spec §8 — "pre-Flight"; the
 * spec's Shift+G is taken by the relationship graph in HomePage). Mounted
 * once at the root, reachable from any screen and ONLY by this shortcut —
 * like Shift+T / Shift+B / Shift+A / Shift+P / Shift+R, nothing in the
 * product UI links to it. Debug-grade; the product surfaces are the
 * Propagation drawer block and the stock page block. The key can be moved in
 * Settings → Shortcuts.
 *
 * Other instrument panels may ask for a readout on a ticker by dispatching a
 * `falcon:gauge-open` window event `{ticker, mode?: "standalone"}` (the Screen
 * panel does); the panel opens on that ticker.
 */
export default function GaugeHost() {
  const [open, setOpen] = useState(false);
  const [ticker, setTicker] = useState<string | null>(null);

  useShortcut("gauge", () => setOpen((v) => !v));

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ ticker?: string }>).detail;
      const t = typeof detail?.ticker === "string" ? detail.ticker.trim().toUpperCase() : "";
      if (t) setTicker(t);
      setOpen(true);
    };
    window.addEventListener("falcon:gauge-open", onOpen);
    return () => window.removeEventListener("falcon:gauge-open", onOpen);
  }, []);

  if (!open) return null;
  return <GaugePanel key={ticker ?? "default"} initialTicker={ticker ?? undefined} onClose={() => setOpen(false)} />;
}
