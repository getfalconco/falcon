import { createRoot } from "react-dom/client";
import "./fonts";
import "../globals.css";
import PortfolioReturnCard from "../components/dashboard/PortfolioReturnCard";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { paperScopeKey, seedPaperAccount } from "../lib/paper-account";
import { returnTone } from "../lib/portfolio-return";

/**
 * Scratch harness for the Portfolio return card. The history is a fixture for
 * the harness only: a daily close three and a half years back sized so the
 * book has returned `?r` by today.
 *
 *   ?theme=dark      draw in that theme
 *   ?lang=tr-TR      show the card in that language
 *   ?r=-0.18         the return the fixture works out to (default 1.424)
 *   ?masked=1        privacy mode
 *   ?empty=1         nothing linked
 *   ?young=1         the record starts 40 days ago
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();

const empty = params.get("empty") === "1";
const ratio = Number(params.get("r") ?? "1.424");
const masked = params.get("masked") === "1";
const young = params.get("young") === "1";

localStorage.removeItem("falcon.ui.returnPeriod");
if (empty) {
  localStorage.removeItem("falcon.paperBalance");
  localStorage.removeItem("falcon.paperPositions");
  localStorage.removeItem(paperScopeKey("networthHistory"));
} else {
  // 48,480 today: cash, one stock and one coin, carried at cost (no quotes here).
  seedPaperAccount({
    cash: 1_000,
    positions: {
      NVDA: { symbol: "NVDA", shares: 160, costUsd: 30_000 },
      "BTC-USD": { symbol: "BTC-USD", shares: 0.16, costUsd: 17_480 },
    },
  });
  const end = 48_480;
  const start = end / (1 + ratio);
  const days = young ? 40 : 1280;
  const rows: Array<{ date: string; value: number }> = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const k = 1 - i / days;
    const p2 = (n: number) => String(n).padStart(2, "0");
    rows.push({ date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, value: start + (end - start) * k });
  }
  localStorage.setItem(paperScopeKey("networthHistory"), JSON.stringify(rows));
}

const theme = themeParam === "dark" ? "dark" : "light";
const swatches = Array.from({ length: 25 }, (_, i) => -0.6 + i * 0.05);

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-surface-0 p-8">
    <div className="flex flex-wrap items-start gap-6">
      <div className="group/card h-[320px] w-[340px]" data-testid="narrow">
        <PortfolioReturnCard masked={masked} />
      </div>
      <div className="group/card h-[320px] w-[620px]" data-testid="wide">
        <PortfolioReturnCard masked={masked} />
      </div>
    </div>
    <div className="mt-8 flex flex-wrap gap-1.5">
      {swatches.map((r) => {
        const t = returnTone(r, theme);
        return (
          <div key={r} className="flex h-16 w-16 items-end rounded-xl p-1.5 text-[10px]" style={{ background: t.background, color: t.textCss }}>
            {(r * 100).toFixed(0)}%
          </div>
        );
      })}
    </div>
  </div>,
);
