/**
 * pnpm --filter @falcon/engine run forward-study [-- --study events-v2-nt10k] [--out FILE] [--now ISO]
 *
 * The running estimate of a forward study (src/study/forward.ts), from the
 * forecast ledger. Reads public.ripple_forecasts in a read-only transaction
 * (rows whose covariates.study is the study id; DATABASE_URL from the
 * environment or apps/web/.env.local) and daily prices from Yahoo (cached in
 * .cache/http); writes nothing to the database. With --out, the per-event
 * panel and the summary go to a JSON file.
 *
 * Method: data/preregistration/events-v2-nt10k.json. One event per event id
 * and per issuer per 30 days; measured once its 20-session window has
 * closed, with the events-v1 gate (price > $5, 20-session median dollar
 * volume >= $5M, >= 120 estimation days) and the primary column (beta x SPY,
 * L = 20, from the first open after acceptance). The bar is the events-v1 /
 * F7 bar. Before the review point the estimate is an interim look: it is
 * printed, and it decides nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { env } from "../src/env.ts";
import { plainGet, HOUR_MS } from "../src/http.ts";
import { readStudyRows } from "../src/ledger.ts";
import { addDays, eventStudy, nyseSessions, type StudySummary } from "../src/study/abnormal.ts";
import {
  alignBars,
  FORWARD_STUDIES,
  measureStudyEvent,
  nyDateOf,
  parseChart,
  reviewSample,
  runningEstimate,
  studyEventsFromLedger,
  windowClosed,
  type Aligned,
  type StudyEvent,
  type StudyMeasure,
} from "../src/study/forward.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

function chartUrl(ticker: string, from: string, to: string): string {
  const sym = ticker.replace(/\./g, "-");
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${addDays(to, 1)}T00:00:00Z`) / 1000);
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
}

async function bars(ticker: string, from: string, to: string, sessions: readonly string[]): Promise<Aligned | null> {
  try {
    const parsed = parseChart(JSON.parse(await plainGet(chartUrl(ticker, from, to), { maxAgeMs: 12 * HOUR_MS })));
    return parsed && parsed.dates.length >= 30 ? alignBars(parsed, sessions) : null;
  } catch {
    return null;
  }
}

function fmt(x: number | null | undefined, d = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(d);
}

function line(label: string, s: StudySummary | null): string {
  if (!s) return `  ${label.padEnd(34)} n 0`;
  return `  ${label.padEnd(34)} n ${String(s.n).padStart(3)}  dates ${String(s.g).padStart(3)}  mean ${fmt(s.mean).padStart(6)}%  median ${fmt(s.median).padStart(6)}%  t date ${fmt(s.byDate.t).padStart(5)}  t two-way ${fmt(s.twoWay.t).padStart(5)}${s.bootstrapP !== null ? `  bootstrap p ${fmt(s.bootstrapP, 3)}` : ""}`;
}

async function main(): Promise<number> {
  const id = arg("study") ?? FORWARD_STUDIES[0]!.id;
  const study = FORWARD_STUDIES.find((s) => s.id === id);
  if (!study) {
    console.error(`unknown study ${id}; known: ${FORWARD_STUDIES.map((s) => s.id).join(", ")}`);
    return 1;
  }
  const nowMs = arg("now") ? Date.parse(arg("now")!) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("--now must be an ISO time");
  const today = nyDateOf(new Date(nowMs).toISOString())!;
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (environment or apps/web/.env.local): the ledger cannot be read.");
    return 2;
  }

  const rows = await readStudyRows(databaseUrl, study.id);
  const { events, duplicates, unreadable } = studyEventsFromLedger(rows, study);
  console.log(`Forward study ${study.id} (${study.preregistration}), as of ${today}`);
  console.log(`  ledger: ${rows.length} rows, ${events.length} events (${duplicates} repeats within 30 days of the issuer's previous event left out${unreadable ? `, ${unreadable} rows without the study facts` : ""})`);

  const closed = events.filter((e) => windowClosed(e.acceptedAt, study.windowDays, nowMs));
  const measures = new Map<string, StudyMeasure>();
  if (closed.length) {
    const from = addDays(closed.map((e) => e.date).sort()[0]!, -420);
    const sessions = nyseSessions(from, today);
    const spy = await bars("SPY", from, today, sessions);
    if (!spy) throw new Error("SPY prices could not be read from Yahoo");
    for (const e of closed) {
      const s = await bars(e.ticker, from, today, sessions);
      measures.set(e.eventId, s ? measureStudyEvent(sessions, s, spy, e.acceptedAt, study.windowDays) : { ok: false, reason: "not_covered" });
    }
  }

  const funnel: Record<string, number> = { logged: events.length, window_open: events.length - closed.length };
  for (const m of measures.values()) {
    const k = m.ok ? "measured" : m.reason;
    funnel[k] = (funnel[k] ?? 0) + 1;
  }
  console.log(`  funnel: ${Object.entries(funnel).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  type Row = StudyEvent & { measured: boolean; m: StudyMeasure | null };
  const panel: Row[] = events.map((e) => {
    const m = measures.get(e.eventId) ?? null;
    return { ...e, measured: m?.ok === true, m };
  });
  const review = reviewSample(panel, study, today);
  const ok = (r: Row) => (r.m && r.m.ok ? r.m : null);
  const obs = (rs: Row[], f: (m: Extract<StudyMeasure, { ok: true }>) => number | null) =>
    rs.flatMap((r) => {
      const m = ok(r);
      const v = m ? f(m) : null;
      return v === null || !Number.isFinite(v) ? [] : [{ value: v, date: r.date, firm: r.cik }];
    });
  const { summary, bar } = runningEstimate(obs(review.sample, (m) => m.betaSpyPct), study);

  console.log(`\n${review.reviewDue ? "REVIEW POINT" : "Interim look (descriptive; decides nothing before the review point)"}: ${review.reason}`);
  console.log(line(`primary: beta x SPY, L = ${study.windowDays}`, summary));
  console.log(line("beta x SPY, L = 5", eventStudy(obs(review.sample, (m) => m.betaSpy5Pct))));
  console.log(line(`market-model CAR, L = ${study.windowDays}`, eventStudy(obs(review.sample, (m) => m.carPct))));
  console.log(line(`raw - SPY, L = ${study.windowDays}`, eventStudy(obs(review.sample, (m) => m.rawMinusSpyPct))));
  console.log(line("PRE (close before -> entry open)", eventStudy(obs(review.sample, (m) => m.prePct))));
  console.log(line("significant change ticked (primary)", eventStudy(obs(review.sample.filter((r) => r.significantChange === true), (m) => m.betaSpyPct))));
  console.log(`  bar (expected sign ${study.expectedSign > 0 ? "+" : "-"}, one-sided p < 0.05 two-way and by date, n >= ${study.minN}): ${bar.pass ? "met" : "not met"}${bar.why.length ? ` (${bar.why.join("; ")})` : ""}; p two-way ${fmt(bar.pTwoWay, 3)}, p date ${fmt(bar.pDate, 3)}`);
  if (review.reviewDue) console.log(`  Review due: record the result in ${study.preregistration} (consequence) and set NT10K_STUDY.status in src/study/forward.ts.`);

  const out = arg("out");
  if (out) {
    const file = path.resolve(out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ study: study.id, asOf: today, funnel, review: { due: review.reviewDue, reason: review.reason }, primary: summary, bar, panel }, null, 1)}\n`);
    console.log(`\nwritten: ${file}`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error((err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***"));
    process.exitCode = 1;
  },
);
