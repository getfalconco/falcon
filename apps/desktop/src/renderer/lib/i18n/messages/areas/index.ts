import type { LanguageCode } from "../../languages";
import * as settings from "./settings";
import * as plans from "./plans";
import * as changelog from "./changelog";
import * as shell from "./shell";
import * as dashboard from "./dashboard";
import * as stock from "./stock";
import * as briefing from "./briefing";
import * as agents from "./agents";
import * as calendar from "./calendar";
import * as panels from "./panels";
import * as auth from "./auth";
import * as system from "./system";
import * as developer from "./developer";
import * as instruments from "./instruments";
import * as earnings from "./earnings";
import * as access from "./access";
import * as stocktab from "./stocktab";
import * as exposure from "./exposure";
import * as readthrough from "./readthrough";
import * as insiders from "./insiders";
import * as filings from "./filings";
import * as guidance from "./guidance";
import * as implied from "./implied";
import * as estimates from "./estimates";
import * as today from "./today";
import * as econ from "./econ";

/**
 * Per-area message files, merged onto the core tables in `../index.ts`. One
 * file per area so translation work on different parts of the app never
 * edits the same file. A new area: add a file shaped like the others and list
 * it here.
 */
const AREAS = [settings, plans, changelog, shell, dashboard, stock, briefing, agents, calendar, panels, instruments, auth, system, developer, earnings, access, stocktab, exposure, readthrough, insiders, filings, guidance, implied, estimates, today, econ] as const;

export const AREA_EN = {
  ...settings.en,
  ...plans.en,
  ...changelog.en,
  ...shell.en,
  ...dashboard.en,
  ...stock.en,
  ...briefing.en,
  ...agents.en,
  ...calendar.en,
  ...panels.en,
  ...instruments.en,
  ...auth.en,
  ...system.en,
  ...developer.en,
  ...earnings.en,
  ...access.en,
  ...stocktab.en,
  ...exposure.en,
  ...readthrough.en,
  ...insiders.en,
  ...filings.en,
  ...guidance.en,
  ...implied.en,
  ...estimates.en,
  ...today.en,
  ...econ.en,
};

type AreaTable = Partial<Record<keyof typeof AREA_EN, string>>;

const FIELD: Record<Exclude<LanguageCode, "en-US">, "tr" | "de" | "fr" | "es" | "it" | "ptBR" | "ja" | "zhCN" | "ko"> = {
  "tr-TR": "tr",
  "de-DE": "de",
  "fr-FR": "fr",
  "es-ES": "es",
  "it-IT": "it",
  "pt-BR": "ptBR",
  "ja-JP": "ja",
  "zh-CN": "zhCN",
  "ko-KR": "ko",
};

/** Every area's table for one language, merged. */
export function areaTable(code: Exclude<LanguageCode, "en-US">): AreaTable {
  const field = FIELD[code];
  return Object.assign({}, ...AREAS.map((a) => a[field])) as AreaTable;
}
