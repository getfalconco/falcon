/**
 * Classifier §13 evaluation gate — two subcommands.
 *
 *   sample  Build a labeling sheet from the Phase A shadow log: N verdicted
 *           articles sampled stratified by (ticker, source), written as JSONL
 *           with the verdict pre-filled as the proposed label. The strategy
 *           side edits `expected`, Kuzey spot-checks ~20 random rows, and the
 *           result is the labeled set.
 *
 *   report  Score the verdict store against a labeled set and print each gate
 *           metric against the configured threshold.
 *
 * Usage:
 *   pnpm --filter @meridian/research exec tsx scripts/classifier-eval.ts sample [--n 120] [--out <file>]
 *   pnpm --filter @meridian/research exec tsx scripts/classifier-eval.ts report <labeled.jsonl>
 *
 * Neither subcommand calls a model: verdicts come from the verdict store on
 * disk (FALCON_CLASSIFIER_DATA_DIR or apps/desktop/data/classifier).
 */

import fs from "node:fs";
import path from "node:path";
import { loadBaseConfig } from "../src/base/store.js";
import { buildClassificationRequests } from "../src/base/classification.js";
import { resolveTrackerDataDir, TrackerStore } from "../src/tracker/store.js";
import {
  ClassifierConfigStore,
  CompanyMetadataStore,
  FileBackend,
  VerdictStore,
  evaluateClassifier,
  formatEvalReport,
  loadLabeledSet,
  type LabeledArticle,
} from "../src/classifier/index.js";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  const configStore = new ClassifierConfigStore();
  const config = configStore.load();
  const verdicts = new VerdictStore(new FileBackend(configStore.dataDir));

  if (sub === "report") {
    const file = process.argv[3];
    if (!file) throw new Error("usage: report <labeled.jsonl>");
    const labeled = loadLabeledSet(file);
    const report = await evaluateClassifier(
      labeled,
      (req) => verdicts.latestFor(req.article?.article_key ?? req.filing?.article_key ?? ""),
      config,
    );
    console.log(formatEvalReport(report));
    if (report.misses.length) {
      console.log(`\nMisses (${report.misses.length}):`);
      for (const m of report.misses.slice(0, 50)) {
        console.log(`  ${m.article_key} ${m.ticker ?? "-"} ${m.field}: expected ${m.expected}, got ${m.got}`);
      }
    }
    process.exitCode = report.pass ? 0 : 1;
    return;
  }

  if (sub === "sample") {
    const n = Number(arg("--n", "120"));
    const out = arg("--out", path.join(configStore.dataDir, "eval-set.draft.jsonl"))!;
    const tracker = new TrackerStore(resolveTrackerDataDir());
    const messages = tracker.readMessages({ limit: 20000 });
    const metadata = new CompanyMetadataStore(configStore.metadataFile);
    const now = new Date().toISOString();
    const { requests } = buildClassificationRequests(messages, {
      config: loadBaseConfig(),
      tickerContext: (t) => metadata.context(t),
      existingVerdict: () => null, // every article, as a lead with its full ticker set
      now,
    });

    // Keep only articles that already have an ok verdict, then stratify by
    // (first ticker, source) round-robin so no single feed dominates the sheet.
    const buckets = new Map<string, LabeledArticle[]>();
    for (const req of requests) {
      const key = req.article?.article_key ?? req.filing?.article_key ?? "";
      const v = verdicts.latestFor(key);
      if (!v || v.status !== "ok") continue;
      const stratum = `${req.tickers[0]?.ticker ?? "?"}|${req.article?.source ?? "filing"}`;
      const row: LabeledArticle = {
        request: req,
        expected: {
          event_type: v.event_type,
          tickers: v.tickers.map((t) =>
            t.relevance === "none"
              ? { ticker: t.ticker, relevance: "none" as const }
              : { ticker: t.ticker, relevance: t.relevance, materiality: t.materiality, direction: t.direction },
          ),
        },
        labeled_by: "prefill:verdict",
        spot_checked: false,
      };
      const list = buckets.get(stratum) ?? [];
      list.push(row);
      buckets.set(stratum, list);
    }
    const strata = [...buckets.values()];
    const sheet: LabeledArticle[] = [];
    let i = 0;
    while (sheet.length < n && strata.some((s) => s.length > 0)) {
      const s = strata[i % strata.length];
      const row = s.shift();
      if (row) sheet.push(row);
      i += 1;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, sheet.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    console.log(`wrote ${sheet.length} rows across ${strata.length} strata → ${out}`);
    console.log("Edit `expected` per row (prefilled from the verdict), set spot_checked on the audited rows, then run: report <file>");
    return;
  }

  console.log("usage: classifier-eval.ts sample [--n 120] [--out file] | report <labeled.jsonl>");
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
