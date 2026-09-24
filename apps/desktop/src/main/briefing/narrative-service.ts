/**
 * Handover briefing: the model-written narrative and stories, asked for after
 * the report.
 *
 * The report ships at once with a template narrative, template stories and
 * `pending: true`; the renderer then asks here for the model version of
 * exactly that report. The request names the report by target session and
 * facts hash, and the facts are rebuilt from the stored report, never taken
 * from the renderer: what is sent to the model provider is decided in this
 * process alone. One model call writes the lead and the stories together, and
 * the two are stored, served and swapped as one.
 *
 * Electron-free: store, model caller and clock are injected.
 */

import {
  buildNarrativeFacts,
  generateNarrative,
  templateNarrative,
  type NarrativeCaller,
  type NarrativeFacts,
} from "@meridian/research/briefing";
import type { BriefingNarrative, BriefingNarrativeResult, BriefingReport, Story } from "../../shared/briefing-types";
import { BriefingStore, narrativeBudget, type ReportKey } from "./briefing-store";
import { parseNarrativeRequest } from "./request";

export type NarrativeServiceDeps = {
  store: BriefingStore;
  userKey: () => string;
  modelConfigured: () => boolean;
  caller: NarrativeCaller;
  model: () => string;
  /** The machine's clock. A developer-clock report never reaches this service. */
  realNowMs: () => number;
};

/** What one ask settles on: the lead and the stories the panel shows under it. */
type Settled = { narrative: BriefingNarrative; stories: Story[] };

/** A report stored before stories existed has none; the panel is given an empty list, not a crash. */
function storiesOf(report: Pick<BriefingReport, "stories"> | undefined): Story[] {
  return report && Array.isArray(report.stories) ? report.stories : [];
}

export function createNarrativeService(deps: NarrativeServiceDeps): {
  getNarrative(raw: unknown): Promise<BriefingNarrativeResult>;
} {
  /** The card and the panel both ask as soon as they see `pending`; they share one model call. */
  const inFlight = new Map<string, Promise<Settled>>();

  /**
   * The stored report is rewritten with whatever was settled on, template
   * included. Left as it was, it would keep telling every reader that a model
   * version is on its way, and each of them would come back here to ask.
   * `stories` null means the report keeps its own: nothing was written to
   * replace them.
   */
  const settle = (key: ReportKey, report: BriefingReport, narrative: BriefingNarrative, stories: Story[] | null): Settled => {
    const settled = { ...narrative, pending: false };
    try {
      deps.store.replaceNarrative(key, settled, stories ?? undefined);
    } catch (err) {
      console.warn("[briefing] stored narrative not updated:", err instanceof Error ? err.message : String(err));
    }
    return { narrative: settled, stories: stories ?? storiesOf(report) };
  };

  const generate = async (
    userKey: string,
    targetYmd: string,
    factsHash: string,
    key: ReportKey,
    report: BriefingReport,
    facts: NarrativeFacts,
  ): Promise<Settled> => {
    const startedMs = deps.realNowMs();
    const nowIso = new Date(startedMs).toISOString();

    if (!deps.modelConfigured()) return settle(key, report, templateNarrative(facts, nowIso, factsHash, "model is not configured"), null);

    const budget = narrativeBudget(deps.store.narrativeSession(userKey, targetYmd), startedMs);
    if (!budget.allowed) return settle(key, report, templateNarrative(facts, nowIso, factsHash, budget.reason), null);

    deps.store.noteGeneration(userKey, targetYmd, startedMs);
    // The stored report's own stories are the templates the rewrites are
    // spliced over: rebuilt from the facts they would come back undated and
    // without their figure chips, which the facts do not carry.
    const { narrative, stories } = await generateNarrative(facts, deps.caller, {
      model: deps.model(),
      now: nowIso,
      factsHash,
      templateStories: storiesOf(report),
    });

    // Only a model paragraph is worth keeping, and the stories go with it: the
    // template is rebuilt for free from the same facts, and storing it would
    // make a transient model failure the permanent answer for this hash.
    if (narrative.source === "model") deps.store.putNarrative(userKey, targetYmd, factsHash, narrative, deps.realNowMs(), stories);
    return settle(key, report, narrative, stories);
  };

  return {
    async getNarrative(raw) {
      try {
        const req = parseNarrativeRequest(raw);
        if (req === null) return { ok: false, error: "invalid_request" };

        const userKey = deps.userKey();
        const { target_session_ymd: targetYmd, facts_hash: factsHash } = req;

        const known = deps.store.getNarrative(userKey, targetYmd, factsHash);
        if (known) {
          // The stories kept beside the paragraph, else the stored report's
          // own: a paragraph kept before stories existed has none beside it.
          const stories =
            deps.store.getStories(userKey, targetYmd, factsHash) ??
            storiesOf(deps.store.findReportByFacts(userKey, targetYmd, factsHash)?.stored.report);
          return { ok: true, narrative: { ...known, pending: false }, stories };
        }

        // Only a report this process stored can be narrated. A demo report is
        // never stored and a developer-clock one is stored out of reach, which
        // is what keeps both away from the model without a flag to forget.
        const found = deps.store.findReportByFacts(userKey, targetYmd, factsHash);
        if (found === null) return { ok: false, error: "not_found" };
        const { key, stored } = found;
        if (stored.report.demo || stored.report.synthetic_now) return { ok: false, error: "not_found" };

        let facts: NarrativeFacts;
        try {
          facts = buildNarrativeFacts(stored.report);
        } catch {
          // The report was stored with the stand-in narrative for exactly this
          // case; there are no facts to write another from.
          return { ok: true, narrative: { ...stored.report.narrative, pending: false }, stories: storiesOf(stored.report) };
        }

        const flightKey = `${userKey}:${targetYmd}:${factsHash}`;
        let task = inFlight.get(flightKey);
        if (!task) {
          task = generate(userKey, targetYmd, factsHash, key, stored.report, facts).finally(() => inFlight.delete(flightKey));
          inFlight.set(flightKey, task);
        }
        const { narrative, stories } = await task;
        return { ok: true, narrative, stories };
      } catch (err) {
        console.warn("[briefing] narrative failed:", err instanceof Error ? err.message : String(err));
        return { ok: false, error: "unavailable" };
      }
    },
  };
}
