/**
 * Messages for the settings panes that are not in the core table (Privacy,
 * Usage, System, Notifications, Appearance, Engines, Shortcuts), in every
 * language. Kept as two parts per language under
 * ./settings/ so no one file has to hold all of them; merged here into the
 * shape every area file has. English is the source; the other tables are
 * Partial and fall back to English per key. Same rules as messages/en.ts:
 * `{name}` placeholders kept in every language, and no em dash or en dash
 * anywhere (shared/copy-rules.ts).
 */
import { en as en1 } from "./settings/en-1";
import { en as en2 } from "./settings/en-2";
import * as p1 from "./settings/part-1";
import * as p2 from "./settings/part-2";

export const en = { ...en1, ...en2 };

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = { ...p1.tr, ...p2.tr };
export const de: Table = { ...p1.de, ...p2.de };
export const fr: Table = { ...p1.fr, ...p2.fr };
export const es: Table = { ...p1.es, ...p2.es };
export const it: Table = { ...p1.it, ...p2.it };
export const ptBR: Table = { ...p1.ptBR, ...p2.ptBR };
export const ja: Table = { ...p1.ja, ...p2.ja };
export const zhCN: Table = { ...p1.zhCN, ...p2.zhCN };
export const ko: Table = { ...p1.ko, ...p2.ko };
