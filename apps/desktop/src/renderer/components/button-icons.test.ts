import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * A text button carries its words, not a pictogram beside them: "Back",
 * "Connect your portfolio", "Run now" and "Upgrade" read on their own, and a
 * lucide glyph in front of every label is one of the tells of a generated UI.
 * Icon-only buttons (an aria-label, no visible text) are what icons are for
 * and pass, as does a label that is visually hidden (`sr-only`) at some width.
 *
 * A static check over the renderer's source, one `<button>…</button>` at a
 * time: a lucide icon imported by the file, inside a button that also shows
 * text (a `t(…)` call or literal JSX text), fails unless it is one of the
 * kinds below or a known row in ALLOWED.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, "..");

/**
 * Icons that mark a state or a direction rather than decorate a label: a
 * disclosure chevron, a sort arrow, the check on the selected option, the
 * spinner on a busy button.
 */
const STATE_ICONS = new Set([
  "ChevronDown",
  "ChevronUp",
  "ChevronLeft",
  "ChevronRight",
  "ArrowDown",
  "ArrowUp",
  "Check",
  "Loader2",
]);

/** Internal tools (Shift+B, Shift+T, the theme editor, the lab panels), not product UI. */
const INTERNAL_DIRS = ["components/base/", "components/tracker/", "components/theme-editor/", "components/quantlab/", "components/screen/"];

/**
 * Menu rows and links that keep an icon on purpose, as `file icon`. A new
 * entry here is a decision, not a way to make the test pass.
 */
const ALLOWED = new Set([
  // Card and row menus: each row is an action with its glyph, like a native menu.
  "components/agents/AgentDetail.tsx Pencil",
  "components/agents/AgentDetail.tsx Trash2",
  "components/dashboard/ChartCardHeader.tsx Copy",
  "components/dashboard/ChartCardHeader.tsx X",
  "components/dashboard/NewsCard.tsx Copy",
  "components/dashboard/NewsCard.tsx X",
  "components/dashboard/PortfolioCard.tsx Copy",
  "components/dashboard/PortfolioCard.tsx X",
  "components/dashboard/ProfilePill.tsx LogOut",
  // The search pill: the field's own glyph, the way a search box shows one.
  "components/dashboard/DashboardSearchBar.tsx Search",
  // Links that leave the app, marked as such.
  "components/propagation/TargetDrawer.tsx ExternalLink",
  "components/settings/BillingPane.tsx ArrowUpRight",
  "components/settings/DeveloperPane.tsx ArrowUpRight",
  "components/settings/PrivacyPane.tsx ExternalLink",
  // Back arrows on full-page frames, and the propagation replay control.
  "components/dashboard/InsightPairFrame.tsx ArrowLeft",
  "pages/HomePage.tsx ArrowLeft",
  "components/propagation/RipplePanel.tsx Play",
  "components/propagation/RipplePanel.tsx RefreshCw",
  // A brokerage tile: its logo, and the star on the featured one.
  "components/dashboard/AddAssetModal.tsx Star",
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** `file icon` for every lucide icon sitting inside a button that also shows text. */
export function iconsInTextButtons(src: string): string[] {
  const imp = /import \{([^}]*)\} from "lucide-react"/.exec(src);
  if (!imp) return [];
  const icons = imp[1]
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, ""))
    .filter((n) => /^[A-Z]/.test(n) && n !== "LucideIcon");
  const hits: string[] = [];
  for (const m of src.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
    // The opening tag ends at the first ">" that is not an arrow function's.
    const body = m[0].replace(/^<button\b[\s\S]*?(?<!=)>/, "");
    const visible = `>${body}`
      .replace(/<span[^>]*sr-only[^>]*>[\s\S]*?<\/span>/g, ">")
      .replace(/<[A-Z]\w*[^>]*\/>/g, ">");
    const showsText = /\{t[a-zA-Z]*\(|\{say\(|>\s*[A-Za-z][^<{]*</.test(visible);
    if (!showsText) continue;
    for (const icon of icons) if (new RegExp(`<${icon}\\b`).test(body)) hits.push(icon);
  }
  return [...new Set(hits)];
}

describe("text buttons", () => {
  it("carry no decorative icon beside their label", () => {
    const problems: string[] = [];
    for (const file of sources(RENDERER)) {
      const rel = path.relative(RENDERER, file).split(path.sep).join("/");
      if (INTERNAL_DIRS.some((d) => rel.startsWith(d))) continue;
      for (const icon of iconsInTextButtons(fs.readFileSync(file, "utf8"))) {
        if (STATE_ICONS.has(icon) || ALLOWED.has(`${rel} ${icon}`)) continue;
        problems.push(`${rel} ${icon}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("catches an icon beside a label and lets an icon-only button pass", () => {
    const src = 'import { Plus, X } from "lucide-react";\n';
    assert.deepEqual(iconsInTextButtons(`${src}<button onClick={go}><Plus />{t("a.b")}</button>`), ["Plus"]);
    assert.deepEqual(iconsInTextButtons(`${src}<button onClick={() => go()}><Plus />Add</button>`), ["Plus"]);
    assert.deepEqual(iconsInTextButtons(`${src}<button aria-label={t("a.close")}><X /></button>`), []);
    assert.deepEqual(
      iconsInTextButtons(`${src}<button><Plus /><span className="max-[980px]:sr-only">{t("a.b")}</span></button>`),
      [],
    );
  });
});
