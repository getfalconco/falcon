import { filingAcceptedMs } from "@meridian/research/edgar-time";
import type { Agent, AgentLine, AgentTrigger, AgentTriggerKind } from "../../shared/agent-types";
import type { AgentEngineState } from "./store";
import type { AgentDataSources, FilingRef, InsiderTxn, MacroEventRead, NewsItem } from "./sources";
import { DAY_MS, HOUR_MS, MINUTE_MS, addDaysYmd, daysBetween, isEdgarOpen, isRegularSession, nyInstant, nyParts, nyYmd } from "./time";
import { checkLinked, type LinkedHit } from "./linked";
import { checkFilingChanges, deferredToChanges, type ChangesHit } from "./filing-changes";
import type { FilingChanges } from "../../shared/filing-changes";

/**
 * When does a trigger fire? One function per trigger kind, each answering
 * from `AgentDataSources` alone, so every rule here runs in a test against a
 * fake clock and fake data.
 *
 * A check returns either an event (with a dedupe key: the same event never
 * fires twice) or "waiting" with two lines: `note`, stable wording for the
 * timeline (so repeated checks coalesce into one entry), and `detail`, the
 * status line with the latest numbers. Each also says when it is worth
 * looking again, which is how the scheduler paces itself: every ten minutes
 * on the day a company reports, twice a day the month before.
 *
 * Both lines also come as codes (`noteLines`, `detailLines`, see `AgentLine`
 * in shared/agent-types.ts), sentence for sentence, so the renderer can say
 * them in the reader's language. The English strings stay the source of
 * truth for the timeline's coalescing and for the model's context.
 */

export type TriggerEvent = {
  /** Dedupe keys this event consumes. The first is its identity. */
  keys: string[];
  kind: AgentTriggerKind;
  trigger: AgentTrigger;
  /** One line: what happened. */
  title: string;
  at: string;
  ticker?: string;
  filings?: FilingRef[];
  insiderTxns?: Array<{ filing: FilingRef; txn: InsiderTxn }>;
  news?: NewsItem[];
  macro?: MacroEventRead;
  /** A `linked` event: each filing or story with the company and the link that put it in the set. */
  linked?: LinkedHit[];
  /** A `filing_changes` event: the service's answer and each filing with its items. */
  changes?: { answer: FilingChanges; hits: ChangesHit[] };
  /** Schedule occurrence, for a digest. */
  occurrence?: string;
};

export type TriggerCheck =
  | { status: "fired"; event: TriggerEvent; nextCheckMs: number }
  | {
      status: "waiting";
      note: string;
      detail: string;
      /** `note` as codes. */
      noteLines: AgentLine[];
      /** `detail` as codes. */
      detailLines: AgentLine[];
      nextCheckMs: number;
      nextExpectedAt?: string;
    };

export type TriggerContext = {
  agent: Agent;
  /** Mutable: checks may record what they learned (the earnings date, a consensus snapshot). */
  state: AgentEngineState;
  sources: AgentDataSources;
  now: Date;
};

/** One engine sentence as a code and its values (see `AgentLine`). */
export function line(code: string, params?: AgentLine["params"]): AgentLine {
  return params ? { code, params } : { code };
}

/** A stable identity for one trigger, for cooldowns and per-trigger memory. */
export function triggerSignature(t: AgentTrigger): string {
  switch (t.kind) {
    case "earnings":
      return `earnings:${t.ticker}:${t.moment}`;
    case "filing":
      return `filing:${t.ticker}:${[...t.forms].sort().join(",")}${t.insiderBuysOnly ? ":buys" : ""}`;
    case "price_move":
      return `price:${t.ticker}:${t.window}:${t.thresholdPct}`;
    case "news":
      return `news:${t.ticker ?? "*"}:${[...t.keywords].sort().join(",")}`;
    case "macro":
      return `macro:${t.event.toLowerCase()}`;
    case "linked":
      return `linked:${t.ticker}:${[...(t.relations ?? [])].sort().join(",")}:${t.minTier ?? ""}:${[...t.events].sort().join(",")}:${[...(t.forms ?? [])].sort().join(",")}`;
    case "filing_changes":
      return `changes:${t.ticker}:${[...(t.kinds ?? [])].sort().join(",")}`;
    case "schedule":
      return `schedule:${t.cadence}:${t.time}:${t.weekday ?? ""}${t.keywords && t.keywords.length > 0 ? `:${[...t.keywords].sort().join(",")}` : ""}`;
  }
}

function fired(ctx: TriggerContext, key: string): boolean {
  return ctx.state.firedKeys.includes(key);
}

function clampMs(ms: number, min = 2 * MINUTE_MS, max = 12 * HOUR_MS): number {
  return Math.min(max, Math.max(min, Math.round(ms)));
}

function publishedMs(item: { publishedAt?: string }): number {
  const ms = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * When EDGAR took a filing. The index carries the instant (read through
 * `filingAcceptedMs`: SEC's raw stamp is not always UTC); the date alone
 * reads as midday New York.
 */
export function filingMs(f: FilingRef): number {
  const accepted = filingAcceptedMs(f);
  if (accepted !== null) return accepted;
  return f.filedAt ? nyInstant(f.filedAt, "12:00").getTime() : NaN;
}

/* ------------------------------------------------------------------ */
/* Earnings                                                             */
/* ------------------------------------------------------------------ */

export function isResultsFiling(f: FilingRef): boolean {
  return f.form.startsWith("8-K") && f.items.includes("2.02");
}

const RESULTS_HEADLINE =
  /\b(reports?|reported|posts?|posted|announces?|announced|delivers?)\b[^.]*\b(results|earnings|revenue)\b|\b(Q[1-4]|first|second|third|fourth)[- ]quarter (results|earnings|revenue)\b|\bearnings (beat|miss|top|tops|topped)\b/i;

async function checkEarnings(t: Extract<AgentTrigger, { kind: "earnings" }>, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources, state, agent } = ctx;
  const today = nyYmd(now);
  let date: string | null = null;
  let estimated: boolean | null = null;
  try {
    const read = await sources.earningsDates(t.ticker);
    date = read.dates.find((d) => d >= addDaysYmd(today, -3)) ?? null;
    estimated = read.estimated;
  } catch {
    // The calendar is a hint, not a requirement: EDGAR still answers below.
    date = state.earnings?.[t.ticker]?.date ?? null;
  }
  if (date) {
    state.earnings = { ...(state.earnings ?? {}), [t.ticker]: { date, estimated, readAt: now.toISOString() } };
  }
  const nextExpectedAt = date ? nyInstant(date, "08:00").toISOString() : undefined;
  const untilDate = date ? daysBetween(today, date) : null;
  const inWindow = untilDate === null || untilDate <= 1;
  const fastCadence = isEdgarOpen(now) ? 10 * MINUTE_MS : 30 * MINUTE_MS;

  if (!inWindow) {
    const cadence = untilDate! > 3 ? 12 * HOUR_MS : 3 * HOUR_MS;
    return {
      status: "waiting",
      note: `Waiting for ${t.ticker} results on ${date}${estimated ? " (estimated date)" : ""}.`,
      detail: `Next ${t.ticker} results on ${date}${estimated ? " (estimated)" : ""}. Checks the date ${untilDate! > 3 ? "twice a day" : "every 3 hours"} until then.`,
      noteLines: [line(estimated ? "earnings.waitingDateEstimated" : "earnings.waitingDate", { ticker: t.ticker, date: date! })],
      detailLines: [
        line(estimated ? "earnings.nextDateEstimated" : "earnings.nextDate", { ticker: t.ticker, date: date! }),
        line(untilDate! > 3 ? "earnings.checksDateTwiceDaily" : "earnings.checksDateEvery3h"),
      ],
      nextCheckMs: cadence,
      nextExpectedAt,
    };
  }

  // Inside the window, take a consensus snapshot before the release: once the
  // quarter is reported the provider rolls its estimates to the next one.
  const snap = ctx.state.consensus?.[t.ticker];
  const age = snap ? now.getTime() - Date.parse(snap.readAt) : Infinity;
  if (age > 10 * DAY_MS || (age > 12 * HOUR_MS && (date === null || today < date))) {
    try {
      const c = await sources.consensus(t.ticker);
      if (c) ctx.state.consensus = { ...(ctx.state.consensus ?? {}), [t.ticker]: c };
    } catch {
      // Consensus is context; its absence is said in the write-up.
    }
  }

  const filings = await sources.filings(t.ticker);
  const created = Date.parse(agent.createdAt);
  const earliest = date ? nyInstant(addDaysYmd(date, -2)).getTime() : created - DAY_MS;
  const release = filings.find((f) => {
    if (!isResultsFiling(f)) return false;
    const at = filingMs(f);
    return at >= earliest && now.getTime() - at <= 5 * DAY_MS;
  });

  if (release) {
    const key = `earnings:${t.ticker}:${release.accession}`;
    if (fired(ctx, key)) {
      return {
        status: "waiting",
        note: `${t.ticker} results for this quarter are reported. Waiting for the next date.`,
        detail: `Reported the ${release.filedAt} results. Looks for the next date twice a day.`,
        noteLines: [line("earnings.reportedWaitingNext", { ticker: t.ticker })],
        detailLines: [line("earnings.reportedResults", { date: release.filedAt }), line("earnings.looksNextDateTwiceDaily")],
        nextCheckMs: 12 * HOUR_MS,
        nextExpectedAt,
      };
    }
    if (t.moment === "call") {
      const callReady = filingMs(release) + 3 * HOUR_MS;
      if (now.getTime() < callReady) {
        return {
          status: "waiting",
          note: `${t.ticker} results are out. Waiting for the call coverage.`,
          detail: `Results filed ${release.filedAt}. Writes up after the call, about 3 hours after the release.`,
          noteLines: [line("earnings.outWaitingCall", { ticker: t.ticker })],
          detailLines: [line("earnings.resultsFiled", { date: release.filedAt }), line("earnings.writesUpAfterCall")],
          nextCheckMs: clampMs(callReady - now.getTime(), 5 * MINUTE_MS, 30 * MINUTE_MS),
          nextExpectedAt: new Date(callReady).toISOString(),
        };
      }
    }
    return {
      status: "fired",
      event: {
        keys: [key],
        kind: "earnings",
        trigger: t,
        title: `${t.ticker} published quarterly results (8-K item 2.02, filed ${release.filedAt}).`,
        at: now.toISOString(),
        ticker: t.ticker,
        filings: [release],
      },
      nextCheckMs: 12 * HOUR_MS,
    };
  }

  // A day past the date with nothing on EDGAR (a foreign filer files a 6-K,
  // which says nothing about its contents): fall back to the headlines.
  if (date && untilDate !== null && untilDate <= -1) {
    const since = nyInstant(addDaysYmd(date, -1)).getTime();
    const news = (await sources.news(t.ticker)).filter(
      (n) => publishedMs(n) >= since && RESULTS_HEADLINE.test(n.title),
    );
    const key = `earnings:${t.ticker}:${date}:news`;
    if (news.length > 0 && !fired(ctx, key)) {
      return {
        status: "fired",
        event: {
          keys: [key],
          kind: "earnings",
          trigger: t,
          title: `${t.ticker} results reported in the news (no 8-K results filing found).`,
          at: now.toISOString(),
          ticker: t.ticker,
          news: news.slice(0, 8),
        },
        nextCheckMs: 12 * HOUR_MS,
      };
    }
    if (untilDate < -3) {
      return {
        status: "waiting",
        note: `No ${t.ticker} results found for ${date}. Waiting for the next date.`,
        detail: `No results release found for ${date}. Looks for a new date every 6 hours.`,
        noteLines: [line("earnings.noneFound", { ticker: t.ticker, date }), line("earnings.waitingNextDate")],
        detailLines: [line("earnings.noReleaseFound", { date }), line("earnings.looksNewDateEvery6h")],
        nextCheckMs: 6 * HOUR_MS,
        nextExpectedAt,
      };
    }
  }

  return {
    status: "waiting",
    note: date
      ? `Watching SEC filings for ${t.ticker} results on ${date}.`
      : `No ${t.ticker} earnings date published. Watching SEC filings for a results release.`,
    detail: date
      ? `Checks SEC filings every ${fastCadence === 10 * MINUTE_MS ? "10" : "30"} minutes for the ${date} results.`
      : "No earnings date published yet. Checks SEC filings every hour.",
    noteLines: date
      ? [line("earnings.watchingFilingsForDate", { ticker: t.ticker, date })]
      : [line("earnings.noDatePublished", { ticker: t.ticker }), line("earnings.watchingFilingsForRelease")],
    detailLines: date
      ? [line("earnings.checksFilingsEvery", { count: fastCadence === 10 * MINUTE_MS ? 10 : 30, date })]
      : [line("earnings.noDateYet"), line("earnings.checksFilingsHourly")],
    nextCheckMs: date ? fastCadence : HOUR_MS,
    nextExpectedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Filings                                                              */
/* ------------------------------------------------------------------ */

function formKey(form: string): string {
  return form.toUpperCase().replace(/^SCHEDULE /, "SC ").replace(/\/A$/, "").trim();
}

export function formMatches(filed: string, wanted: readonly string[]): boolean {
  const f = formKey(filed);
  return wanted.some((w) => formKey(w) === f);
}

async function checkFiling(t: Extract<AgentTrigger, { kind: "filing" }>, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources, agent } = ctx;
  const cadence = isEdgarOpen(now) ? 15 * MINUTE_MS : 2 * HOUR_MS;
  const created = Date.parse(agent.createdAt);
  // A filing a filing changes trigger on this agent is still reading waits for
  // it (up to six hours), so the richer report is the one the reader gets.
  const fresh = (await sources.filings(t.ticker)).filter(
    (f) =>
      formMatches(f.form, t.forms) &&
      filingMs(f) >= created &&
      !fired(ctx, `filing:${f.accession}`) &&
      !deferredToChanges(f, t.ticker, agent.triggers, ctx.state.firedKeys, now.getTime()),
  );
  const forms = t.forms.join(", ");
  let picked = fresh.slice(0, 5);
  let txns: Array<{ filing: FilingRef; txn: InsiderTxn }> | undefined;

  if (t.insiderBuysOnly) {
    txns = [];
    const skipped: string[] = [];
    for (const f of picked) {
      if (formKey(f.form) !== "4") continue;
      const txn = await sources.insiderTxn(f);
      if (txn && txn.code === "P" && !txn.plan10b51) txns.push({ filing: f, txn });
      else skipped.push(`filing:${f.accession}`);
    }
    // Form 4s that are not open-market buys are consumed quietly, so they are not read again.
    ctx.state.firedKeys = [...ctx.state.firedKeys, ...skipped];
    picked = txns.map((x) => x.filing);
  }

  if (picked.length === 0) {
    return {
      status: "waiting",
      note: `Watching for new ${t.ticker} ${t.insiderBuysOnly ? "insider purchases" : `${forms} filings`}.`,
      detail: `No new ${t.ticker} ${t.insiderBuysOnly ? "open-market insider purchases" : `${forms} filings`}. Checks EDGAR every ${cadence === 15 * MINUTE_MS ? "15 minutes" : "2 hours"}.`,
      noteLines: [t.insiderBuysOnly ? line("filing.watchingInsider", { ticker: t.ticker }) : line("filing.watchingForms", { ticker: t.ticker, forms })],
      detailLines: [
        t.insiderBuysOnly ? line("filing.noNewInsider", { ticker: t.ticker }) : line("filing.noNewForms", { ticker: t.ticker, forms }),
        line(cadence === 15 * MINUTE_MS ? "filing.checksEdgarEvery15m" : "filing.checksEdgarEvery2h"),
      ],
      nextCheckMs: cadence,
    };
  }
  const first = picked[0]!;
  return {
    status: "fired",
    event: {
      keys: picked.map((f) => `filing:${f.accession}`),
      kind: "filing",
      trigger: t,
      title:
        picked.length === 1
          ? `${t.ticker} filed a ${first.form} on ${first.filedAt}.`
          : `${t.ticker} filed ${picked.length} new filings (${[...new Set(picked.map((f) => f.form))].join(", ")}).`,
      at: now.toISOString(),
      ticker: t.ticker,
      filings: picked,
      insiderTxns: txns,
    },
    nextCheckMs: cadence,
  };
}

/* ------------------------------------------------------------------ */
/* Price moves                                                          */
/* ------------------------------------------------------------------ */

function signed(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

async function checkPriceMove(t: Extract<AgentTrigger, { kind: "price_move" }>, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources, state } = ctx;
  const sig = triggerSignature(t);
  const p = nyParts(now);
  const weekend = p.weekday === 0 || p.weekday === 6;

  if (t.window === "5d") {
    const cadence = isRegularSession(now) ? 30 * MINUTE_MS : 3 * HOUR_MS;
    const last = state.lastFiredByTrigger[sig];
    if (last && now.getTime() - Date.parse(last) < 3 * DAY_MS) {
      return {
        status: "waiting",
        note: `Reported a 5-day ${t.ticker} move recently. Paused for 3 days.`,
        detail: `Last 5-day move reported ${last.slice(0, 10)}. Checks again after 3 days.`,
        noteLines: [line("price.fiveDayReported", { ticker: t.ticker }), line("price.pausedThreeDays")],
        detailLines: [line("price.fiveDayLastReported", { date: last.slice(0, 10) }), line("price.checksAfterThreeDays")],
        nextCheckMs: cadence,
      };
    }
    const closes = await sources.dailyCloses(t.ticker);
    if (closes.length < 6) {
      return {
        status: "waiting",
        note: `Not enough ${t.ticker} price history yet.`,
        detail: "Not enough closes to measure 5 sessions.",
        noteLines: [line("price.notEnoughHistory", { ticker: t.ticker })],
        detailLines: [line("price.notEnoughCloses")],
        nextCheckMs: 6 * HOUR_MS,
      };
    }
    const end = closes[closes.length - 1]!;
    const base = closes[closes.length - 6]!;
    const pct = ((end.close - base.close) / base.close) * 100;
    const key = `price:${t.ticker}:5d:${end.date}`;
    if (Math.abs(pct) >= t.thresholdPct && !fired(ctx, key)) {
      return {
        status: "fired",
        event: {
          keys: [key],
          kind: "price_move",
          trigger: t,
          title: `${t.ticker} moved ${signed(pct)} over 5 sessions (${base.date} to ${end.date}).`,
          at: now.toISOString(),
          ticker: t.ticker,
        },
        nextCheckMs: cadence,
      };
    }
    return {
      status: "waiting",
      note: `Watching ${t.ticker} for a 5-day move of ${t.thresholdPct}%.`,
      detail: `${t.ticker} ${signed(pct)} over 5 sessions; the bar is ${t.thresholdPct}%.`,
      noteLines: [line("price.watchingFiveDay", { ticker: t.ticker, threshold: `${t.thresholdPct}%` })],
      detailLines: [line("price.fiveDayStatus", { ticker: t.ticker, move: signed(pct), threshold: `${t.thresholdPct}%` })],
      nextCheckMs: cadence,
    };
  }

  if (weekend || (t.window === "intraday" && !isRegularSession(now))) {
    return {
      status: "waiting",
      note: `Watching ${t.ticker} for a ${t.thresholdPct}% move. Market closed.`,
      detail: "Market closed. Checks resume during the session.",
      noteLines: [line("price.watching", { ticker: t.ticker, threshold: `${t.thresholdPct}%` }), line("price.marketClosed")],
      detailLines: [line("price.marketClosed"), line("price.resumesInSession")],
      nextCheckMs: HOUR_MS,
    };
  }
  const q = await sources.quote(t.ticker);
  const pct = t.window === "1d" ? (q.regularChangePct ?? q.changePct) : q.changePct;
  const day = nyYmd(now);
  const key = `price:${t.ticker}:${t.window}:${day}`;
  const cadence = q.session === "regular" ? 5 * MINUTE_MS : q.session === "closed" ? HOUR_MS : 15 * MINUTE_MS;
  if (Math.abs(pct) >= t.thresholdPct) {
    if (fired(ctx, key)) {
      return {
        status: "waiting",
        note: `Reported today's ${t.ticker} move.`,
        detail: `Reported today's move. Watches again from the next session.`,
        noteLines: [line("price.reportedToday", { ticker: t.ticker })],
        detailLines: [line("price.reportedTodayShort"), line("price.watchesNextSession")],
        nextCheckMs: Math.max(cadence, HOUR_MS),
      };
    }
    return {
      status: "fired",
      event: {
        keys: [key],
        kind: "price_move",
        trigger: t,
        title: `${t.ticker} is ${signed(pct)} on the day, past the ${t.thresholdPct}% mark.`,
        at: now.toISOString(),
        ticker: t.ticker,
      },
      nextCheckMs: cadence,
    };
  }
  return {
    status: "waiting",
    note: `Watching ${t.ticker} for a ${t.thresholdPct}% move.`,
    detail: `${t.ticker} ${signed(pct)} on the day; the bar is ${t.thresholdPct}%.`,
    noteLines: [line("price.watching", { ticker: t.ticker, threshold: `${t.thresholdPct}%` })],
    detailLines: [line("price.dayStatus", { ticker: t.ticker, move: signed(pct), threshold: `${t.thresholdPct}%` })],
    nextCheckMs: cadence,
  };
}

/* ------------------------------------------------------------------ */
/* News                                                                 */
/* ------------------------------------------------------------------ */

/** Short stable id for a url, for dedupe keys. */
export function hashKey(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function matchesKeywords(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const lower = title.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

const NEWS_COOLDOWN_MS = 2 * HOUR_MS;

async function checkNews(t: Extract<AgentTrigger, { kind: "news" }>, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources, agent, state } = ctx;
  const cadence = t.ticker ? 15 * MINUTE_MS : 30 * MINUTE_MS;
  const market = !t.ticker && t.keywords.length === 0;
  const subject = t.ticker ?? (market ? "the market" : t.keywords.join(", "));
  const watchingLine = market ? line("news.watchingMarket") : line("news.watching", { subject });
  const last = state.lastFiredByTrigger[triggerSignature(t)];
  if (last && now.getTime() - Date.parse(last) < NEWS_COOLDOWN_MS) {
    return {
      status: "waiting",
      note: `Watching news about ${subject}.`,
      detail: "Collects new headlines and reports at most every 2 hours.",
      noteLines: [watchingLine],
      detailLines: [line("news.cooldown")],
      nextCheckMs: clampMs(Date.parse(last) + NEWS_COOLDOWN_MS - now.getTime(), 5 * MINUTE_MS),
    };
  }
  const created = Date.parse(agent.createdAt);
  const since = Math.max(created, now.getTime() - DAY_MS);
  const items = t.ticker ? await sources.news(t.ticker) : await sources.marketNews(new Date(since).toISOString());
  const fresh = items.filter((n) => {
    const at = publishedMs(n);
    return Number.isFinite(at) && at >= created && matchesKeywords(n.title, t.keywords) && !fired(ctx, `news:${hashKey(n.url)}`);
  });
  if (fresh.length === 0) {
    return {
      status: "waiting",
      note: `Watching news about ${subject}.`,
      detail: `No new matching headlines. Checks every ${cadence / MINUTE_MS} minutes.`,
      noteLines: [watchingLine],
      detailLines: [line("news.noNew"), line("news.checksEvery", { count: cadence / MINUTE_MS })],
      nextCheckMs: cadence,
    };
  }
  const picked = fresh.sort((a, b) => publishedMs(b) - publishedMs(a)).slice(0, 6);
  return {
    status: "fired",
    event: {
      keys: picked.map((n) => `news:${hashKey(n.url)}`),
      kind: "news",
      trigger: t,
      title: `${picked.length} new headline${picked.length === 1 ? "" : "s"} about ${subject}.`,
      at: now.toISOString(),
      ticker: t.ticker,
      news: picked,
    },
    nextCheckMs: cadence,
  };
}

/* ------------------------------------------------------------------ */
/* Macro                                                                */
/* ------------------------------------------------------------------ */

/** Calendar codes a reader's words map to, and the words that find coverage of them. */
const MACRO_ALIASES: ReadonlyArray<{ codes: string[]; words: string[]; headline: string[] }> = [
  { codes: ["CPI"], words: ["cpi", "consumer price", "inflation"], headline: ["cpi", "inflation", "consumer price"] },
  { codes: ["PPI"], words: ["ppi", "producer price"], headline: ["ppi", "producer price", "wholesale"] },
  { codes: ["NFP"], words: ["nfp", "payroll", "jobs report", "employment situation", "nonfarm", "jobs"], headline: ["payroll", "jobs", "unemployment", "hiring"] },
  { codes: ["FOMC", "FOMC_PRESSER"], words: ["fomc", "fed", "federal reserve", "rate decision", "powell", "interest rate"], headline: ["fed", "fomc", "powell", "rate"] },
  { codes: ["PCE"], words: ["pce", "personal income", "personal consumption"], headline: ["pce", "inflation", "spending"] },
  { codes: ["GDP"], words: ["gdp", "gross domestic"], headline: ["gdp", "economy", "growth"] },
  { codes: ["RETAIL"], words: ["retail sales", "retail"], headline: ["retail sales", "consumer spending"] },
  { codes: ["JOLTS"], words: ["jolts", "job openings"], headline: ["job openings", "jolts"] },
  { codes: ["DURABLES"], words: ["durable"], headline: ["durable goods"] },
  { codes: ["HOUSING_STARTS"], words: ["housing starts", "housing"], headline: ["housing starts", "housing"] },
  { codes: ["NEW_HOME_SALES"], words: ["new home sales", "home sales"], headline: ["home sales", "housing"] },
  { codes: ["UMICH_PRELIM", "UMICH_FINAL"], words: ["michigan", "sentiment", "umich"], headline: ["sentiment", "michigan"] },
];

export function resolveMacro(event: string): { codes: string[]; headline: string[] } | null {
  const e = event.toLowerCase().trim();
  const byCode = MACRO_ALIASES.find((a) => a.codes.some((c) => c.toLowerCase() === e));
  if (byCode) return byCode;
  const byWord = MACRO_ALIASES.find((a) => a.words.some((w) => e.includes(w)));
  return byWord ?? null;
}

async function checkMacro(t: Extract<AgentTrigger, { kind: "macro" }>, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources } = ctx;
  const resolved = resolveMacro(t.event);
  const today = nyYmd(now);
  const events = sources
    .macroEvents(addDaysYmd(today, -2), addDaysYmd(today, 120))
    .filter((e) => (resolved ? resolved.codes.includes(e.code) : e.title.toLowerCase().includes(t.event.toLowerCase())));
  for (const e of events) {
    const at = nyInstant(e.date, e.timeEt ?? "08:30").getTime();
    const key = `macro:${e.code}:${e.date}`;
    if (fired(ctx, key)) continue;
    if (now.getTime() < at) {
      const until = at - now.getTime();
      return {
        status: "waiting",
        note: `Waiting for ${e.title} on ${e.date}.`,
        detail: `Next ${e.title}${e.period ? ` (${e.period})` : ""} on ${e.date}${e.timeEt ? ` at ${e.timeEt} ET` : ""}.`,
        noteLines: [line("macro.waiting", { event: e.title, date: e.date })],
        detailLines: [
          e.timeEt
            ? line("macro.nextAt", { event: `${e.title}${e.period ? ` (${e.period})` : ""}`, date: e.date, time: e.timeEt })
            : line("macro.next", { event: `${e.title}${e.period ? ` (${e.period})` : ""}`, date: e.date }),
        ],
        nextCheckMs: until > 2 * DAY_MS ? 12 * HOUR_MS : clampMs(until + 20 * MINUTE_MS, 5 * MINUTE_MS, 6 * HOUR_MS),
        nextExpectedAt: new Date(at).toISOString(),
      };
    }
    // Released more than a day and a half ago (the app was closed): too late to be news.
    if (now.getTime() - at > 36 * HOUR_MS) continue;
    const sinceRelease = now.getTime() - at;
    const words = resolved?.headline ?? [t.event.toLowerCase()];
    const headlines =
      sinceRelease >= 20 * MINUTE_MS
        ? (await sources.marketNews(new Date(at).toISOString())).filter((n) => matchesKeywords(n.title, words))
        : [];
    if (headlines.length === 0 && sinceRelease < 2 * HOUR_MS) {
      return {
        status: "waiting",
        note: `${e.title} is out. Waiting for coverage.`,
        detail: `${e.title} released${e.timeEt ? ` at ${e.timeEt} ET` : ""}. Writes up once coverage appears, within 2 hours.`,
        noteLines: [line("macro.outWaitingCoverage", { event: e.title })],
        detailLines: [
          e.timeEt ? line("macro.releasedAt", { event: e.title, time: e.timeEt }) : line("macro.released", { event: e.title }),
          line("macro.writesUpOnCoverage"),
        ],
        nextCheckMs: 10 * MINUTE_MS,
        nextExpectedAt: new Date(at).toISOString(),
      };
    }
    return {
      status: "fired",
      event: {
        keys: [key],
        kind: "macro",
        trigger: t,
        title: `${e.title}${e.period ? ` for ${e.period}` : ""} released on ${e.date}.`,
        at: now.toISOString(),
        macro: e,
        news: headlines.slice(0, 8),
      },
      nextCheckMs: 12 * HOUR_MS,
    };
  }
  const until = sources.macroCoverageUntil();
  return {
    status: "waiting",
    note: `No upcoming ${t.event} release in the calendar.`,
    detail: `No ${t.event} release listed through ${until}, the end of the shipped calendar.`,
    noteLines: [line("macro.noneUpcoming", { event: t.event })],
    detailLines: [line("macro.noneListed", { event: t.event, date: until })],
    nextCheckMs: 24 * HOUR_MS,
  };
}

/* ------------------------------------------------------------------ */
/* Schedule                                                             */
/* ------------------------------------------------------------------ */

function onCadence(t: Extract<AgentTrigger, { kind: "schedule" }>, day: Date): boolean {
  const wd = day.getDay();
  if (t.cadence === "daily") return true;
  if (t.cadence === "weekdays") return wd >= 1 && wd <= 5;
  return wd === (t.weekday ?? 1);
}

/** Occurrences in local time: the latest at or before `now`, and the next after it. */
export function scheduleOccurrences(t: Extract<AgentTrigger, { kind: "schedule" }>, now: Date): { last: Date | null; next: Date } {
  const [hh, mm] = t.time.split(":").map(Number);
  let last: Date | null = null;
  let next: Date | null = null;
  for (let offset = -8; offset <= 8; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hh, mm, 0, 0);
    if (!onCadence(t, d)) continue;
    if (d.getTime() <= now.getTime()) last = d;
    else if (!next) next = d;
  }
  return { last, next: next ?? new Date(now.getTime() + 7 * DAY_MS) };
}

const LOCAL_WHEN = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

async function checkSchedule(t: Extract<AgentTrigger, { kind: "schedule" }>, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, agent } = ctx;
  const { last, next } = scheduleOccurrences(t, now);
  const nextCheckMs = clampMs(next.getTime() - now.getTime(), MINUTE_MS, 6 * HOUR_MS);
  if (last && last.getTime() >= Date.parse(agent.createdAt) && now.getTime() - last.getTime() < 12 * HOUR_MS) {
    const key = `schedule:${last.toISOString()}`;
    if (!fired(ctx, key)) {
      return {
        status: "fired",
        event: {
          keys: [key],
          kind: "schedule",
          trigger: t,
          title: `Scheduled ${t.cadence === "weekly" ? "weekly" : "daily"} digest.`,
          at: now.toISOString(),
          ticker: agent.ticker,
          occurrence: last.toISOString(),
        },
        nextCheckMs,
      };
    }
  }
  return {
    status: "waiting",
    note: "Waiting for the next scheduled digest.",
    detail: `Next digest ${LOCAL_WHEN.format(next).replace(",", "")}.`,
    noteLines: [line("schedule.waiting")],
    detailLines: [line("schedule.next", { at: next.toISOString() })],
    nextCheckMs,
    nextExpectedAt: next.toISOString(),
  };
}

export function checkTrigger(t: AgentTrigger, ctx: TriggerContext): Promise<TriggerCheck> {
  switch (t.kind) {
    case "earnings":
      return checkEarnings(t, ctx);
    case "filing":
      return checkFiling(t, ctx);
    case "price_move":
      return checkPriceMove(t, ctx);
    case "news":
      return checkNews(t, ctx);
    case "macro":
      return checkMacro(t, ctx);
    case "linked":
      return checkLinked(t, ctx);
    case "filing_changes":
      return checkFilingChanges(t, ctx);
    case "schedule":
      return checkSchedule(t, ctx);
  }
}
