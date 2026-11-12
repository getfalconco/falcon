/**
 * The Ripple Engine v0 run: events in a window, the companies the filing
 * graph links them to, a judged direction and mechanism for each, and the
 * strongest cards out as a SightingsFeed.
 */

import type { Confidence, RippleCard, RippleHit, SightingsFeed } from "@falcon/ripple";
import { detectEvents, type DetectedEvent, type SourceProblem } from "./events.ts";
import { evidenceOf, loadGraph, nameOf, pathWeight, walk, type Graph, type Path } from "./graph.ts";
import { candidateFrom, checkAnswer, type Judge, type JudgeRequest } from "./judge.ts";
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
};

/**
 * How much an event's size counts. An EPS surprise is measured against a
 * consensus; a monthly revenue change is not (no estimate to beat), so it
 * counts for less per point. Pure.
 */
export function magnitudeFactor(ev: Pick<DetectedEvent, "magnitudePct" | "event">): number {
  const m = ev.magnitudePct === null ? 0 : Math.abs(ev.magnitudePct);
  if (ev.event.kind === "filing") return 1 + Math.min(m, 60) / 60;
  return 1 + Math.min(m, 30) / 10;
}

/**
 * A judged card's rank: the event's size times what its validated hits
 * carry (judged confidence, halved for "unclear", times the strength of the
 * filing link). Candidates the judge left out count for nothing. Pure.
 */
export function cardScore(ev: Pick<DetectedEvent, "magnitudePct" | "event" | "pendingAcquisition">, hits: Array<{ hit: RippleHit; path: Path }>): number {
  const carried = hits.reduce((s, { hit, path }) => s + CONF[hit.confidence] * (hit.direction === "unclear" ? 0.5 : 1) * pathWeight(path), 0);
  return magnitudeFactor(ev) * carried * (ev.pendingAcquisition ? 0.3 : 1);
}

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

const CONF: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function sortHits(a: RippleHit, b: RippleHit): number {
  const dir = (h: RippleHit) => (h.direction === "unclear" ? 0 : 1);
  return CONF[b.confidence] - CONF[a.confidence] || dir(b) - dir(a) || a.degree - b.degree || a.ticker.localeCompare(b.ticker);
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
  const cards: Array<{ card: RippleCard; score: number }> = [];
  if (opts.judge) {
    for (let i = 0; i < toJudge.length; i++) {
      const { ev, paths } = toJudge[i]!;
      const req = requests[i]!;
      let raw: unknown;
      try {
        raw = await opts.judge.judge(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        judgeFailures.push({ eventId: ev.event.id, message });
        log(`  judge failed on ${ev.event.id}: ${message}`);
        continue;
      }
      const answers = Array.isArray((raw as { hits?: unknown })?.hits) ? ((raw as { hits: unknown[] }).hits) : [];
      const hits: Array<{ hit: RippleHit; path: Path }> = [];
      for (const a of answers) {
        const ok = checkAnswer(req, a);
        if (!ok) continue;
        const idx = req.candidates.findIndex((c) => c.key === ok.key);
        const path = paths[idx]!;
        if (ok.problems.length) {
          rejected.push({ eventId: req.eventId, key: ok.key, ticker: path.ticker, problems: ok.problems });
          continue;
        }
        if (!ok.include) continue;
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
        } });
      }
      if (hits.length === 0) {
        log(`  ${ev.event.ticker}: no hit passed validation, no card`);
        continue;
      }
      hits.sort((a, b) => sortHits(a.hit, b.hit) || pathWeight(b.path) - pathWeight(a.path));
      const keptPairs = hits.slice(0, opts.maxHitsPerCard ?? 5);
      const kept = keptPairs.map((x) => x.hit);
      const card: RippleCard = {
        id: `${opts.sector}-${ev.event.id}`,
        event: ev.event,
        hits: kept,
        sector: opts.sector,
        generatedAt,
      };
      const problems = cardProblems(card);
      if (problems.length) {
        log(`  ${ev.event.ticker}: card failed the contract check: ${problems.join("; ")}`);
        continue;
      }
      cards.push({ card, score: cardScore(ev, keptPairs) });
    }
  }

  const chosen = cards.sort((a, b) => b.score - a.score).slice(0, opts.maxCards).map((c) => c.card);
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
  return { feed, events, requests, rejected, tickers, sourceProblems, yahooProblems: yahooProblems(), judgeFailures };
}
