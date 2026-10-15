import path from "node:path";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { invokeChannel, registerIpcHandler } from "../ipc-register";
import { resolveDataRoot } from "../data-root";
import { getMainLanguage, isMainLanguage } from "../i18n";
import { graphEdges } from "../research/graph-edges";
import { relationshipLines } from "./news-analysis";
import { VERDICTS_LIMIT, createNewsArticleService } from "./news-article-service";
import type { ClassifierVerdict } from "../../shared/classifier-types";

/**
 * The news panel's IPC: `news:article` (the text), `news:article-reading`
 * (the server classifier's verdict) and `news:article-analysis` (Falcon's
 * read when there is no verdict, or when the reader asks for it after the
 * verdict lookup failed). All local channels: the page fetch and the
 * model call happen in this process, with the key that already lives here,
 * and the verdict lookup goes through `invokeChannel`, which asks the engine
 * when one is configured and the local classifier otherwise.
 */

const service = createNewsArticleService({
  dataDir: () => path.join(resolveDataRoot(), "news"),
  listVerdicts: async () => {
    const res = await invokeChannel<{ ok: true; verdicts: ClassifierVerdict[] } | { ok: false; error: string }>(
      "classifier:verdicts",
      { limit: VERDICTS_LIMIT },
    );
    if (!res || !res.ok) throw new Error(res && !res.ok ? res.error : "no answer from the classifier");
    // A malformed answer is a failed lookup, not an empty one: "no verdict"
    // may lead to a paid read, so it has to come from a list the server sent.
    if (!Array.isArray(res.verdicts)) throw new Error("malformed verdict list from the classifier");
    return res.verdicts;
  },
  relationships: async (tickers) => relationshipLines(await graphEdges(), tickers),
  caller: anthropicGlossCaller,
  configured: glossConfigured,
  language: getMainLanguage,
  isLanguage: isMainLanguage,
});

export function registerNewsArticleHandlers(): void {
  registerIpcHandler("news:article", (_event, request: unknown) => service.body(request));
  registerIpcHandler("news:article-reading", (_event, request: unknown) => service.reading(request));
  registerIpcHandler("news:article-analysis", (_event, request: unknown) =>
    service.analysis((request ?? {}) as Parameters<typeof service.analysis>[0]),
  );
}
