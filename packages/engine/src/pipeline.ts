/**
 * The Ripple Engine v0 run: events in a window, the companies the filing
 * graph links them to, a judged direction and mechanism for each, the
 * measured record of each hit, and the strongest cards out as a
 * SightingsFeed. Hits and cards are capped, filtered and ordered by
 * src/rank.ts (formula: README.md, "Ranking").
 */

import { cardConfidenceOf, cardPricedIn, type Confidence, type RippleCard, type RippleHit, type SightingsFeed } from "@falcon/ripple";
import { detectEvents, type DetectedEvent, type SourceProblem } from "./events.ts";
import { evidenceOf, loadGraph, nameOf, pathWeight, walk, type Graph, type Path } from "./graph.ts";
import { cardHistory, memoDeps, type HistoryDeps } from "./history.ts";
import { candidateFrom, type Judge, type JudgeRequest } from "./judge.ts";
import { callBudget, voteJudge, DEFAULT_MAX_CALLS, type VoteSplit } from "./vote.ts";
import { magnitudeFactor, rankHits, type Coverage } from "./rank.ts";
import { sectorTickers } from "./universe.ts";
import { yahooProblems } from "./yahoo.ts";
import { cardProblems, feedProblems } from "./validate.ts";

export const ENGINE_VERSION = "ripple-v0";

export type RunOptions = {
  sector: string;
  sinceMs: number;
  untilMs: number;
  maxCards: number;
  judge: Judge | null;
  graph?: Graph;
  log?: (line: string) => void;
  /** Events to judge beyond maxCards, so a card that loses all its hits can be replaced. */
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
  /** Analyst coverage of a hit company (src/rank.ts, coverageBoost). Without it no hit gets a coverage boost. */
  coverage?: ((ticker: string) => Promise<Coverage | null>) | null;
};

/** What ranking did on the judged cards (src/rank.ts), for the run log and the summary. */
export type RankingReport = {
  /** Every judged card that kept a hit, best first; `chosen` when it made the feed. */
  cards: Array<{ eventId: string; ticker: string; score: number; nonObvious: boolean; chosen: boolean }>;
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

export function eventScore(graph: Graph, ev: DetectedEvent, paths: Path[]): number {
  const linkWeight = paths
    .map(pathWeight)
    .sort((a, b) => b - a)
    .slice(0, 4)
    .reduce((s, w) => s + w, 0);
  return magnitudeFactor(ev) * linkWeight * (ev.pendingAcquisition ? 0.3 : 1);
}

export async function runSightings(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  const graph = opts.graph ?? loadGraph();
  const names = (t: string) => nameOf(graph, t);
  const tickers = sectorTickers(opts.sector);
  const generatedAt = new Date().toISOString();

  log(`events: ${tickers.length} companies, ${new Date(opts.sinceMs).toISOString()} to ${new Date(opts.untilMs).toISOString()}`);
  const sourceProblems: SourceProblem[] = [];
  const events = await detectEvents({ tickers, sinceMs: opts.sinceMs, untilMs: opts.untilMs, log, problems: sourceProblems });

  // Rank events by size and by how strongly the graph links them out.
  const ranked = events
    .map((ev) => {
      const paths = candidatePaths(graph, ev.event.ticker, opts.maxDegree1, opts.maxDegree2);
      return { ev, paths, score: paths.length ? eventScore(graph, ev, paths) : 0 };
    })
    .filter((r) => r.paths.length > 0)
    .sort((a, b) => b.score - a.score);
  for (const r of events.filter((e) => !ranked.some((x) => x.ev === e))) log(`  ${r.event.ticker}: no filing links in the graph, no card`);

  const toJudge = ranked.slice(0, opts.maxCards + (opts.spareEvents ?? 2));
  const requests: JudgeRequest[] = toJudge.map(({ ev, paths }) => ({
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
  const judged: Array<{ ev: DetectedEvent; hits: Array<{ hit: RippleHit; path: Path }> }> = [];
  const budget = callBudget(opts.maxJudgeCalls ?? DEFAULT_MAX_CALLS);
  const votes: RunResult["votes"] = { calls: 0, maxCalls: budget.max, splits: [] };
  if (opts.judge) {
    for (let i = 0; i < toJudge.length; i++) {
      const { ev, paths } = toJudge[i]!;
      const req = requests[i]!;
      let voted;
      try {
        voted = await voteJudge(opts.judge, req, budget);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        judgeFailures.push({ eventId: ev.event.id, message });
        log(`  judge failed on ${ev.event.id}: ${message}`);
        continue;
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
        const path = paths[idx]!;
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
        } });
      }
      if (hits.length === 0) {
        log(`  ${ev.event.ticker}: no hit passed validation, no card`);
        continue;
      }
      judged.push({ ev, hits });
    }
  }

  votes.calls = budget.used;

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
  const cards: Array<{ card: RippleCard; score: number; nonObvious: boolean }> = [];
  for (const { ev, hits } of judged) {
    const r = rankHits(ev, hits, (t) => coverage.get(t) ?? null, opts.maxHitsPerCard ?? 5);
    for (const c of r.capped) ranking.capped.push({ eventId: ev.event.id, ...c });
    for (const d of r.dropped) ranking.dropped.push({ eventId: ev.event.id, ...d });
    if (r.hits.length === 0) {
      ranking.droppedCards.push({ eventId: ev.event.id, ticker: ev.event.ticker });
      log(`  ${ev.event.ticker}: no hit left after ranking, no card`);
      continue;
    }
    const kept = r.hits.map((x) => x.hit);
    const card: RippleCard = {
      id: `${opts.sector}-${ev.event.id}`,
      event: ev.event,
      hits: kept,
      sector: opts.sector,
      generatedAt,
      // Card confidence: the highest among its kept hits with an implied way (README, "What reaches the user").
      confidence: cardConfidenceOf(kept),
      pricedIn: cardPricedIn({ hits: kept }),
    };
    const problems = cardProblems(card);
    if (problems.length) {
      log(`  ${ev.event.ticker}: card failed the contract check: ${problems.join("; ")}`);
      continue;
    }
    cards.push({ card, score: r.score, nonObvious: r.nonObvious });
  }

  // Best first; a tie goes to the later event, then the id, so the order is stable.
  cards.sort((a, b) => b.score - a.score || b.card.event.occurredAt.localeCompare(a.card.event.occurredAt) || a.card.id.localeCompare(b.card.id));
  const chosen = cards.slice(0, opts.maxCards).map((c) => c.card);
  ranking.cards = cards.map((c, i) => ({ eventId: c.card.event.id, ticker: c.card.event.ticker, score: c.score, nonObvious: c.nonObvious, chosen: i < opts.maxCards }));
  history.hits = chosen.reduce((n, c) => n + c.hits.length, 0);
  history.measured = chosen.reduce((n, c) => n + c.hits.filter((h) => h.history !== null).length, 0);

  const feed: SightingsFeed = {
    generatedAt,
    cards: chosen,
    meta: {
      engine: ENGINE_VERSION,
      judge: opts.judge?.name ?? "none",
      sector: opts.sector,
      since: new Date(opts.sinceMs).toISOString(),
      until: new Date(opts.untilMs).toISOString(),
    },
  };
  const problems = feedProblems(feed);
  if (problems.length) throw new Error(`feed failed the contract check: ${problems.join("; ")}`);
  return { feed, events, requests, rejected, tickers, sourceProblems, yahooProblems: yahooProblems(), judgeFailures, votes, history, ranking };
}
