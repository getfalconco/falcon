/**
 * The Ripple Engine run (v1a): events in a window, from two intakes, out as
 * tiered cards (docs/design/ripple-engine-v1.md, sections 5, 7 and 10 M1a).
 *
 *   Intake: the watched companies' earnings and monthly revenue releases
 *   (src/events.ts; event types "earnings_read_through" F10 and
 *   "monthly_revenue" F11) and every registered detector (src/detectors,
 *   `detectAll`), merged into one list of events.
 *
 *   Own-firm events (`propagates: "own"`, e.g. an insider purchase cluster)
 *   become a card whose single hit is the company itself (relation "self");
 *   no judge call.
 *
 *   Linked events walk the filing graph (src/graph.ts) and go to the judge
 *   (src/judge.ts, voted by src/vote.ts). Every event with candidates is
 *   analysed, best first, within the run's dollar cap; judging is
 *   idempotent: a stored judgment for the same (event id, candidates hash)
 *   is reused (src/ledger.ts), so a second run on the same window makes no
 *   judge call. The measured record of each hit (src/history.ts), ranking
 *   (src/rank.ts) and tiers (src/quality.ts) follow.
 *
 *   `maxCards` limits only how many cards the feed features (Measured first,
 *   then Documented, then Watch, each by score); every built hit gets a
 *   forecast row for the ledger (`RunResult.ledger`), published or not.
 */

import { bestTier, cardConfidenceOf, cardPricedIn, EVENT_TYPE_LABEL, type Confidence, type LinkEvidence, type RippleCard, type RippleEvent, type RippleHit, type SightingsFeed } from "@falcon/ripple";
import { detectAll } from "./detectors/index.ts";
import type { DetectorContext, DetectorEvent, EventSign, EventType, FamilyId } from "./detectors/types.ts";
import { detectEvents, type DetectedEvent, type DetectOptions, type EventBasis, type SourceProblem } from "./events.ts";
import { evidenceOf, loadGraph, nameOf, pathWeight, walk, type Graph, type Path } from "./graph.ts";
import { cardHistory, memoDeps, nySession, type HistoryDeps } from "./history.ts";
import { candidateFrom, judgeCostUsd, type Judge, type JudgeRequest } from "./judge.ts";
import { candidatesHash, cardSha256, covariatesOf, signPred, storedFromVote, voteFromStored, JUDGE_PROMPT_VERSION, type ForecastRow, type JudgmentStore } from "./ledger.ts";
import { assignTier, expiresAtOf, interimDocumentedFlag, loadEvidenceRegistry, loadFamilyStats, tierConfidence, tierRank, windowSessions, type EvidenceRegistry, type FamilyStats, type Liquidity, type QualityContext } from "./quality.ts";
import { callBudget, budgetSpent, voteJudge, DEFAULT_MAX_CALLS, DEFAULT_MAX_JUDGE_USD, type VoteResult, type VoteSplit } from "./vote.ts";
import { eventSize, hitScore, magnitudeFactor, NO_RECORD_STRENGTH, pathStrength, rankHits, type Coverage } from "./rank.ts";
import { sectorTickers } from "./universe.ts";
import { yahooProblems } from "./yahoo.ts";
import { cardProblems, feedProblems } from "./validate.ts";

export const ENGINE_VERSION = "ripple-v1a";

export type RunOptions = {
  sector: string;
  sinceMs: number;
  untilMs: number;
  /** Cards the feed features at most (never limits what is analysed). */
  maxCards: number;
  judge: Judge | null;
  graph?: Graph;
  log?: (line: string) => void;
  /** Kept for callers of v0; ignored (every event with candidates is analysed). */
  spareEvents?: number;
  /** Candidates per event: degree 1, then degree 2. */
  maxDegree1?: number;
  maxDegree2?: number;
  maxHitsPerCard?: number;
  /** Sources for the measured history of each hit (src/history.ts). Without them every history stays null. */
  history?: HistoryDeps | null;
  /** Why there are no history sources this run (said in the summary). */
  historyUnavailable?: string;
  /** Judge calls this run at most (src/vote.ts); default DEFAULT_MAX_CALLS. */
  maxJudgeCalls?: number;
  /** Judge dollars this run at most, from measured usage; default DEFAULT_MAX_JUDGE_USD. */
  maxJudgeUsd?: number;
  /** Analyst coverage of a hit company (src/rank.ts, coverageBoost). Without it no hit gets a coverage boost. */
  coverage?: ((ticker: string) => Promise<Coverage | null>) | null;
  /** Stored judgments (judge once). Without it every event is judged again. */
  judgments?: JudgmentStore | null;
  /** The watched companies' earnings and monthly revenue events; default src/events.ts detectEvents. */
  legacyEvents?: (opts: DetectOptions) => Promise<DetectedEvent[]>;
  /** The registered detectors; default src/detectors detectAll. Null: none. */
  detect?: ((ctx: DetectorContext) => Promise<DetectorEvent[]>) | null;
  /** Detector dollars for LLM calls this run (passed to detectors). */
  detectorBudgetUsd?: number;
  dryRun?: boolean;
  /** Price and dollar volume of a company (the liquidity gate, src/quality.ts). Without it nothing is liquid, so nothing passes Watch. */
  liquidity?: ((ticker: string) => Promise<Liquidity | null>) | null;
  /** Evidence registry and family statistics; default the files under data/. */
  registry?: EvidenceRegistry;
  familyStats?: FamilyStats;
  /** The interim Opportunities rule (design 7.3); default env OPPORTUNITIES_INTERIM_DOCUMENTED, on. */
  interimDocumented?: boolean;
};

/** What ranking did on the judged cards (src/rank.ts), for the run log and the summary. */
export type RankingReport = {
  /** Every built card, featured order; `chosen` when it made the feed. */
  cards: Array<{ eventId: string; ticker: string; score: number; nonObvious: boolean; chosen: boolean; tier?: string }>;
  /** Hits whose confidence the record lowered. */
  capped: Array<{ eventId: string; ticker: string; from: Confidence; to: Confidence; why: string }>;
  /** Hits taken off a card. */
  dropped: Array<{ eventId: string; ticker: string; why: string }>;
  /** Judged events with no hit left after ranking. */
  droppedCards: Array<{ eventId: string; ticker: string }>;
  /** Coverage read per hit company (null: not available). */
  coverage: Record<string, Coverage | null>;
};

export type RunResult = {
  feed: SightingsFeed;
  events: DetectedEvent[];
  requests: JudgeRequest[];
  /** Answers dropped by validation, with why. */
  rejected: Array<{ eventId: string; key: string; ticker: string; problems: string[] }>;
  /** Companies watched, and what could not be read (the run went on without it). */
  tickers: string[];
  sourceProblems: SourceProblem[];
  /** Yahoo trouble (EPS surprise figures missing), never fatal. */
  yahooProblems: string[];
  /** Events whose judge call failed, with why. */
  judgeFailures: Array<{ eventId: string; message: string }>;
  /** The vote on every candidate (src/vote.ts), and the calls made. */
  votes: { calls: number; maxCalls: number; splits: Array<{ eventId: string; ticker: string; votes: VoteSplit; direction: string | null; escalated: boolean }> };
  /** Hits on the chosen cards, how many got a measured history, and what could not be read. */
  history: { hits: number; measured: number; problems: string[] };
  ranking: RankingReport;
  /** Counts of what the run analysed (v1; counts only, nothing per ticker). */
  analysis?: Analysis;
  /** Forecast rows for the ledger, one per built hit (src/ledger.ts). */
  ledger?: ForecastRow[];
  /** Detector events seen this run. */
  detectorEvents?: DetectorEvent[];
};

export type Analysis = {
  /** Events from both intakes. */
  events: number;
  own: number;
  linked: number;
  /** Linked events with no filing link in the graph. */
  noLinks: number;
  /** Linked events whose stored judgment was reused (no judge call). */
  reused: number;
  /** Linked events sent to the judge this run. */
  judged: number;
  /** Linked events left for a later run (the call or dollar cap was reached). */
  backlog: number;
  /** Judge dollars this run, from measured usage. */
  costUsd: number;
  /** Built cards by tier, and how many the feed features. */
  tiers: { measured: number; documented: number; watch: number };
  featured: number;
};

export { magnitudeFactor };

/** Candidate companies for an event: the strongest direct links, then the strongest degree 2. Pure. */
export function candidatePaths(graph: Graph, ticker: string, maxDegree1 = 12, maxDegree2 = 3): Path[] {
  const paths = walk(graph, ticker, 2).filter((p) => p.ticker !== ticker);
  const byWeight = (a: Path, b: Path) => pathWeight(b) - pathWeight(a) || a.ticker.localeCompare(b.ticker);
  const d1 = paths.filter((p) => p.degree === 1).sort(byWeight).slice(0, maxDegree1);
  const d2 = paths.filter((p) => p.degree === 2).sort(byWeight).slice(0, maxDegree2);
  return [...d1, ...d2];
}

/** The event fields ranking reads (src/rank.ts). */
export type RankEvent = Pick<DetectedEvent, "magnitudePct" | "event" | "pendingAcquisition">;

export function eventScore(graph: Graph, ev: RankEvent, paths: Path[]): number {
  const linkWeight = paths
    .map(pathWeight)
    .sort((a, b) => b - a)
    .slice(0, 4)
    .reduce((s, w) => s + w, 0);
  return magnitudeFactor(ev) * linkWeight * (ev.pendingAcquisition ? 0.3 : 1);
}

// ---------------------------------------------------------------------------
// One list of events from both intakes

/** One event the run works on, whichever intake found it. */
export type RunEvent = RankEvent & {
  eventType: EventType;
  family: FamilyId;
  sign: EventSign;
  propagates: "own" | "linked";
  watchOnlyReasons: string[];
  /** History basis (v0 kinds only). */
  basis: EventBasis | null;
  /** The detector event behind it, when a detector found it. */
  detector?: DetectorEvent;
};

const FAMILY_OF: Record<"earnings_read_through" | "monthly_revenue", FamilyId> = { earnings_read_through: "F10", monthly_revenue: "F11" };

/** A v0 earnings or monthly revenue event in the v1 shape. Pure. */
export function fromLegacy(ev: DetectedEvent): RunEvent {
  const eventType = ev.basis?.kind === "monthly_revenue" ? "monthly_revenue" : "earnings_read_through";
  const sign = ev.basis?.sign ?? (ev.magnitudePct === null ? null : ev.magnitudePct > 0 ? 1 : ev.magnitudePct < 0 ? -1 : 0);
  return {
    event: { ...ev.event, eventType, eventLabel: EVENT_TYPE_LABEL[eventType], acceptedAt: ev.event.acceptedAt ?? ev.filing.acceptedAt ?? ev.event.occurredAt },
    magnitudePct: ev.magnitudePct,
    pendingAcquisition: ev.pendingAcquisition,
    eventType,
    family: FAMILY_OF[eventType],
    sign,
    propagates: "linked",
    watchOnlyReasons: [],
    basis: ev.basis,
  };
}

const GUIDANCE: ReadonlySet<EventType> = new Set(["guidance_down", "guidance_up"]);

/** A detector event in the v1 shape; null when it has no ticker or no source (no card can carry it). Pure. */
export function fromDetector(de: DetectorEvent): RunEvent | null {
  if (!de.ticker || !de.sources.length || !de.title.trim()) return null;
  const [source, ...rest] = de.sources;
  const event: RippleEvent = {
    id: de.id,
    ticker: de.ticker,
    companyName: de.companyName,
    kind: GUIDANCE.has(de.eventType) ? "guidance" : "filing",
    headline: de.title,
    occurredAt: de.acceptedAt,
    summary: de.summary.join(" "),
    source: source!,
    ...(de.quotes.length ? { facts: de.quotes.slice(0, 6) } : {}),
    ...(rest.length ? { sources: rest } : {}),
    eventType: de.eventType,
    eventLabel: EVENT_TYPE_LABEL[de.eventType] ?? de.eventType,
    acceptedAt: de.acceptedAt,
  };
  return {
    event,
    magnitudePct: de.magnitude,
    pendingAcquisition: false,
    eventType: de.eventType,
    family: de.family,
    sign: de.sign,
    propagates: de.propagates,
    watchOnlyReasons: de.watchOnlyReasons,
    basis: null,
    detector: de,
  };
}

// ---------------------------------------------------------------------------
// Own-firm cards (templated text only; no judge)

/** The window an own-firm family's effect is measured over (design 3.2). */
const OWN_WINDOW: Partial<Record<FamilyId, string>> = { F6: "1 to 5 trading days", F7: "1 to 4 weeks", F8: "1 to 4 weeks" };

/** Mechanism sentences per event type; `{name}` is the company. Information only, no numbers. */
const OWN_MECHANISM: Partial<Record<EventType, string>> = {
  insider_cluster: "{name}'s own officers or directors reported open-market purchases of its shares on Form 4. The card follows {name} itself.",
  distress_nt: "{name} told the SEC it could not file a periodic report on time, a filed risk item for holders of {name}.",
  restatement_402: "{name} reported that earlier financial statements can no longer be relied on, a filed risk item for holders of {name}.",
  activist_stake: "An investor filed a Schedule 13D on {name}, reporting a large stake and its stated purpose. The card follows {name} itself.",
};

const OWN_INVALIDATED_BY: Partial<Record<EventType, string>> = {
  insider_cluster: "Later Form 4 filings showing the same insiders selling these shares would undo this reading.",
  distress_nt: "The late report filed within the extension period with no change in results would undo this reading.",
  restatement_402: "A restatement limited to presentation, with no change in reported revenue or earnings, would weaken this reading.",
  activist_stake: "An amended 13D reporting a sale of the stake would undo this reading.",
};

function nyDate(iso: string): string {
  return nySession(Date.parse(iso)).date;
}

/**
 * One own-firm card per company and event type in a run: a director's single
 * purchase and the cluster it belongs to are one story, not two cards. Keeps
 * the largest event (magnitude, then the later one, then the id). Pure.
 */
export function dedupeOwnByCompany<T extends { eventType: string; magnitudePct: number | null; event: { ticker: string; occurredAt: string; id: string } }>(items: T[]): T[] {
  const best = new Map<string, T>();
  const better = (a: T, b: T): boolean => {
    const ma = a.magnitudePct ?? Number.NEGATIVE_INFINITY;
    const mb = b.magnitudePct ?? Number.NEGATIVE_INFINITY;
    if (ma !== mb) return ma > mb;
    if (a.event.occurredAt !== b.event.occurredAt) return a.event.occurredAt > b.event.occurredAt;
    return a.event.id < b.event.id;
  };
  for (const it of items) {
    const key = `${it.event.ticker}|${it.eventType}`;
    const cur = best.get(key);
    if (!cur || better(it, cur)) best.set(key, it);
  }
  const keep = new Set(best.values());
  return items.filter((i) => keep.has(i));
}

/** The filed quotes of an own-firm event as link evidence (at most 5). Pure. */
export function ownEvidence(de: DetectorEvent): LinkEvidence[] {
  const aligned = de.sources.length === de.quotes.length;
  const out: LinkEvidence[] = [];
  de.quotes.forEach((quote, i) => {
    if (quote.trim().length < 20 || out.length >= 5) return;
    const src = (aligned ? de.sources[i] : undefined) ?? de.sources[0]!;
    out.push({ quote, form: de.form, filedAt: nyDate(src.publishedAt ?? de.acceptedAt), url: src.url });
  });
  return out;
}

function directionOf(sign: EventSign): RippleHit["direction"] {
  return sign === 1 ? "up" : sign === -1 ? "down" : "unclear";
}

/**
 * The card of an own-firm event: one hit, the company itself, direction
 * from the event's sign (bad news is a risk to holders, never a call to
 * act), tier from src/quality.ts. Null with why when it cannot carry a card.
 * Pure.
 */
export function ownFirmCard(
  item: RunEvent,
  p: { sector: string; generatedAt: string; liquidity: Liquidity | null; quality: QualityContext },
): { card: RippleCard; score: number; why: string[] } | { error: string } {
  const de = item.detector;
  if (!de) return { error: "not a detector event" };
  const evidence = ownEvidence(de);
  if (evidence.length === 0) return { error: "no filed quote of 20 characters or more" };
  const direction = directionOf(item.sign);
  const t = assignTier(
    { family: item.family, direction, relation: "self", liquidity: p.liquidity, pricedIn: false, watchOnlyReasons: item.watchOnlyReasons, linkTier: null, quoted: true },
    p.quality,
  );
  const confidence = tierConfidence(t.tier);
  const name = de.companyName;
  const mechanism = (OWN_MECHANISM[item.eventType] ?? "This filing is about {name} itself. The card follows {name}.").replaceAll("{name}", name);
  const score = hitScore({ link: "disclosed", record: NO_RECORD_STRENGTH, confidence, size: eventSize(item), direction });
  const window = OWN_WINDOW[item.family] ?? "1 to 4 weeks";
  const hit: RippleHit = {
    ticker: item.event.ticker,
    companyName: name,
    relation: "self",
    degree: 1,
    direction,
    confidence,
    window,
    mechanism,
    evidence,
    history: null,
    sinceEvent: null,
    pricedIn: false,
    score,
    scoreReason: t.tier === "documented" ? "Filed by the company or its insiders; published research documents this kind of filing." : "Filed by the company or its insiders; no measured record yet.",
    opportunityEligible: t.opportunityEligible,
    tier: t.tier,
    family: item.family,
    channel: "own_firm",
    linkClarity: "direct",
    ...(t.documentedBy ? { documentedBy: t.documentedBy } : {}),
    ...(OWN_INVALIDATED_BY[item.eventType] ? { invalidatedBy: OWN_INVALIDATED_BY[item.eventType] } : {}),
  };
  const card: RippleCard = {
    id: `${p.sector}-${item.event.id}`,
    event: item.event,
    hits: [hit],
    sector: p.sector,
    generatedAt: p.generatedAt,
    confidence: cardConfidenceOf([hit]),
    pricedIn: false,
    tier: t.tier,
    expiresAt: expiresAtOf(p.generatedAt, [window]),
  };
  return { card, score, why: t.why };
}

/** The deterministic channel of a linked hit (display; design 3.2). Pure. */
export function channelOf(relation: RippleHit["relation"]): string {
  return relation === "customer" || relation === "supplier" ? "supply_chain" : relation === "competitor" ? "competitor" : relation === "self" ? "own_firm" : "partner";
}

// ---------------------------------------------------------------------------
// The run

export async function runSightings(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  const graph = opts.graph ?? loadGraph();
  const names = (t: string) => nameOf(graph, t);
  const tickers = sectorTickers(opts.sector);
  const universe = new Set(tickers);
  const generatedAt = new Date().toISOString();
  const quality: QualityContext = {
    registry: opts.registry ?? loadEvidenceRegistry(undefined, log),
    stats: opts.familyStats ?? loadFamilyStats(undefined, log),
    interimDocumented: opts.interimDocumented ?? interimDocumentedFlag(),
  };

  log(`events: ${tickers.length} companies, ${new Date(opts.sinceMs).toISOString()} to ${new Date(opts.untilMs).toISOString()}`);
  const sourceProblems: SourceProblem[] = [];
  const events = await (opts.legacyEvents ?? detectEvents)({ tickers, sinceMs: opts.sinceMs, untilMs: opts.untilMs, log, problems: sourceProblems });
  let detectorEvents: DetectorEvent[] = [];
  if (opts.detect !== null) {
    const ctx: DetectorContext = { since: new Date(opts.sinceMs), until: new Date(opts.untilMs), llmBudgetUsd: opts.detectorBudgetUsd ?? 0, dryRun: opts.dryRun === true, log };
    try {
      detectorEvents = await (opts.detect ?? ((c) => detectAll(c)))(ctx);
    } catch (err) {
      log(`  detectors failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(`detectors: ${detectorEvents.length} events`);
  }

  const items: RunEvent[] = [];
  const seen = new Set<string>();
  for (const it of [...events.map(fromLegacy), ...detectorEvents.map(fromDetector)]) {
    if (!it || seen.has(it.event.id)) continue;
    seen.add(it.event.id);
    items.push(it);
  }
  const skippedDetector = detectorEvents.length - items.filter((i) => i.detector).length;
  if (skippedDetector > 0) log(`  ${skippedDetector} detector events without a ticker or source, or repeated: no card`);
  const ownAll = items.filter((i) => i.propagates === "own");
  const own = dedupeOwnByCompany(ownAll);
  if (own.length < ownAll.length) log(`  ${ownAll.length - own.length} own-firm events folded into a larger event of the same kind at the same company`);
  const linked = items.filter((i) => i.propagates === "linked");

  // Liquidity per company, read once (never fatal).
  const liquidityCache = new Map<string, Promise<Liquidity | null>>();
  const liquidityOf = (t: string): Promise<Liquidity | null> => {
    if (!opts.liquidity) return Promise.resolve(null);
    if (!liquidityCache.has(t)) liquidityCache.set(t, opts.liquidity(t).catch(() => null));
    return liquidityCache.get(t)!;
  };
  const sectorOf = (ticker: string) => (universe.has(ticker) ? opts.sector : "all");

  // Linked events: rank by size and graph links; analyse every one that has candidates.
  const ranked = linked
    .map((ev) => {
      const paths = candidatePaths(graph, ev.event.ticker, opts.maxDegree1, opts.maxDegree2);
      return { ev, paths, score: paths.length ? eventScore(graph, ev, paths) : 0 };
    })
    .filter((r) => r.paths.length > 0)
    .sort((a, b) => b.score - a.score || a.ev.event.id.localeCompare(b.ev.event.id));
  const noLinks = linked.length - ranked.length;
  if (noLinks) log(`  ${noLinks} linked events have no filing links in the graph: no card`);

  const requests: JudgeRequest[] = ranked.map(({ ev, paths }) => ({
    eventId: ev.event.id,
    event: {
      ticker: ev.event.ticker,
      companyName: ev.event.companyName,
      kind: ev.event.kind,
      headline: ev.event.headline,
      occurredAt: ev.event.occurredAt,
      summary: ev.event.summary,
      ...(ev.event.facts ? { facts: ev.event.facts } : {}),
    },
    candidates: paths.map((p, i) => candidateFrom(p, `C${i + 1}`, names)),
  }));

  const rejected: RunResult["rejected"] = [];
  const judgeFailures: RunResult["judgeFailures"] = [];
  const judged: Array<{ ev: RunEvent; hits: Array<{ hit: RippleHit; path: Path }> }> = [];
  const spent = () => (opts.judge?.usage ? judgeCostUsd(opts.judge.usage) : 0);
  const budget = callBudget(opts.maxJudgeCalls ?? DEFAULT_MAX_CALLS, { maxUsd: opts.maxJudgeUsd ?? DEFAULT_MAX_JUDGE_USD, spentUsd: spent });
  const votes: RunResult["votes"] = { calls: 0, maxCalls: budget.max, splits: [] };
  const analysis: Analysis = { events: items.length, own: own.length, linked: linked.length, noLinks, reused: 0, judged: 0, backlog: 0, costUsd: 0, tiers: { measured: 0, documented: 0, watch: 0 }, featured: 0 };

  for (let i = 0; i < ranked.length; i++) {
    const { ev, paths } = ranked[i]!;
    const req = requests[i]!;
    const hash = candidatesHash(req);
    let voted: VoteResult | null = null;
    if (opts.judgments) {
      try {
        const stored = await opts.judgments.get(ev.event.id, hash);
        if (stored) {
          voted = voteFromStored(stored);
          analysis.reused++;
        }
      } catch (err) {
        log(`  judgment store unreadable (${err instanceof Error ? err.message : String(err)}); judging again`);
      }
    }
    if (!voted) {
      if (!opts.judge) continue;
      if (budgetSpent(budget)) {
        analysis.backlog++;
        continue;
      }
      const before = spent();
      analysis.judged++;
      try {
        voted = await voteJudge(opts.judge, req, budget);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        judgeFailures.push({ eventId: ev.event.id, message });
        log(`  judge failed on ${ev.event.id}: ${message}`);
        continue;
      }
      if (opts.judgments) {
        try {
          await opts.judgments.put(storedFromVote(ev.event.id, hash, voted, [opts.judge.name], opts.judge.usage ? Math.round((spent() - before) * 1e4) / 1e4 : null));
        } catch (err) {
          log(`  judgment not stored (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    for (const d of voted.discarded) {
      const idx = req.candidates.findIndex((c) => c.key === d.key);
      rejected.push({ eventId: req.eventId, key: d.key, ticker: paths[idx]?.ticker ?? d.key, problems: d.problems });
    }
    for (const x of voted.splits) {
      const ticker = paths[req.candidates.findIndex((c) => c.key === x.key)]?.ticker ?? x.key;
      votes.splits.push({ eventId: req.eventId, ticker, votes: x.votes, direction: x.direction, escalated: x.escalated });
    }
    const hits: Array<{ hit: RippleHit; path: Path }> = [];
    for (const { answer: ok, votes: split } of voted.hits) {
      const idx = req.candidates.findIndex((c) => c.key === ok.key);
      const path = paths[idx];
      if (!path) continue;
      const evidence = path.edges.map(evidenceOf).filter((e) => e.quote && e.url);
      if (evidence.length === 0) continue;
      hits.push({ path, hit: {
        ticker: path.ticker,
        companyName: names(path.ticker),
        relation: path.relation,
        degree: path.degree,
        ...(path.via ? { via: path.via } : {}),
        direction: ok.direction,
        confidence: ok.confidence,
        window: ok.window,
        mechanism: ok.mechanism,
        evidence,
        history: null,
        sinceEvent: null,
        pricedIn: false,
        votes: { up: split.up, down: split.down, unclear: split.unclear, excluded: split.excluded },
        ...(ok.linkClarity ? { linkClarity: ok.linkClarity } : {}),
      } });
    }
    if (hits.length === 0) {
      log(`  ${ev.event.ticker}: no hit passed validation, no card`);
      continue;
    }
    judged.push({ ev, hits });
  }
  if (analysis.backlog) log(`  judge cap reached: ${analysis.backlog} events left for the next run`);

  votes.calls = budget.used;
  analysis.costUsd = Math.round(spent() * 1e4) / 1e4;

  // History for every judged card, before ranking: the record ranks, caps and filters hits.
  const history: RunResult["history"] = { hits: 0, measured: 0, problems: [] };
  if (opts.historyUnavailable) history.problems.push(opts.historyUnavailable);
  if (opts.history && judged.length) {
    const deps = memoDeps({ ...opts.history, log: opts.history.log ?? log });
    log("history: past events like each card's, and how each hit moved after them");
    for (const { ev, hits } of judged) {
      const draft: RippleCard = { id: `${opts.sector}-${ev.event.id}`, event: ev.event, hits: hits.map((x) => x.hit), sector: opts.sector, generatedAt };
      try {
        for (const r of await cardHistory(draft, ev.basis ?? null, deps)) {
          const hit = hits.find((x) => x.hit.ticker === r.ticker)?.hit;
          if (!hit) continue;
          if (r.history) hit.history = r.history;
          if (r.since) {
            hit.sinceEvent = r.since.sinceEvent;
            hit.pricedIn = r.since.pricedIn;
          }
        }
      } catch (err) {
        const message = `${ev.event.ticker}: ${err instanceof Error ? err.message : String(err)}`;
        history.problems.push(message);
        log(`  history ${message}; its hits keep no history`);
      }
    }
  }

  // Coverage of every hit company, when a source is given (never fatal).
  const coverage = new Map<string, Coverage | null>();
  if (opts.coverage) {
    for (const t of [...new Set(judged.flatMap((j) => j.hits.map((x) => x.hit.ticker)))].sort()) {
      try {
        coverage.set(t, await opts.coverage(t));
      } catch {
        coverage.set(t, null);
      }
    }
  }

  const ranking: RankingReport = { cards: [], capped: [], dropped: [], droppedCards: [], coverage: Object.fromEntries(coverage) };
  const cards: Array<{ card: RippleCard; score: number; nonObvious: boolean; ev: RunEvent }> = [];
  const droppedHits: Array<{ ev: RunEvent; hit: RippleHit }> = [];
  for (const { ev, hits } of judged) {
    const r = rankHits(ev, hits, (t) => coverage.get(t) ?? null, opts.maxHitsPerCard ?? 5);
    for (const c of r.capped) ranking.capped.push({ eventId: ev.event.id, ...c });
    for (const d of r.dropped) {
      ranking.dropped.push({ eventId: ev.event.id, ...d });
      const h = hits.find((x) => x.hit.ticker === d.ticker);
      if (h) droppedHits.push({ ev, hit: { ...h.hit, tier: "watch", family: ev.family } });
    }
    if (r.hits.length === 0) {
      ranking.droppedCards.push({ eventId: ev.event.id, ticker: ev.event.ticker });
      log(`  ${ev.event.ticker}: no hit left after ranking, no card`);
      continue;
    }
    // Tiers (src/quality.ts): the old opportunityEligible is replaced by the tier rule.
    const kept: RippleHit[] = [];
    for (const { hit, path } of r.hits) {
      const t = assignTier(
        {
          family: ev.family,
          direction: hit.direction,
          relation: hit.relation,
          liquidity: await liquidityOf(hit.ticker),
          pricedIn: hit.pricedIn === true,
          watchOnlyReasons: ev.watchOnlyReasons,
          linkTier: pathStrength(path).tier,
          quoted: hit.evidence.length >= path.edges.length,
        },
        quality,
      );
      kept.push({
        ...hit,
        tier: t.tier,
        family: ev.family,
        channel: channelOf(hit.relation),
        opportunityEligible: t.opportunityEligible && hit.direction !== "unclear" && hit.pricedIn !== true,
        ...(t.documentedBy ? { documentedBy: t.documentedBy } : {}),
      });
    }
    const card: RippleCard = {
      id: `${sectorOf(ev.event.ticker)}-${ev.event.id}`,
      event: ev.event,
      hits: kept,
      sector: sectorOf(ev.event.ticker),
      generatedAt,
      // Card confidence: the highest among its kept hits with an implied way (README, "What reaches the user").
      confidence: cardConfidenceOf(kept),
      pricedIn: cardPricedIn({ hits: kept }),
      tier: bestTier(kept) ?? "watch",
      expiresAt: expiresAtOf(generatedAt, kept.map((h) => h.window)),
    };
    const problems = cardProblems(card);
    if (problems.length) {
      log(`  ${ev.event.ticker}: card failed the contract check: ${problems.join("; ")}`);
      continue;
    }
    cards.push({ card, score: r.score, nonObvious: r.nonObvious, ev });
  }

  // Own-firm cards.
  for (const ev of own) {
    const built = ownFirmCard(ev, { sector: sectorOf(ev.event.ticker), generatedAt, liquidity: await liquidityOf(ev.event.ticker), quality });
    if ("error" in built) {
      log(`  ${ev.event.id}: ${built.error}, no card`);
      continue;
    }
    const problems = cardProblems(built.card);
    if (problems.length) {
      log(`  ${ev.event.id}: card failed the contract check: ${problems.join("; ")}`);
      continue;
    }
    cards.push({ card: built.card, score: built.score, nonObvious: false, ev });
  }

  // Featured order: tier first (Measured, Documented, Watch), then score, then the later event, then the id.
  cards.sort(
    (a, b) =>
      tierRank(b.card.tier) - tierRank(a.card.tier) ||
      b.score - a.score ||
      b.card.event.occurredAt.localeCompare(a.card.event.occurredAt) ||
      a.card.id.localeCompare(b.card.id),
  );
  const chosen = cards.slice(0, opts.maxCards).map((c) => c.card);
  ranking.cards = cards.map((c, i) => ({ eventId: c.card.event.id, ticker: c.card.event.ticker, score: c.score, nonObvious: c.nonObvious, chosen: i < opts.maxCards, tier: c.card.tier }));
  history.hits = chosen.reduce((n, c) => n + c.hits.length, 0);
  history.measured = chosen.reduce((n, c) => n + c.hits.filter((h) => h.history !== null).length, 0);
  for (const c of cards) analysis.tiers[c.card.tier ?? "watch"]++;
  analysis.featured = chosen.length;

  // Ledger: one forecast row per built hit, published or not, and per hit ranking dropped.
  const judgeName = opts.judge?.name ?? "none";
  const modelVersion = (ev: RunEvent) => (ev.propagates === "own" ? `${ENGINE_VERSION}/own` : `${ENGINE_VERSION}/${judgeName}/${JUDGE_PROMPT_VERSION}`);
  const ledger: ForecastRow[] = [];
  cards.forEach((c, i) => {
    const sha = cardSha256(c.card);
    for (const h of c.card.hits) {
      ledger.push({
        event_id: c.card.event.id,
        card_id: c.card.id,
        ticker: h.ticker,
        tier: h.tier ?? "watch",
        family: h.family ?? c.ev.family,
        sign_pred: signPred(h.direction),
        window_days: windowSessions(h.window),
        covariates: covariatesOf(h, { eventType: c.ev.eventType, magnitudePct: c.ev.magnitudePct, eventSign: c.ev.sign }),
        model_version: modelVersion(c.ev),
        card_sha256: sha,
        published: i < opts.maxCards,
      });
    }
  });
  for (const { ev, hit } of droppedHits) {
    ledger.push({
      event_id: ev.event.id,
      card_id: `${sectorOf(ev.event.ticker)}-${ev.event.id}`,
      ticker: hit.ticker,
      tier: "watch",
      family: ev.family,
      sign_pred: signPred(hit.direction),
      window_days: windowSessions(hit.window),
      covariates: covariatesOf(hit, { eventType: ev.eventType, magnitudePct: ev.magnitudePct, eventSign: ev.sign, dropped: true }),
      model_version: modelVersion(ev),
      card_sha256: null,
      published: false,
    });
  }

  const feed: SightingsFeed = {
    generatedAt,
    cards: chosen,
    meta: {
      engine: ENGINE_VERSION,
      judge: judgeName,
      sector: opts.sector,
      since: new Date(opts.sinceMs).toISOString(),
      until: new Date(opts.untilMs).toISOString(),
    },
  };
  const problems = feedProblems(feed);
  if (problems.length) throw new Error(`feed failed the contract check: ${problems.join("; ")}`);
  return { feed, events, requests, rejected, tickers, sourceProblems, yahooProblems: yahooProblems(), judgeFailures, votes, history, ranking, analysis, ledger, detectorEvents };
}
