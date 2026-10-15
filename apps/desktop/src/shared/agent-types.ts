/**
 * Agents: standing instructions a reader leaves with Falcon. "Tell me when
 * NVDA reports, and how data center revenue and gross margin came in against
 * the guide." The agent watches, writes up what happened when it happens,
 * notifies, and can be asked about it afterwards.
 *
 * This file is the contract between the main-process agent engine
 * (`src/main/agents/`) and the renderer (`components/agents/`). Both sides
 * import it; neither defines its own copy of these shapes.
 *
 * IPC surface, exposed on `window.meridian.agents` (all invoke, all return
 * `AgentResult<T>`):
 *   list()                          -> Agent[]
 *   get(id)                         -> AgentDetail
 *   draftFromBrief(brief)           -> AgentDraft     (the model parses the reader's own words)
 *   create(draft)                   -> Agent
 *   update(id, patch: AgentPatch)   -> Agent
 *   setStatus(id, status)           -> Agent          ("active" | "paused")
 *   remove(id)                      -> { id }
 *   runNow(id)                      -> AgentRun        (check immediately, outside the schedule)
 *   sendMessage(id, text)           -> AgentMessage    (the agent's reply; history is in AgentDetail)
 *   markRead(id)                    -> { id }          (clears unread reports for this agent)
 * and one push channel:
 *   onEvent(cb: (e: AgentPushEvent) => void) -> unsubscribe
 * (IPC channels are `agents:<method>` and `agents:event`.)
 *
 * Additive changes made by the engine (all optional or new union members, so
 * nothing written against the first version breaks):
 *   - `filing` trigger: `insiderBuysOnly?: boolean`, for Form 4 watches that
 *     care about open-market purchases only.
 *   - `Agent.nextAction?: string`: one line on what the agent does next
 *     ("Checks SEC filings every 10 minutes until NVDA reports on 2026-11-19").
 *   - `Agent.latestReport?`: id, headline, time and read state of the newest
 *     report, so a list or a dashboard card needs no `get(id)` per agent.
 *   - `AgentPushEvent` member `{ type: "open-agent"; agentId; reportId? }`:
 *     sent when the reader clicks an agent's desktop notification, asking the
 *     app to show that agent (and that report).
 *   - `AgentLine`, and three optional fields that carry it:
 *     `AgentActivity.lines`, `Agent.nextActionLines` and `AgentRun.noteLines`.
 *     The engine writes its fixed-template sentences in English (`text`,
 *     `nextAction`, `note`, still always set) and, beside them, the same
 *     sentences as codes with their values, so the renderer can say them in
 *     the reader's language. A reader that does not know a code, or an entry
 *     stored before codes existed, shows the English string instead.
 *   - `Agent.ends?` (`AgentEnds`): when the agent stops on its own, a date,
 *     the next results release or the next filing of a form. Every agent
 *     created from here on has one (the engine proposes it when the reader
 *     named none); agents stored before it have none and run until removed.
 *   - `Agent.nextCheckAt?`: when the engine looks again, for "Next check".
 *   - `AgentDraft.clarify?` and `AgentDraft.endsProposed?`: the one question
 *     the create flow asks when the words are too vague to act on, and
 *     whether `ends` was proposed rather than read from the words.
 *   - Agents need not be about a company: `schedule` takes `keywords?` (a
 *     topic for a market digest), and a `news` trigger may have neither a
 *     ticker nor keywords (the market's headlines).
 *   - `AgentChannel` member `"digest"`: the report waits for one summary
 *     notification a day (08:00 local) instead of its own. Every report is in
 *     the app either way; an agent with no channel is in-app only.
 */

/**
 * One engine sentence as a stable code and the values it fills in. The
 * renderer looks the code up as `agents.line.<code>` in its agents message
 * table (`renderer/lib/i18n/messages/areas/agents.ts`); several lines in a row
 * read as consecutive sentences.
 *
 * Param conventions, so the renderer formats them for the reader's locale:
 *   - `date`: a calendar date, YYYY-MM-DD.
 *   - `at`: an instant, ISO 8601.
 *   - `count`: a number that picks the plural form ("1 minute", "5 minutes").
 *   - `fields`: comma-separated `AgentPatch` keys, said as field names.
 * Every other value is shown as given: tickers, SEC form names, event names,
 * percentages already formatted, headlines and error text from a provider.
 */
export type AgentLine = {
  code: string;
  params?: Record<string, string | number>;
  /** For codes that name what an agent watches ("created"): the triggers, said by the renderer. */
  triggers?: AgentTrigger[];
};

export type AgentResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** What wakes an agent up. An agent may have several. */
export type AgentTrigger =
  /** A company's quarterly results. Fires when the release (or the call) lands. */
  | { kind: "earnings"; ticker: string; moment: "release" | "call" }
  /** An SEC filing of one of these forms (8-K, 10-Q, 10-K, 4, 13D, ...). */
  | {
      kind: "filing";
      ticker: string;
      forms: string[];
      /** Form 4 only: count open-market purchases (code P) and nothing else. */
      insiderBuysOnly?: boolean;
    }
  /** Price moves more than `thresholdPct` (absolute) over the window. */
  | { kind: "price_move"; ticker: string; thresholdPct: number; window: "intraday" | "1d" | "5d" }
  /**
   * News about a ticker, optionally narrowed by keywords; with no ticker, the
   * market's headlines that mention the keywords (a topic or a sector), or
   * with neither, the market's headlines as a whole.
   */
  | { kind: "news"; ticker?: string; keywords: string[] }
  /** A macro release from the calendar (CPI, FOMC, payrolls, ...). */
  | { kind: "macro"; event: string }
  /**
   * No event at all: a write-up on a fixed cadence. `time` is HH:mm local.
   * With no ticker on the agent, it covers the market's headlines, narrowed
   * to `keywords` when given (a topic: "semiconductor", "supplier").
   */
  | { kind: "schedule"; cadence: "daily" | "weekdays" | "weekly"; time: string; weekday?: number; keywords?: string[] };

export type AgentTriggerKind = AgentTrigger["kind"];

/** One number the reader cares about, with what they expect if they said. */
export type AgentMetric = {
  id: string;
  label: string;
  /** The reader's bar, in their words: "above $30B", "guide raised", "margin over 75%". */
  expectation?: string;
};

/**
 * Where a finding goes, beyond the app itself (every report is in the app).
 * `desktop` is a notification per report, `digest` one summary notification
 * a day, `mobile_push` is stored now and delivered once the mobile app exists.
 */
export type AgentChannel = "desktop" | "mobile_push" | "digest";

/**
 * When an agent stops on its own. Dates are New York calendar dates,
 * YYYY-MM-DD, and the agent ends after that day.
 *   date      after this date
 *   earnings  after the company's next results release has been reported
 *   filing    after the company's next filing of this form
 */
export type AgentEnds =
  | { kind: "date"; date: string }
  | { kind: "earnings"; ticker: string }
  | { kind: "filing"; ticker: string; form: string };

/**
 * The one thing the create flow asks when the words are too vague to act on.
 * Agents need not be about a company, so this is never "which company": it
 * asks for what is actually missing. `question` is English; the renderer
 * says it by `field`.
 *   subject  nothing to watch and nothing to run on ("help me out")
 *   trigger  a company or topic is named, but no event and no schedule
 */
export type AgentClarify = { field: "subject" | "trigger"; question: string };

export type AgentStatus = "active" | "paused" | "completed" | "error";

export type Agent = {
  id: string;
  /** Supabase user id when signed in, so agents stay with their owner. */
  userId?: string;
  name: string;
  /** The reader's original request, kept verbatim. */
  brief: string;
  /** Primary company, when the agent is about one. */
  ticker?: string;
  companyName?: string;
  triggers: AgentTrigger[];
  metrics: AgentMetric[];
  /** Extra guidance for the write-up: tone, length, what to compare against. */
  instructions?: string;
  channels: AgentChannel[];
  status: AgentStatus;
  /** Done after the first time it fires ("tell me when they report"), or keeps watching. */
  oneShot: boolean;
  /** When it stops on its own. Absent on agents stored before it existed. */
  ends?: AgentEnds;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  /** Best known time of the next thing it is waiting for (e.g. the earnings date). */
  nextExpectedAt?: string;
  /** When the engine looks again (ISO). Absent while paused or once done. */
  nextCheckAt?: string;
  /** What it does next, in one line. Set by the engine after every check. */
  nextAction?: string;
  /** `nextAction` as codes, for the reader's language. Absent when it has no fixed wording. */
  nextActionLines?: AgentLine[];
  /** The newest report in brief, kept current by the engine. */
  latestReport?: Pick<AgentReport, "id" | "headline" | "at" | "read">;
  /** Reports not yet opened. */
  unread: number;
  /** Last error, shown on the card when status is "error". */
  error?: string;
};

/** What `draftFromBrief` returns: an agent the reader can still edit before saving. */
export type AgentDraft = Omit<
  Agent,
  "id" | "userId" | "status" | "createdAt" | "updatedAt" | "lastCheckedAt" | "lastFiredAt" | "unread" | "error" | "nextCheckAt"
> & {
  /** Things the parser was unsure of, to show next to the form. */
  notes?: string[];
  /** The one question to ask before this draft can be shown, when the words were too vague. */
  clarify?: AgentClarify;
  /** `ends` was proposed by Falcon, not read from the reader's words. */
  endsProposed?: boolean;
};

export type AgentPatch = Partial<
  Pick<Agent, "name" | "brief" | "ticker" | "companyName" | "triggers" | "metrics" | "instructions" | "channels" | "oneShot" | "ends">
>;

/** How one metric came in. */
export type AgentMetricReading = {
  metricId: string;
  label: string;
  value: string;
  expectation?: string;
  /** Against the reader's bar, or against consensus when the reader gave none. */
  verdict: "above" | "below" | "inline" | "unclear";
  /** Prior period or consensus, for context. */
  comparison?: string;
};

export type AgentSource = { title: string; url?: string; publishedAt?: string };

/** The write-up an agent produces when it fires. */
export type AgentReport = {
  id: string;
  agentId: string;
  at: string;
  trigger: AgentTriggerKind;
  headline: string;
  /** A few short paragraphs. Plain, descriptive, no advice. */
  summary: string;
  readings: AgentMetricReading[];
  sources: AgentSource[];
  read: boolean;
};

/** One entry on the agent's timeline. */
export type AgentActivity = {
  id: string;
  agentId: string;
  at: string;
  kind: "created" | "edited" | "checked" | "waiting" | "fired" | "notified" | "paused" | "resumed" | "completed" | "error";
  /** One line, as shown on the timeline. */
  text: string;
  /** `text` as codes, for the reader's language. Absent when it has no fixed wording. */
  lines?: AgentLine[];
  reportId?: string;
};

export type AgentMessage = {
  id: string;
  agentId: string;
  role: "user" | "agent";
  at: string;
  text: string;
  /** Reports the reply drew on. */
  reportIds?: string[];
};

export type AgentDetail = {
  agent: Agent;
  reports: AgentReport[];
  activity: AgentActivity[];
  messages: AgentMessage[];
};

export type AgentRun = {
  agentId: string;
  at: string;
  fired: boolean;
  /** Why it did or did not fire, in one line. */
  note: string;
  /** `note` as codes, for the reader's language. Absent when it has no fixed wording (a headline). */
  noteLines?: AgentLine[];
  report?: AgentReport;
};

export type AgentPushEvent =
  | { type: "agent-updated"; agent: Agent }
  | { type: "agent-removed"; id: string }
  | { type: "report"; report: AgentReport; agent: Agent }
  | { type: "activity"; activity: AgentActivity }
  | { type: "message"; message: AgentMessage }
  /** The reader clicked this agent's notification: show it, and the report when given. */
  | { type: "open-agent"; agentId: string; reportId?: string };
