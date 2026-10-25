import { createRoot } from "react-dom/client";
import "../globals.css";
import "./fonts";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { toggleDemoMode } from "../lib/demo-mode";
import PortfolioValueCard from "../components/dashboard/PortfolioValueCard";

/**
 * Scratch harness for the dashboard's Net Worth card (card id "portfolio"),
 * against a stubbed main process. The book is demo mode's (Ctrl+P in the
 * app), so the balance and the chart's line agree and no provider is called.
 *
 *   ?theme=dark|light      draw in that theme
 *   ?lang=tr-TR            the card in that language
 *   ?state=empty           no account linked: the connect state
 *   ?masked=1              privacy mode
 *   ?session=regular|pre|post|closed   the session SPY's quote reports (default regular)
 *   ?tf=Hour|Day|Week|Month|Quarter|Year   the chart's window (kept, as a pick would be)
 *   ?w=px ?h=px            the card's box (default 720 by 420), the way the canvas sizes it
 */
const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();

const width = Math.max(200, Number(params.get("w") ?? 720) || 720);
const height = Math.max(200, Number(params.get("h") ?? 420) || 420);
const session = params.get("session") ?? "regular";
const tf = params.get("tf");
if (tf) localStorage.setItem("falcon.ui.chartTimeframe", tf);

(window as unknown as { meridian: unknown }).meridian = {
  getLiveQuote: async (symbol: string) =>
    symbol === "SPY" ? { ok: true, quote: { symbol, price: 571.2, session } } : { ok: false, error: "stub" },
};

if (params.get("state") !== "empty") toggleDemoMode();

const dark = document.documentElement.dataset.theme === "dark";
createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen p-8" style={{ background: dark ? "#0b0b0a" : "#EAEAE6" }}>
    <div className="[&>*]:!min-h-0" style={{ width, height }}>
      <PortfolioValueCard
        masked={params.get("masked") === "1"}
        onDuplicate={() => console.log("duplicate")}
        onRemove={() => console.log("remove")}
      />
    </div>
  </div>,
);
