import { Component, useState, type ReactNode } from "react";
import { getLanguage, type MessageKey } from "@/lib/i18n";
import { translate, type MessageVars } from "@/lib/i18n/translate";
import { shortcutText } from "@/lib/shortcuts";
import { useShortcut } from "@/lib/use-shortcuts";

/** A class component cannot use the hook; it reads the language when it renders. */
const tr = (key: MessageKey, vars?: MessageVars) => translate(getLanguage(), key, vars);
import RiskPanel from "./RiskPanel";

/**
 * Global Shift+R toggle for the Risk Engine panel (spec §7), rebindable in
 * Settings → Shortcuts. Mounted once at the root, reachable from any screen and ONLY by this shortcut — like Shift+T
 * (Tracker), Shift+B/A (Base/Analyst) and Shift+P (Propagation), nothing in
 * the product UI links to it. Debug-grade; the dashboard card is the product
 * surface and is designed separately.
 */

/**
 * These panels are mounted as siblings of <App/>, so a render error inside one
 * unmounts the whole tree — the window goes white and the dashboard goes with
 * it. A debug surface must never be able to do that: the boundary keeps the
 * failure inside the panel and says what to do about it.
 */
class PanelBoundary extends Component<{ onClose: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[risk] panel render failed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-ink/30 backdrop-blur-[3px]">
        <div className="w-[560px] max-w-[92vw] rounded-2xl border border-red-200 bg-white p-5 shadow-2xl">
          <div className="font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary">{tr("panels.risk.header", { shortcut: shortcutText("risk") })}</div>
          <div className="mt-2 font-baskerville text-[15px] text-content-primary">{tr("panels.risk.boundary.title")}</div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-1 p-2 font-mono text-[10px] text-red-700">
            {this.state.error.message}
          </pre>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-lg border border-edge px-3 py-1.5 text-[11px] text-content-primary"
            >
              {tr("panels.risk.boundary.retry")}
            </button>
            <button type="button" onClick={this.props.onClose} className="rounded-lg bg-ink px-3 py-1.5 text-[11px] text-white">
              {tr("panels.risk.boundary.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default function RiskHost() {
  const [open, setOpen] = useState(false);

  useShortcut("risk", () => setOpen((v) => !v));

  if (!open) return null;
  const close = () => setOpen(false);
  return (
    <PanelBoundary onClose={close}>
      <RiskPanel onClose={close} />
    </PanelBoundary>
  );
}
