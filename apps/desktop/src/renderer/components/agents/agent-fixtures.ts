import type { AgentsBridge, AgentsEvent } from "@/lib/agents-client";
import type {
  Agent,
  AgentActivity,
  AgentDetail,
  AgentDraft,
  AgentLine,
  AgentMessage,
  AgentMetric,
  AgentReport,
  AgentResult,
  AgentTrigger,
} from "../../../shared/agent-types";

/**
 * An in-memory agent engine for preview harnesses and for a dev build that
 * opts in (see lib/agents-client.ts). Never installed in a packaged app:
 * these agents are made up, and the app only ever shows the reader's own.
 *
 * It keeps to the contract's shapes and answers with a little latency, so
 * the screens' loading and pending states are seen. Times are relative to
 * when the adapter is made, so the countdowns read sensibly on any day.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type FixtureOptions = {
  /** Milliseconds every call takes. Default 350. */
  latency?: number;
  /** Start with no agents at all. */
  empty?: boolean;
  /** Every call fails, for the error states. */
  failing?: boolean;
  /** `list()` never answers, for the loading state. */
  hanging?: boolean;
};

type Store = {
  agents: Agent[];
  reports: AgentReport[];
  activity: AgentActivity[];
  messages: AgentMessage[];
};

const iso = (ms: number) => new Date(ms).toISOString();

/** An engine line, as src/main/agents writes them beside its English (see `AgentLine`). */
const L = (code: string, params?: AgentLine["params"], triggers?: AgentTrigger[]): AgentLine => ({
  code,
  ...(params ? { params } : {}),
  ...(triggers ? { triggers } : {}),
});
const ymd = (ms: number) => iso(ms).slice(0, 10);

function seed(now: number): Store {
  const agents: Agent[] = [];
  const reports: AgentReport[] = [];
  const activity: AgentActivity[] = [];
  const messages: AgentMessage[] = [];
  let n = 0;
  const act = (agentId: string, at: number, kind: AgentActivity["kind"], text: string, reportId?: string, lines?: AgentLine[]) =>
    activity.push({ id: `act-${++n}`, agentId, at: iso(at), kind, text, reportId, ...(lines ? { lines } : {}) });
  const created = (agentId: string, at: number) => {
    const triggers = agents.find((a) => a.id === agentId)?.triggers ?? [];
    act(agentId, at, "created", "Created from your brief.", undefined, [L("activity.created", undefined, triggers)]);
  };

  // 1. The reader's own example: waiting on NVDA's results, nothing fired yet.
  agents.push({
    id: "nvda-earnings",
    name: "NVDA earnings",
    brief:
      "NVDA reports next week and I don't have time to follow it. When they publish earnings, tell me. I care about data center revenue, gross margin and next-quarter guidance.",
    ticker: "NVDA",
    companyName: "NVIDIA Corporation",
    triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
    metrics: [
      { id: "m1", label: "Data center revenue", expectation: "above $33B" },
      { id: "m2", label: "Gross margin", expectation: "over 75%" },
      { id: "m3", label: "Next-quarter revenue guidance", expectation: "a guide above $37B" },
    ],
    channels: ["desktop", "mobile_push"],
    status: "active",
    oneShot: true,
    createdAt: iso(now - 2 * DAY),
    updatedAt: iso(now - 2 * DAY),
    lastCheckedAt: iso(now - 12 * MIN),
    nextExpectedAt: iso(now + 3 * DAY + 4 * HOUR),
    nextAction: "Checks the earnings calendar and SEC filings every 10 minutes until NVDA reports.",
    nextActionLines: [
      L("earnings.nextDate", { ticker: "NVDA", date: ymd(now + 3 * DAY + 4 * HOUR) }),
      L("earnings.checksDateTwiceDaily"),
    ],
    unread: 0,
  });
  created("nvda-earnings", now - 2 * DAY);
  act("nvda-earnings", now - 2 * DAY + MIN, "waiting", "Earnings date confirmed on the company calendar.", undefined, [
    L("earnings.waitingDate", { ticker: "NVDA", date: ymd(now + 3 * DAY + 4 * HOUR) }),
  ]);
  act("nvda-earnings", now - 12 * MIN, "checked", "Checked the earnings calendar and SEC EDGAR. Nothing new.", undefined, [
    L("activity.checkedOnRequest"),
    L("run.nothingNew"),
  ]);

  // 2. A standing earnings watch that has fired, with an unread report and a chat.
  const aaplReport: AgentReport = {
    id: "rep-aapl-q4",
    agentId: "aapl-quarter",
    at: iso(now - 2 * DAY - 3 * HOUR),
    trigger: "earnings",
    headline: "Services set a record; iPhone revenue came in under your bar",
    summary:
      "Apple reported fiscal fourth-quarter revenue of $94.9B, up 6% from a year earlier. Services revenue reached $25.0B, the highest on record, while iPhone revenue of $46.2B was below the $47B you set.\n\nGross margin was 46.2%, inside the company's own range of 46% to 47%. Management guided December-quarter revenue growth in the low to mid single digits, in line with the prior year's pattern.\n\nOn the call, the CFO attributed the iPhone gap to supply timing on the Pro models rather than demand, and said channel inventory ended the quarter within the usual range.",
    readings: [
      { metricId: "a1", label: "iPhone revenue", value: "$46.2B", expectation: "at least $47B", verdict: "below", comparison: "$43.8B a year ago" },
      { metricId: "a2", label: "Services revenue", value: "$25.0B", expectation: "a new record", verdict: "above", comparison: "$22.3B a year ago" },
      { metricId: "a3", label: "Gross margin", value: "46.2%", expectation: "46% to 47%", verdict: "inline", comparison: "45.2% a year ago" },
      { metricId: "a4", label: "December-quarter outlook", value: "Low to mid single-digit growth", verdict: "unclear", comparison: "No dollar figure given" },
    ],
    sources: [
      { title: "Apple reports fourth quarter results", url: "https://www.apple.com/newsroom/", publishedAt: iso(now - 2 * DAY - 3 * HOUR - 5 * MIN) },
      { title: "Form 8-K, Apple Inc.", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=8-K", publishedAt: iso(now - 2 * DAY - 3 * HOUR) },
      { title: "Earnings call transcript" },
    ],
    read: false,
  };
  const aaplPrior: AgentReport = {
    id: "rep-aapl-q3",
    agentId: "aapl-quarter",
    at: iso(now - 93 * DAY),
    trigger: "earnings",
    headline: "Revenue and margin both above your marks",
    summary:
      "Apple reported fiscal third-quarter revenue of $85.8B, up 5% from a year earlier. iPhone revenue was $39.3B and Services $24.2B.\n\nGross margin of 46.3% came in above the top of the company's range.",
    readings: [
      { metricId: "a1", label: "iPhone revenue", value: "$39.3B", expectation: "at least $38B", verdict: "above", comparison: "$39.7B a year ago" },
      { metricId: "a2", label: "Services revenue", value: "$24.2B", expectation: "a new record", verdict: "above", comparison: "$21.2B a year ago" },
      { metricId: "a3", label: "Gross margin", value: "46.3%", expectation: "46% to 47%", verdict: "inline" },
    ],
    sources: [{ title: "Apple reports third quarter results", url: "https://www.apple.com/newsroom/" }],
    read: true,
  };
  reports.push(aaplReport, aaplPrior);
  agents.push({
    id: "aapl-quarter",
    name: "Apple every quarter",
    brief: "Each time Apple reports, tell me how iPhone and Services did and whether gross margin held in their range.",
    ticker: "AAPL",
    companyName: "Apple Inc.",
    triggers: [
      { kind: "earnings", ticker: "AAPL", moment: "release" },
      { kind: "earnings", ticker: "AAPL", moment: "call" },
    ],
    metrics: [
      { id: "a1", label: "iPhone revenue", expectation: "at least $47B" },
      { id: "a2", label: "Services revenue", expectation: "a new record" },
      { id: "a3", label: "Gross margin", expectation: "46% to 47%" },
      { id: "a4", label: "December-quarter outlook" },
    ],
    channels: ["desktop"],
    status: "active",
    oneShot: false,
    createdAt: iso(now - 120 * DAY),
    updatedAt: iso(now - 30 * DAY),
    lastCheckedAt: iso(now - 40 * MIN),
    lastFiredAt: aaplReport.at,
    nextExpectedAt: iso(now + 88 * DAY),
    unread: 1,
  });
  created("aapl-quarter", now - 120 * DAY);
  act("aapl-quarter", now - 93 * DAY, "fired", `Reported: ${aaplPrior.headline}`, aaplPrior.id, [L("activity.reported", { headline: aaplPrior.headline })]);
  act("aapl-quarter", now - 93 * DAY + MIN, "notified", "Desktop notification sent.", aaplPrior.id, [L("delivery.desktopShown")]);
  act("aapl-quarter", now - 30 * DAY, "edited", "Edited: metrics.", undefined, [L("activity.edited", { fields: "metrics" })]);
  act("aapl-quarter", Date.parse(aaplReport.at), "fired", `Reported: ${aaplReport.headline}`, aaplReport.id, [
    L("activity.reported", { headline: aaplReport.headline }),
  ]);
  act("aapl-quarter", Date.parse(aaplReport.at) + MIN, "notified", "Desktop notification sent.", aaplReport.id, [L("delivery.desktopShown")]);
  act("aapl-quarter", now - 40 * MIN, "waiting", "No AAPL earnings date published.", undefined, [
    L("earnings.noDatePublished", { ticker: "AAPL" }),
    L("earnings.watchingFilingsForRelease"),
  ]);
  messages.push(
    { id: "msg-1", agentId: "aapl-quarter", role: "user", at: iso(now - 2 * DAY), text: "Was the iPhone miss about demand?" },
    {
      id: "msg-2",
      agentId: "aapl-quarter",
      role: "agent",
      at: iso(now - 2 * DAY + 20_000),
      text: "The company put it down to supply timing on the Pro models. On the call the CFO said channel inventory ended the quarter within the usual range, and did not describe a change in demand.\n\nFor context, iPhone revenue was still up 5% from a year earlier.",
      reportIds: [aaplReport.id],
    },
  );

  // 3. A macro release, soon.
  agents.push({
    id: "fomc",
    name: "Fed decision",
    brief: "When the Fed announces its rate decision, tell me the new range, how many dissents there were, and what changed in the statement.",
    triggers: [{ kind: "macro", event: "FOMC rate decision" }],
    metrics: [
      { id: "f1", label: "Policy rate range", expectation: "unchanged" },
      { id: "f2", label: "Dissents" },
      { id: "f3", label: "Statement changes on inflation" },
    ],
    channels: ["desktop", "mobile_push"],
    status: "active",
    oneShot: false,
    createdAt: iso(now - 20 * DAY),
    updatedAt: iso(now - 20 * DAY),
    lastCheckedAt: iso(now - 2 * HOUR),
    nextExpectedAt: iso(now + 5 * DAY + 6 * HOUR),
    unread: 0,
  });
  created("fomc", now - 20 * DAY);
  act("fomc", now - 2 * HOUR, "waiting", "Meeting on the calendar. Statement due at 14:00 ET.", undefined, [
    L("macro.nextAt", { event: "FOMC", date: ymd(now + 2 * DAY), time: "14:00" }),
  ]);

  // 4. A daily note with two reports.
  const morning: AgentReport = {
    id: "rep-semis-1",
    agentId: "semis-morning",
    at: iso(now - 9 * HOUR),
    trigger: "schedule",
    headline: "Quiet night for the group; TSMC September sales up 18% on the year",
    summary:
      "TSMC published September revenue of NT$251.9B, up 18% from a year earlier and down 4% from August.\n\nNo filings from the names on your list overnight. ASML reports next week.",
    readings: [
      { metricId: "s1", label: "TSMC monthly revenue", value: "NT$251.9B", verdict: "above", comparison: "NT$213.5B a year ago" },
      { metricId: "s2", label: "Overnight filings", value: "None", verdict: "inline" },
    ],
    sources: [{ title: "TSMC monthly revenue report", url: "https://investor.tsmc.com/" }],
    read: false,
  };
  reports.push(morning, {
    id: "rep-semis-0",
    agentId: "semis-morning",
    at: iso(now - 33 * HOUR),
    trigger: "schedule",
    headline: "Micron filed its 10-K; no change to the group otherwise",
    summary: "Micron filed its annual report after the close. Revenue for the fiscal year was $37.4B.",
    readings: [{ metricId: "s2", label: "Overnight filings", value: "Micron 10-K", verdict: "unclear" }],
    sources: [{ title: "Form 10-K, Micron Technology", url: "https://www.sec.gov/" }],
    read: true,
  });
  agents.push({
    id: "semis-morning",
    name: "Morning semis note",
    brief: "Every weekday before the open, give me what happened overnight across the chip names I hold: filings, monthly sales, anything material.",
    triggers: [{ kind: "schedule", cadence: "weekdays", time: "08:00" }],
    metrics: [
      { id: "s1", label: "TSMC monthly revenue" },
      { id: "s2", label: "Overnight filings" },
    ],
    instructions: "Keep it to two paragraphs.",
    channels: ["desktop"],
    status: "active",
    oneShot: false,
    createdAt: iso(now - 14 * DAY),
    updatedAt: iso(now - 14 * DAY),
    lastCheckedAt: iso(now - 9 * HOUR),
    lastFiredAt: morning.at,
    nextExpectedAt: iso(now + 15 * HOUR),
    unread: 1,
  });
  created("semis-morning", now - 14 * DAY);
  act("semis-morning", now - 33 * HOUR, "fired", "Morning note written.", "rep-semis-0", [
    L("activity.reported", { headline: "Micron filed its 10-K; no change to the group otherwise" }),
  ]);
  act("semis-morning", now - 9 * HOUR, "fired", `Reported: ${morning.headline}`, morning.id, [L("activity.reported", { headline: morning.headline })]);

  // 5. Paused.
  agents.push({
    id: "msft-filings",
    name: "Microsoft filings",
    brief: "Tell me whenever Microsoft files an 8-K, and summarise what it is about.",
    ticker: "MSFT",
    companyName: "Microsoft Corporation",
    triggers: [{ kind: "filing", ticker: "MSFT", forms: ["8-K"] }],
    metrics: [{ id: "x1", label: "What the filing is about" }],
    channels: ["desktop"],
    status: "paused",
    oneShot: false,
    createdAt: iso(now - 40 * DAY),
    updatedAt: iso(now - 6 * DAY),
    lastCheckedAt: iso(now - 6 * DAY),
    unread: 0,
  });
  created("msft-filings", now - 40 * DAY);
  act("msft-filings", now - 6 * DAY, "paused", "Paused.", undefined, [L("activity.paused")]);

  // 6. In error.
  agents.push({
    id: "amd-moves",
    name: "AMD big moves",
    brief: "If AMD moves more than 6% in a day, tell me what the news was.",
    ticker: "AMD",
    companyName: "Advanced Micro Devices",
    triggers: [{ kind: "price_move", ticker: "AMD", thresholdPct: 6, window: "1d" }],
    metrics: [{ id: "d1", label: "Move and the news behind it" }],
    channels: ["desktop"],
    status: "error",
    oneShot: false,
    createdAt: iso(now - 9 * DAY),
    updatedAt: iso(now - 3 * HOUR),
    lastCheckedAt: iso(now - 3 * HOUR),
    unread: 0,
    error: "The price feed did not answer on the last three checks.",
  });
  created("amd-moves", now - 9 * DAY);
  act("amd-moves", now - 3 * HOUR, "error", "Check failed: The price feed did not answer on the last three checks.", undefined, [
    L("activity.checkFailed", { error: "The price feed did not answer on the last three checks." }),
  ]);

  // 7. Completed one-shot.
  const avgo: AgentReport = {
    id: "rep-avgo",
    agentId: "avgo-earnings",
    at: iso(now - 9 * DAY),
    trigger: "earnings",
    headline: "AI semiconductor revenue of $5.2B, in line with the company's guide",
    summary:
      "Broadcom reported AI semiconductor revenue of $5.2B, matching the figure it gave last quarter. Total revenue was $15.0B.\n\nThe company guided next-quarter AI revenue to $6.2B.",
    readings: [
      { metricId: "b1", label: "AI semiconductor revenue", value: "$5.2B", expectation: "around $5.1B", verdict: "inline", comparison: "$3.1B a year ago" },
      { metricId: "b2", label: "Next-quarter AI revenue guide", value: "$6.2B", expectation: "above $6B", verdict: "above" },
    ],
    sources: [{ title: "Broadcom fiscal Q3 results", url: "https://investors.broadcom.com/" }],
    read: true,
  };
  reports.push(avgo);
  agents.push({
    id: "avgo-earnings",
    name: "AVGO earnings",
    brief: "Tell me when Broadcom reports and how AI revenue came in.",
    ticker: "AVGO",
    companyName: "Broadcom Inc.",
    triggers: [{ kind: "earnings", ticker: "AVGO", moment: "release" }],
    metrics: [
      { id: "b1", label: "AI semiconductor revenue", expectation: "around $5.1B" },
      { id: "b2", label: "Next-quarter AI revenue guide", expectation: "above $6B" },
    ],
    channels: ["desktop"],
    status: "completed",
    oneShot: true,
    createdAt: iso(now - 15 * DAY),
    updatedAt: iso(now - 9 * DAY),
    lastCheckedAt: iso(now - 9 * DAY),
    lastFiredAt: avgo.at,
    unread: 0,
  });
  created("avgo-earnings", now - 15 * DAY);
  act("avgo-earnings", now - 9 * DAY, "fired", `Reported: ${avgo.headline}`, avgo.id, [L("activity.reported", { headline: avgo.headline })]);
  act("avgo-earnings", now - 9 * DAY + MIN, "completed", "Completed. A one-shot agent ends after its first report.", undefined, [
    L("activity.completed"),
  ]);

  return { agents, reports, activity, messages };
}


const KNOWN: Record<string, string> = {
  NVDA: "NVIDIA Corporation",
  AAPL: "Apple Inc.",
  MSFT: "Microsoft Corporation",
  AMD: "Advanced Micro Devices",
  AVGO: "Broadcom Inc.",
  TSLA: "Tesla, Inc.",
  AMZN: "Amazon.com, Inc.",
  META: "Meta Platforms, Inc.",
  GOOGL: "Alphabet Inc.",
  TSM: "Taiwan Semiconductor",
  JPM: "JPMorgan Chase & Co.",
};
const NOT_TICKERS = new Set(["I", "A", "CEO", "CFO", "SEC", "CPI", "FOMC", "EPS", "AI", "US", "ET", "PM", "AM", "GAAP", "TICKER", "OK"]);

/** "8:05" in a brief as "08:05"; no time at all as 08:00. */
function clockText(m: RegExpExecArray | null): string {
  if (!m) return "08:00";
  return [String(m[1]).padStart(2, "0"), String(m[2])].join(":");
}

const NOT_TOPIC = new Set(
  "a an the and or of for to in on at about with me my tell let know keep watch track follow monitor news headline headlines material overnight today morning day daily week weekday weekdays which what had has have is are every each please market stock stocks names companies".split(
    " ",
  ),
);

/** "which semiconductor suppliers had material news" as semiconductor, suppliers; "watch tech" as tech. */
function topicWords(text: string): string[] {
  const lower = text.toLowerCase();
  const phrase =
    /\bwhich ([a-z][a-z0-9 &-]{2,60}?) (?:had|have|has|filed|reported|moved)\b/.exec(lower)?.[1] ??
    /\b(?:news|headlines) (?:about|on|mentioning) ([a-z][a-z0-9 &-]{2,60})/.exec(lower)?.[1] ??
    /\b(?:watch|track|follow|monitor|about) ([a-z][a-z0-9 &-]{2,60})/.exec(lower)?.[1] ??
    "";
  return [...new Set(phrase.split(/[\s,&]+/).filter((w) => w.length >= 3 && !NOT_TOPIC.has(w)))].slice(0, 4);
}

/** A deliberately plain parse of a brief, enough to exercise the form. */
export function parseBrief(brief: string): AgentDraft {
  const text = brief.trim();
  const notes: string[] = [];
  const dollar = /\$([A-Z]{1,5})\b/.exec(text)?.[1];
  const caps = [...text.matchAll(/\b([A-Z]{2,5})\b/g)].map((m) => m[1]!).find((w) => !NOT_TICKERS.has(w));
  const ticker = dollar ?? caps;
  const lower = text.toLowerCase();
  const triggers: AgentTrigger[] = [];

  if (/earnings|reports?\b|results|quarter/.test(lower) && ticker) triggers.push({ kind: "earnings", ticker, moment: /\bcall\b/.test(lower) ? "call" : "release" });
  const forms = [...text.matchAll(/\b(8-K|10-Q|10-K|13D|S-1|Form 4)\b/gi)].map((m) => m[1]!.toUpperCase().replace("FORM ", ""));
  if ((forms.length > 0 || /\bfil(es|ing|ings)\b/.test(lower)) && ticker) triggers.push({ kind: "filing", ticker, forms: forms.length ? Array.from(new Set(forms)) : ["8-K"] });
  const pct = /(\d+(?:\.\d+)?)\s?%/.exec(text);
  if (pct && /mov|drop|jump|fall|rise|swing/.test(lower) && ticker) {
    triggers.push({ kind: "price_move", ticker, thresholdPct: Number(pct[1]), window: /week|five days|5 days/.test(lower) ? "5d" : /intraday|during the day/.test(lower) ? "intraday" : "1d" });
  }
  const macro = /\b(CPI|FOMC|payrolls|jobs report|PCE|GDP)\b/i.exec(text)?.[1] ?? (/\bfed\b/i.test(text) ? "FOMC rate decision" : null);
  if (macro) triggers.push({ kind: "macro", event: macro.length <= 4 ? macro.toUpperCase() : macro });
  const time = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  // No company: a topic in the words becomes headline keywords, as the engine reads it (main/agents/llm.ts).
  const topic = ticker || macro ? [] : topicWords(text);
  if (/every (weekday|morning|day)|each (morning|day)|daily/.test(lower)) {
    triggers.push({
      kind: "schedule",
      cadence: /weekday|before the open/.test(lower) ? "weekdays" : "daily",
      time: clockText(time),
      ...(topic.length > 0 ? { keywords: topic } : {}),
    });
  } else if (topic.length > 0) {
    triggers.push({ kind: "news", keywords: topic });
  }
  if (/\bnews\b|headline/.test(lower) && triggers.length === 0 && ticker) triggers.push({ kind: "news", ticker, keywords: [] });
  if (triggers.length === 0 && ticker) {
    triggers.push({ kind: "news", ticker, keywords: [] });
    notes.push("No clear event in the brief, so this watches news about the company. Change the trigger if you meant something else.");
  }
  if (topic.length > 0) notes.push(`Read as headlines that mention ${topic.join(", ")}.`);

  const care =
    /(?:care about|interested in)\s+([^.]+)/i.exec(text)?.[1] ?? /(?:watch(?:ing)? for|tell me (?:about|how))\s+([^.]+)/i.exec(text)?.[1] ?? "";
  const metrics: AgentMetric[] = care
    .split(/,|\band\b/)
    .map((s) => s.trim().replace(/^the\s+/i, ""))
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 6)
    .map((label, i) => ({ id: `d${i + 1}`, label: label.charAt(0).toUpperCase() + label.slice(1) }));
  if (metrics.length === 0) notes.push("No metrics named. The write-up covers the headline numbers unless you list some.");

  const keepWatching = /every time|each time|whenever|every (weekday|morning|day)|daily|keep/.test(lower);
  const first = triggers[0];
  const name = ticker
    ? `${ticker} ${first?.kind === "filing" ? "filings" : first?.kind === "price_move" ? "moves" : first?.kind === "news" ? "news" : "earnings"}`
    : first?.kind === "macro"
      ? first.event
      : first?.kind === "schedule"
        ? "Morning note"
        : "New agent";

  const oneShot = !keepWatching;
  const draft: AgentDraft = {
    name,
    brief: text,
    ticker,
    companyName: ticker ? KNOWN[ticker] : undefined,
    triggers,
    metrics,
    channels: ["digest"],
    oneShot,
    notes,
  };
  // As the engine does (main/agents/ends.ts): one question when the words are too vague,
  // the results date for "When", and an end proposed when none was named.
  if (triggers.length === 0) draft.clarify = ticker ? { field: "trigger", question: "What to watch for?" } : { field: "subject", question: "What to watch, and when?" };
  const earnings = triggers.find((t) => t.kind === "earnings");
  if (earnings) draft.nextExpectedAt = new Date(Date.now() + 6 * DAY).toISOString();
  const filing = triggers.find((t): t is Extract<AgentTrigger, { kind: "filing" }> => t.kind === "filing");
  if (oneShot && earnings && ticker) draft.ends = { kind: "earnings", ticker };
  else if (oneShot && filing) draft.ends = { kind: "filing", ticker: filing.ticker, form: filing.forms[0] ?? "8-K" };
  else draft.ends = { kind: "date", date: ymd(Date.now() + (earnings ? 184 : 90) * DAY) };
  draft.endsProposed = true;
  return draft;
}

/** The next 08:00 in New York after `now`, for a fixture's "Next check". */
function nextNyMorning(now: number): string {
  for (let h = 1; h <= 48; h++) {
    const at = new Date(now + h * HOUR);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(at);
    if (Number(parts) === 8) {
      at.setUTCMinutes(0, 0, 0);
      return at.toISOString();
    }
  }
  return new Date(now + DAY).toISOString();
}

/** A reply that reads the agent's latest report back, for the chat's shape. */
function reply(agent: Agent, reports: AgentReport[], text: string): string {
  const latest = reports[0];
  if (!latest) {
    const t = agent.triggers[0];
    return `Nothing has fired yet, so there is no report to draw on. I am watching ${agent.ticker ?? "this"} for ${t ? t.kind.replace("_", " ") : "its trigger"} and checked last ${agent.lastCheckedAt ? new Date(agent.lastCheckedAt).toLocaleString() : "recently"}.\n\nYou asked: "${text}". I can answer that once the first report is in.`;
  }
  const lines = latest.readings.slice(0, 3).map((r) => `${r.label}: ${r.value}${r.comparison ? ` (${r.comparison})` : ""}.`);
  return `From the report on ${new Date(latest.at).toLocaleDateString()}:\n${lines.join("\n")}\n\n${latest.summary.split("\n\n")[0]}`;
}

/** Builds the adapter. Each call gets its own copy of the seed. */
export function createFixtureAgents(opts: FixtureOptions = {}): AgentsBridge {
  const latency = opts.latency ?? 350;
  const now = Date.now();
  const db: Store = opts.empty ? { agents: [], reports: [], activity: [], messages: [] } : seed(now);
  const listeners = new Set<(e: AgentsEvent) => void>();
  let seq = 0;
  const emit = (e: AgentsEvent) => {
    for (const fn of listeners) fn(e);
  };
  const wait = (ms = latency) => new Promise((r) => setTimeout(r, ms));
  const ok = <T,>(data: T): AgentResult<T> => ({ ok: true, data: structuredClone(data) });
  const fail = <T,>(error = "The agent engine did not answer."): AgentResult<T> => ({ ok: false, error });
  const find = (id: string) => db.agents.find((a) => a.id === id);
  const log = (agentId: string, kind: AgentActivity["kind"], text: string, reportId?: string, lines?: AgentLine[]) => {
    const a: AgentActivity = { id: `act-x${++seq}`, agentId, at: new Date().toISOString(), kind, text, reportId, ...(lines ? { lines } : {}) };
    db.activity.push(a);
    emit({ type: "activity", activity: structuredClone(a) });
  };
  const touch = (agent: Agent, patch: Partial<Agent>) => {
    Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
    emit({ type: "agent-updated", agent: structuredClone(agent) });
    return agent;
  };

  const bridge: AgentsBridge = {
    async list() {
      if (opts.hanging) return new Promise(() => {});
      await wait();
      return opts.failing ? fail() : ok(db.agents);
    },
    async get(id) {
      await wait();
      const agent = find(id);
      if (opts.failing || !agent) return fail(agent ? undefined : "No agent with that id.");
      const detail: AgentDetail = {
        agent,
        reports: db.reports.filter((r) => r.agentId === id),
        activity: db.activity.filter((a) => a.agentId === id),
        messages: db.messages.filter((m) => m.agentId === id),
      };
      return ok(detail);
    },
    async draftFromBrief(brief) {
      await wait(latency * 3);
      if (opts.failing) return fail("The brief could not be read right now.");
      return ok(parseBrief(brief));
    },
    async create(draft) {
      await wait();
      if (opts.failing) return fail();
      const at = new Date().toISOString();
      const { notes: _notes, ...rest } = draft;
      void _notes;
      const first = rest.triggers[0];
      const { clarify: _clarify, endsProposed: _proposed, ...fields } = rest;
      void _clarify;
      void _proposed;
      const agent: Agent = {
        ...fields,
        id: `agent-${Date.now().toString(36)}`,
        status: "active",
        createdAt: at,
        updatedAt: at,
        nextCheckAt: at,
        nextExpectedAt:
          first?.kind === "schedule"
            ? nextNyMorning(Date.now())
            : first && first.kind !== "news" && first.kind !== "price_move" && first.kind !== "filing"
              ? (fields.nextExpectedAt ?? new Date(Date.now() + 6 * DAY).toISOString())
              : undefined,
        unread: 0,
      };
      db.agents.unshift(agent);
      log(agent.id, "created", "Created from your brief.", undefined, [L("activity.created", undefined, agent.triggers)]);
      // The first check, a moment later, as the engine runs it: nothing yet, and when it looks again.
      setTimeout(() => {
        const now = Date.now();
        const quick = agent.triggers.every((t) => t.kind === "filing" || t.kind === "news" || t.kind === "price_move");
        touch(agent, { lastCheckedAt: iso(now), nextCheckAt: quick ? iso(now + 15 * MIN) : nextNyMorning(now) });
      }, Math.max(600, latency * 3));
      return ok(agent);
    },
    async update(id, patch) {
      await wait();
      const agent = find(id);
      if (opts.failing || !agent) return fail();
      touch(agent, patch);
      const fields = Object.keys(patch).join(",");
      log(id, "edited", "Edited by you.", undefined, [fields ? L("activity.edited", { fields }) : L("activity.editedNone")]);
      return ok(agent);
    },
    async setStatus(id, status) {
      await wait();
      const agent = find(id);
      if (opts.failing || !agent) return fail();
      touch(agent, { status, error: undefined });
      log(id, status === "paused" ? "paused" : "resumed", status === "paused" ? "Paused by you." : "Resumed by you.", undefined, [
        L(status === "paused" ? "activity.paused" : "activity.resumed"),
      ]);
      return ok(agent);
    },
    async remove(id) {
      await wait();
      if (opts.failing) return fail();
      db.agents = db.agents.filter((a) => a.id !== id);
      emit({ type: "agent-removed", id });
      return ok({ id });
    },
    async runNow(id) {
      await wait(latency * 4);
      const agent = find(id);
      if (opts.failing || !agent) return fail();
      const at = new Date().toISOString();
      const scheduled = agent.triggers.some((t) => t.kind === "schedule");
      if (!scheduled) {
        touch(agent, { lastCheckedAt: at });
        log(id, "checked", "Checked on request. Nothing new since the last check.", undefined, [L("activity.checkedOnRequest"), L("run.nothingNew")]);
        return ok({ agentId: id, at, fired: false, note: "Nothing new since the last check.", noteLines: [L("run.nothingNew")] });
      }
      const report: AgentReport = {
        id: `rep-x${++seq}`,
        agentId: id,
        at,
        trigger: "schedule",
        headline: "No filings overnight; the group opened mixed in Asia",
        summary: "No filings from the names on your list since the last note. Samsung's preliminary third-quarter operating profit was published before the open in Seoul.",
        readings: [{ metricId: "s2", label: "Overnight filings", value: "None", verdict: "inline" }],
        sources: [{ title: "SEC EDGAR full-text search", url: "https://efts.sec.gov/LATEST/search-index?q=" }],
        read: false,
      };
      db.reports.push(report);
      touch(agent, { lastCheckedAt: at, lastFiredAt: at, unread: agent.unread + 1 });
      emit({ type: "report", report: structuredClone(report), agent: structuredClone(agent) });
      log(id, "fired", "Note written on request.", report.id, [L("activity.reported", { headline: report.headline })]);
      return ok({ agentId: id, at, fired: true, note: "A new note was written.", report });
    },
    async sendMessage(id, text) {
      await wait(latency * 4);
      const agent = find(id);
      if (opts.failing || !agent) return fail("The agent could not answer right now.");
      const at = Date.now();
      db.messages.push({ id: `msg-x${++seq}`, agentId: id, role: "user", at: new Date(at).toISOString(), text });
      const reports = db.reports.filter((r) => r.agentId === id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const msg: AgentMessage = {
        id: `msg-x${++seq}`,
        agentId: id,
        role: "agent",
        at: new Date(at + 1000).toISOString(),
        text: reply(agent, reports, text),
        reportIds: reports[0] ? [reports[0].id] : undefined,
      };
      db.messages.push(msg);
      return ok(msg);
    },
    async markRead(id) {
      await wait(80);
      const agent = find(id);
      if (!agent) return fail();
      for (const r of db.reports) if (r.agentId === id) r.read = true;
      touch(agent, { unread: 0 });
      return ok({ id });
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  // Probes for a harness: push a report as the engine would, or an open request.
  (bridge as AgentsBridge & { __fire?: (id: string) => void; __open?: (id: string) => void }).__fire = (id: string) => {
    const agent = find(id);
    if (!agent) return;
    const at = new Date().toISOString();
    const report: AgentReport = {
      id: `rep-x${++seq}`,
      agentId: id,
      at,
      trigger: agent.triggers[0]?.kind ?? "news",
      headline: `${agent.ticker ?? agent.name}: results published`,
      summary: "Results were published a moment ago. Revenue and margin are in the table below.",
      readings: agent.metrics.map((m) => ({ metricId: m.id, label: m.label, value: "n/a", expectation: m.expectation, verdict: "unclear" as const })),
      sources: [],
      read: false,
    };
    db.reports.push(report);
    touch(agent, { lastFiredAt: at, unread: agent.unread + 1 });
    emit({ type: "report", report: structuredClone(report), agent: structuredClone(agent) });
  };
  (bridge as AgentsBridge & { __open?: (id: string) => void }).__open = (id: string) => emit({ type: "open-agent", agentId: id });

  return bridge;
}
