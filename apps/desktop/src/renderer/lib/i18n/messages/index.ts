import type { LanguageCode } from "../languages";
import { en as coreEn } from "./en";
import { tr } from "./tr";
import { de } from "./de";
import { fr } from "./fr";
import { es } from "./es";
import { it } from "./it";
import { ptBR } from "./pt-BR";
import { ja } from "./ja";
import { zhCN } from "./zh-CN";
import { ko } from "./ko";
import { AREA_EN, areaTable } from "./areas";

/**
 * English, whole: the core table plus every area file (`./areas`). This is
 * the source every other language falls back to, key by key.
 */
export const en = { ...coreEn, ...AREA_EN };

export type MessageKey = keyof typeof en;

/** A full table: every key, in one language. */
export type Messages = Record<MessageKey, string>;

/**
 * Every language's table, by code. English is complete by construction; the
 * others are typed `Partial` so a key added to English never breaks the build
 * before it is translated (it reads in English until then), and the i18n test
 * is what reports a table that has fallen behind.
 */
export const MESSAGES: Readonly<Record<LanguageCode, Partial<Messages>>> = {
  "en-US": en,
  "tr-TR": { ...tr, ...areaTable("tr-TR") },
  "de-DE": { ...de, ...areaTable("de-DE") },
  "fr-FR": { ...fr, ...areaTable("fr-FR") },
  "es-ES": { ...es, ...areaTable("es-ES") },
  "it-IT": { ...it, ...areaTable("it-IT") },
  "pt-BR": { ...ptBR, ...areaTable("pt-BR") },
  "ja-JP": { ...ja, ...areaTable("ja-JP") },
  "zh-CN": { ...zhCN, ...areaTable("zh-CN") },
  "ko-KR": { ...ko, ...areaTable("ko-KR") },
};
