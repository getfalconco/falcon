import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentActivity,
  AgentDetail,
  AgentDraft,
  AgentLine,
  AgentMessage,
  AgentPushEvent,
  AgentReport,
  AgentResult,
  AgentRun,
  AgentTrigger,
} from "../../shared/agent-types";
import { deliveryFor, type DeliveryChannel, type DeliveryResult } from "./channels/types";
import { digestDue, localYmd } from "./channels/digest";
import type { DigestItem, DigestOutcome } from "./channels/desktop";
import { describeEnds, endReached, endedLine, endsInstantMs, proposeEnds } from "./ends";
import { gatherMaterial } from "./gather";
import { draftFromBriefWithModel, factsOnlyReport, heuristicDraft, writeReply, writeReport, type AgentModelCaller } from "./llm";
import type { AgentDataSources } from "./sources";
import { AgentStore, type AgentEngineState } from "./store";
import { checkTrigger, line, triggerSignature, type TriggerCheck, type TriggerEvent } from "./triggers";
import { DAY_MS, HOUR_MS, MINUTE_MS, nyInstant, nyYmd } from "./time";
import { LIMITS, cleanBlock, requireId, validateDraft, validatePatch } from "./validate";

/**
 * The agent engine: the IPC surface in `shared/agent-types.ts`, the scheduler
 * that checks agents while the app runs, and the path from a fired trigger to
 * a stored report, a notification and a timeline entry.
 *
 * Everything it touches is injected (store root, account, data sources, the
 * model caller, delivery channels, the push to the renderer), so the whole
 * flow runs in a test with fakes. `register-agents-handlers.ts` wires the
 * live pieces and Electron.
 *
 * Pacing. Each check returns when it is worth looking again (ten minutes on
 * the day a company reports, twice a day the month before), and the scheduler
 * honours it; a failing check backs off from 5 minutes to 6 hours. Checks run
 * one at a time, and the data sources cache, so twenty agents never become
 * twenty bursts against a provider.
 *
 * Language. Timeline entries, `nextAction` and a run's note are written in
 * English and, beside them, as `AgentLine` codes (shared/agent-types.ts), so
 * the renderer can say them in the reader's language. Report text and chat
 * replies come from the model and are not coded.
 */

export type AgentEngineDeps = {
  root: string;
  /** The signed-in account's key ("anon" when nobody is). */
  userKey: () => string;
  /** The Supabase user id when signed in, stamped on new agents. */
  userId: () => string | undefined;
  sources: AgentDataSources;
  /** The model caller, or null when no model is configured right now. */
  caller: () => AgentModelCaller | null;
  /** Delivery channels by name; mobile push gets the account's store for its outbox. */
  channels: (store: AgentStore) => DeliveryChannel[];
  emit: (event: AgentPushEvent) => void;
  /** Called on every scheduler tick (flushes notifications held for quiet hours). */
  onTick?: () => void;
  /**
   * Sends the daily digest as one notification. "held" (quiet hours) means
   * try again on a later tick; anything else counts as sent for the day.
   * Absent: no digest is sent (the reports are still in the app).
   */
  sendDigest?: (items: readonly DigestItem[]) => DigestOutcome;
  now?: () => Date;
  newId?: () => string;
  log?: (message: string) => void;
};

/** How long to wait after `failures` consecutive failed checks. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 5 * MINUTE_MS;
  return Math.min(6 * HOUR_MS, 5 * MINUTE_MS * 2 ** (failures - 1));
}

/** Attempts at a write-up before a facts-only report goes out instead. */
const MAX_WRITEUP_ATTEMPTS = 3;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 15_000;

function ok<T>(data: T): AgentResult<T> {
  return { ok: true, data };
}

function fail(err: unknown): AgentResult<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function describeTrigger(t: AgentTrigger): string {
  switch (t.kind) {
    case "earnings":
      return `${t.ticker} results${t.moment === "call" ? " and call" : ""}`;
    case "filing":
      return t.insiderBuysOnly ? `${t.ticker} insider purchases` : `${t.ticker} ${t.forms.join(", ")} filings`;
    case "price_move":
      return `${t.ticker} moves of ${t.thresholdPct}% (${t.window})`;
    case "news":
      return `news about ${t.ticker ?? t.keywords.join(", ")}${t.ticker && t.keywords.length > 0 ? ` (${t.keywords.join(", ")})` : ""}`;
    case "macro":
      return `${t.event} releases`;
    case "schedule":
      return `a ${t.cadence} digest at ${t.time}`;
  }
}

export class AgentEngine {
  private readonly deps: AgentEngineDeps;
  private readonly inflight = new Map<string, Promise<AgentRun>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = true;

  constructor(deps: AgentEngineDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  private store(): AgentStore {
    return new AgentStore(this.deps.root, this.deps.userKey());
  }

  private log(message: string): void {
    (this.deps.log ?? ((m: string) => console.info(`[agents] ${m}`)))(message);
  }

  private activity(
    store: AgentStore,
    agentId: string,
    kind: AgentActivity["kind"],
    text: string,
    opts: { reportId?: string; lines?: AgentLine[] } = {},
  ): AgentActivity {
    const { reportId, lines } = opts;
    const entry: AgentActivity = {
      id: this.newId(),
      agentId,
      at: this.now().toISOString(),
      kind,
      text,
      ...(lines && lines.length > 0 ? { lines } : {}),
      ...(reportId ? { reportId } : {}),
    };
    const { activity } = store.addActivity(entry);
    this.deps.emit({ type: "activity", activity });
    return activity;
  }

  private emitAgent(agent: Agent | null): void {
    if (agent) this.deps.emit({ type: "agent-updated", agent });
  }

  private requireAgent(store: AgentStore, id: unknown): Agent {
    const agent = store.get(requireId(id));
    if (!agent) throw new Error("That agent no longer exists.");
    return agent;
  }

  /**
   * Tickers must be listed. A catalog that cannot be read does not block the
   * reader: the shape was already checked and the agent can say so later.
   */
  private async checkTickers(tickers: Array<string | undefined>): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    for (const t of new Set(tickers.filter((x): x is string => Boolean(x)))) {
      let hit: Awaited<ReturnType<AgentDataSources["lookupTicker"]>>;
      try {
        hit = await this.deps.sources.lookupTicker(t);
      } catch {
        continue;
      }
      if (!hit) throw new Error(`${t} is not in the US stock list.`);
      names[t] = hit.companyName;
    }
    return names;
  }

  /* ---------------------------------------------------------------- */
  /* IPC surface                                                       */
  /* ---------------------------------------------------------------- */

  list(): AgentResult<Agent[]> {
    try {
      return ok(this.store().list());
    } catch (err) {
      return fail(err);
    }
  }

  get(id: unknown): AgentResult<AgentDetail> {
    try {
      const store = this.store();
      const agent = this.requireAgent(store, id);
      return ok({
        agent,
        reports: store.reports(agent.id).reverse(),
        activity: store.activity(agent.id).reverse(),
        messages: store.messages(agent.id),
      });
    } catch (err) {
      return fail(err);
    }
  }

  async draftFromBrief(brief: unknown): Promise<AgentResult<AgentDraft>> {
    try {
      if (typeof brief !== "string" || !brief.trim()) throw new Error("Describe what the agent watches for.");
      const today = nyYmd(this.now());
      let draft: AgentDraft;
      try {
        draft = await draftFromBriefWithModel(brief, { caller: this.deps.caller(), sources: this.deps.sources, today });
      } catch (err) {
        // The model is down or unreadable: a heuristic draft beats an error the reader cannot act on.
        this.log(`draft fell back to the heuristic parser: ${err instanceof Error ? err.message : String(err)}`);
        draft = await heuristicDraft(cleanBlock(brief, LIMITS.briefChars), { sources: this.deps.sources });
      }
      return ok(await this.finishDraft(draft, today));
    } catch (err) {
      return fail(err);
    }
  }

  /**
   * What every draft gets before the reader sees it: the date of the results
   * it waits for, when the calendar has one (for "When"), and an end, proposed
   * when the words named none.
   */
  private async finishDraft(draft: AgentDraft, today: string): Promise<AgentDraft> {
    const earnings = draft.triggers.find((t): t is Extract<AgentTrigger, { kind: "earnings" }> => t.kind === "earnings");
    if (earnings) {
      try {
        const read = await this.deps.sources.earningsDates(earnings.ticker);
        const date = read.dates.find((d) => d >= today);
        if (date) draft.nextExpectedAt = nyInstant(date, "08:00").toISOString();
      } catch {
        // The date is a nicety on the confirm card; the agent finds it on its first check.
      }
    }
    if (!draft.ends) {
      draft.ends = proposeEnds(draft, today);
      draft.endsProposed = true;
    }
    return draft;
  }

  async create(raw: unknown): Promise<AgentResult<Agent>> {
    try {
      const draft = validateDraft(raw);
      const names = await this.checkTickers([draft.ticker, ...draft.triggers.map((t) => ("ticker" in t ? t.ticker : undefined))]);
      const store = this.store();
      const at = this.now().toISOString();
      const userId = this.deps.userId();
      const agent: Agent = {
        id: this.newId(),
        ...(userId ? { userId } : {}),
        name: draft.name,
        brief: draft.brief,
        ...(draft.ticker ? { ticker: draft.ticker, companyName: names[draft.ticker] ?? draft.companyName } : {}),
        triggers: draft.triggers,
        metrics: draft.metrics,
        ...(draft.instructions ? { instructions: draft.instructions } : {}),
        channels: draft.channels,
        status: "active",
        oneShot: draft.oneShot,
        ends: draft.ends ?? proposeEnds(draft, nyYmd(this.now())),
        createdAt: at,
        updatedAt: at,
        nextCheckAt: at,
        unread: 0,
        nextAction: "First check in a few seconds.",
        nextActionLines: [line("next.firstCheck")],
      };
      store.put(agent);
      store.setState(agent.id, { failures: 0, firedKeys: [], lastFiredByTrigger: {}, nextCheckAt: at });
      this.activity(store, agent.id, "created", `Created. Watching ${agent.triggers.map(describeTrigger).join("; ")}.`, {
        lines: [{ code: "activity.created", triggers: agent.triggers }],
      });
      this.emitAgent(agent);
      // The first check runs straight away so the card shows a date and a plan, not a blank.
      this.soon(agent.id);
      return ok(agent);
    } catch (err) {
      return fail(err);
    }
  }

  async update(id: unknown, raw: unknown): Promise<AgentResult<Agent>> {
    try {
      const store = this.store();
      const current = this.requireAgent(store, id);
      const patch = validatePatch(raw, current.ticker);
      const nextTicker = "ticker" in patch ? patch.ticker : current.ticker;
      const triggers = patch.triggers ?? current.triggers;
      const names = await this.checkTickers([nextTicker, ...triggers.map((t) => ("ticker" in t ? t.ticker : undefined))]);
      const changed = Object.keys(patch);
      const updated = store.update(current.id, (a) => {
        const next: Agent = { ...a, ...patch, updatedAt: this.now().toISOString() };
        if (!next.ticker) {
          delete next.ticker;
          delete next.companyName;
        } else if (patch.ticker && names[patch.ticker]) {
          next.companyName = names[patch.ticker];
        }
        if (!next.instructions) delete next.instructions;
        return next;
      });
      if (!updated) throw new Error("That agent no longer exists.");
      if (patch.triggers || patch.ends) {
        const state = store.state(updated.id);
        store.setState(updated.id, { ...state, nextCheckAt: this.now().toISOString(), failures: 0 });
        this.soon(updated.id);
      }
      this.activity(store, updated.id, "edited", `Edited: ${changed.length > 0 ? changed.join(", ") : "no fields"}.`, {
        lines: [changed.length > 0 ? line("activity.edited", { fields: changed.join(",") }) : line("activity.editedNone")],
      });
      this.emitAgent(updated);
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  }

  setStatus(id: unknown, status: unknown): AgentResult<Agent> {
    try {
      if (status !== "active" && status !== "paused") throw new Error('Status must be "active" or "paused".');
      const store = this.store();
      const current = this.requireAgent(store, id);
      if (current.status === status) return ok(current);
      const updated = store.update(current.id, (a) => {
        const next: Agent = { ...a, status, updatedAt: this.now().toISOString() };
        delete next.error;
        next.nextAction = status === "paused" ? "Paused. Nothing is checked until it is resumed." : "Checks again in a few seconds.";
        next.nextActionLines = [line(status === "paused" ? "next.paused" : "next.checksSoon")];
        if (status === "paused") delete next.nextCheckAt;
        else next.nextCheckAt = this.now().toISOString();
        return next;
      });
      if (!updated) throw new Error("That agent no longer exists.");
      if (status === "active") {
        const state = store.state(updated.id);
        store.setState(updated.id, { ...state, failures: 0, nextCheckAt: this.now().toISOString() });
        this.soon(updated.id);
      }
      this.activity(store, updated.id, status === "paused" ? "paused" : "resumed", status === "paused" ? "Paused." : "Resumed.", {
        lines: [line(status === "paused" ? "activity.paused" : "activity.resumed")],
      });
      this.emitAgent(updated);
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  }

  remove(id: unknown): AgentResult<{ id: string }> {
    try {
      const agentId = requireId(id);
      if (!this.store().remove(agentId)) throw new Error("That agent no longer exists.");
      this.deps.emit({ type: "agent-removed", id: agentId });
      return ok({ id: agentId });
    } catch (err) {
      return fail(err);
    }
  }

  markRead(id: unknown): AgentResult<{ id: string }> {
    try {
      const store = this.store();
      const agent = this.requireAgent(store, id);
      store.markReportsRead(agent.id);
      // Always confirmed with agent-updated: the list clears its badge on that event.
      this.emitAgent(
        store.update(agent.id, (a) => ({ ...a, unread: 0, ...(a.latestReport ? { latestReport: { ...a.latestReport, read: true } } : {}) })),
      );
      return ok({ id: agent.id });
    } catch (err) {
      return fail(err);
    }
  }

  async runNow(id: unknown): Promise<AgentResult<AgentRun>> {
    try {
      return ok(await this.runAgent(requireId(id), true));
    } catch (err) {
      return fail(err);
    }
  }

  async sendMessage(id: unknown, text: unknown): Promise<AgentResult<AgentMessage>> {
    try {
      const store = this.store();
      const agent = this.requireAgent(store, id);
      const question = cleanBlock(text, LIMITS.messageChars);
      if (!question) throw new Error("Write a question first.");
      if (typeof text === "string" && text.trim().length > LIMITS.messageChars) {
        throw new Error(`Keep questions under ${LIMITS.messageChars} characters.`);
      }
      const reports = store.reports(agent.id).slice(-3).reverse();
      const history = store.messages(agent.id).slice(-12);
      const freshFacts = await this.freshFacts(agent, store.state(agent.id));
      const reply = await writeReply({ agent, reports, history, freshFacts, question }, this.deps.caller());
      const at = this.now();
      const userMessage: AgentMessage = { id: this.newId(), agentId: agent.id, role: "user", at: at.toISOString(), text: question };
      const agentMessage: AgentMessage = {
        id: this.newId(),
        agentId: agent.id,
        role: "agent",
        // A millisecond later, so the pair always sorts question first.
        at: new Date(at.getTime() + 1).toISOString(),
        text: reply.text,
        ...(reply.reportIds.length > 0 ? { reportIds: reply.reportIds } : {}),
      };
      store.addMessages(agent.id, [userMessage, agentMessage]);
      this.deps.emit({ type: "message", message: userMessage });
      this.deps.emit({ type: "message", message: agentMessage });
      return ok(agentMessage);
    } catch (err) {
      return fail(err);
    }
  }

  /** Lines read fresh for a chat answer. Each read is optional. */
  private async freshFacts(agent: Agent, state: AgentEngineState): Promise<string[]> {
    const facts: string[] = [`Now: ${this.now().toISOString()}.`];
    const t = agent.ticker;
    if (!t) return facts;
    const { sources } = this.deps;
    const [quote, news, filings] = await Promise.allSettled([sources.quote(t), sources.news(t), sources.filings(t)]);
    if (quote.status === "fulfilled") {
      const q = quote.value;
      facts.push(`${q.symbol} last ${q.price}, ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}% against the previous close (${q.session} session, as of ${q.asOf}).`);
    }
    if (news.status === "fulfilled") {
      const cutoff = this.now().getTime() - 3 * DAY_MS;
      for (const n of news.value.filter((x) => !x.publishedAt || Date.parse(x.publishedAt) > cutoff).slice(0, 5)) {
        facts.push(`Headline${n.publishedAt ? ` ${n.publishedAt.slice(0, 10)}` : ""}${n.source ? `, ${n.source}` : ""}: ${n.title}`);
      }
    }
    if (filings.status === "fulfilled") {
      const recent = filings.value.slice(0, 5).map((f) => `${f.form} (${f.filedAt})`);
      if (recent.length > 0) facts.push(`Latest SEC filings: ${recent.join(", ")}.`);
    }
    const next = state.earnings?.[t];
    if (next) facts.push(`Next earnings date on the provider calendar: ${next.date}${next.estimated ? " (estimated)" : ""}.`);
    return facts;
  }

  /* ---------------------------------------------------------------- */
  /* Checks and reports                                                */
  /* ---------------------------------------------------------------- */

  /** One check of one agent. Runs for the same agent never overlap: a second caller shares the first run. */
  runAgent(id: string, manual: boolean): Promise<AgentRun> {
    const store = this.store();
    const key = `${store.dir}|${id}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.runAgentOnce(store, id, manual).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async runAgentOnce(store: AgentStore, id: string, manual: boolean): Promise<AgentRun> {
    const agent = store.get(id);
    if (!agent) throw new Error("That agent no longer exists.");
    const now = this.now();
    const state = store.state(id);
    const checks: TriggerCheck[] = [];
    const errors: string[] = [];
    let event: TriggerEvent | null = null;

    for (const trigger of agent.triggers) {
      try {
        const check = await checkTrigger(trigger, { agent, state, sources: this.deps.sources, now });
        checks.push(check);
        if (check.status === "fired" && !event && !check.event.keys.every((k) => state.firedKeys.includes(k))) {
          event = check.event;
          break;
        }
      } catch (err) {
        errors.push(`${describeTrigger(trigger)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (event) return this.fire(store, agent, state, event, now, manual);

    // Nothing to report this time: the end, when it has come, comes now.
    if (agent.ends && (await endReached(agent, state, this.deps.sources, now))) return this.end(store, agent, state, now);

    const waiting = checks.filter((c): c is Extract<TriggerCheck, { status: "waiting" }> => c.status === "waiting");
    const allFailed = errors.length > 0 && waiting.length === 0;
    const failures = allFailed ? state.failures + 1 : 0;
    const soonest = Math.min(...checks.map((c) => c.nextCheckMs), ...(errors.length > 0 ? [backoffMs(1)] : []));
    let nextMs = allFailed ? backoffMs(failures) : Number.isFinite(soonest) ? soonest : HOUR_MS;
    // A dated end gets one last look as it passes, not hours after.
    const endAt = endsInstantMs(agent.ends);
    if (endAt !== null && endAt > now.getTime()) nextMs = Math.min(nextMs, endAt - now.getTime() + MINUTE_MS);
    const nextExpected = waiting
      .map((c) => c.nextExpectedAt)
      .filter((x): x is string => Boolean(x) && Date.parse(x!) > now.getTime() - DAY_MS)
      .sort()[0];
    const detail = waiting.map((c) => c.detail).slice(0, 2).join(" ");
    const detailLines = waiting.slice(0, 2).flatMap((c) => c.detailLines);
    const note = waiting[0]?.note ?? "";
    const noteLines = waiting[0]?.noteLines ?? [];
    const firstError = errors[0]?.slice(0, 200) ?? "";

    const nextCheckAt = new Date(now.getTime() + nextMs).toISOString();
    store.setState(id, { ...state, failures, nextCheckAt });
    const updated = store.update(id, (a) => {
      const next: Agent = { ...a, lastCheckedAt: now.toISOString() };
      if (a.status === "active" || a.status === "error") next.nextCheckAt = nextCheckAt;
      if (nextExpected) next.nextExpectedAt = nextExpected;
      else delete next.nextExpectedAt;
      if (allFailed) {
        if (a.status === "active" || a.status === "error") next.status = "error";
        next.error = errors[0]!.slice(0, 300);
        next.nextAction = `Retrying in ${Math.round(nextMs / MINUTE_MS)} minutes.`;
        next.nextActionLines = [line("next.retrying", { count: Math.round(nextMs / MINUTE_MS) })];
      } else {
        if (a.status === "error") next.status = "active";
        delete next.error;
        next.nextAction = detail || a.nextAction;
        if (detail) next.nextActionLines = detailLines;
      }
      return next;
    });

    const checkFailed = [line("activity.checkFailed", { error: firstError })];
    if (allFailed) {
      this.activity(store, id, "error", `Check failed: ${firstError}`, { lines: checkFailed });
    } else {
      if (agent.status === "error") this.activity(store, id, "resumed", "Checks are working again.", { lines: [line("activity.checksWorking")] });
      if (manual) {
        this.activity(store, id, "checked", `Checked on request. ${note}`.trim(), { lines: [line("activity.checkedOnRequest"), ...noteLines] });
      } else if (note) this.activity(store, id, "waiting", note, { lines: noteLines });
      if (errors.length > 0) {
        this.activity(store, id, "error", `Part of the check failed: ${firstError}`, { lines: [line("activity.partFailed", { error: firstError })] });
      }
    }
    this.emitAgent(updated);
    return {
      agentId: id,
      at: now.toISOString(),
      fired: false,
      note: allFailed ? `Check failed: ${firstError}` : detail || note || "Nothing new.",
      noteLines: allFailed ? checkFailed : detail ? detailLines : note ? noteLines : [line("run.nothingNew")],
    };
  }

  private async fire(store: AgentStore, agent: Agent, state: AgentEngineState, event: TriggerEvent, now: Date, manual: boolean): Promise<AgentRun> {
    const material = await gatherMaterial(event, agent, state, this.deps.sources, now);
    const ids = { newId: () => this.newId(), now };
    let report: AgentReport;
    try {
      report = await writeReport(agent, event, material, { caller: this.deps.caller(), ...ids });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = state.pendingEvent?.key === event.keys[0] ? state.pendingEvent.attempts + 1 : 1;
      if (attempts < MAX_WRITEUP_ATTEMPTS) {
        const retryMs = backoffMs(attempts);
        const retryAt = new Date(now.getTime() + retryMs).toISOString();
        store.setState(agent.id, { ...state, pendingEvent: { key: event.keys[0]!, attempts }, nextCheckAt: retryAt });
        const updated = store.update(agent.id, (a) => ({
          ...a,
          lastCheckedAt: now.toISOString(),
          nextCheckAt: retryAt,
          ...(a.status === "active" || a.status === "error" ? { status: "error" as const } : {}),
          error: `Write-up failed: ${message}`.slice(0, 300),
          nextAction: `The event happened; retrying the write-up in ${Math.round(retryMs / MINUTE_MS)} minutes.`,
          nextActionLines: [line("next.writeupRetry", { count: Math.round(retryMs / MINUTE_MS) })],
        }));
        this.activity(store, agent.id, "error", `Write-up failed: ${message}`.slice(0, 240), {
          lines: [line("activity.writeupFailed", { error: message.slice(0, 220) })],
        });
        this.emitAgent(updated);
        return { agentId: agent.id, at: now.toISOString(), fired: false, note: `${event.title} The write-up failed: ${message}` };
      }
      // Out of attempts: the reader still hears about the event, from the facts alone.
      report = factsOnlyReport(agent, event, material, ids);
    }

    store.addReport(report);
    const sig = triggerSignature(event.trigger);
    const nextCheckAt = new Date(now.getTime() + (agent.oneShot ? 365 * DAY_MS : 5 * MINUTE_MS)).toISOString();
    store.setState(agent.id, {
      ...state,
      failures: 0,
      pendingEvent: undefined,
      firedKeys: [...state.firedKeys, ...event.keys],
      lastFiredByTrigger: { ...state.lastFiredByTrigger, [sig]: now.toISOString() },
      // A one-shot agent is done; a standing one looks again soon for the next event.
      nextCheckAt,
    });
    let updated = store.update(agent.id, (a) => {
      const next: Agent = {
        ...a,
        lastCheckedAt: now.toISOString(),
        lastFiredAt: now.toISOString(),
        unread: (a.unread ?? 0) + 1,
        latestReport: { id: report.id, headline: report.headline, at: report.at, read: false },
        nextAction: a.oneShot ? "Done. It reported once, as asked." : "Reported. Watching for the next one.",
        nextActionLines: [line(a.oneShot ? "next.done" : "next.reportedWatching")],
      };
      delete next.error;
      if (a.oneShot && a.status !== "paused") next.status = "completed";
      else if (a.status === "error") next.status = "active";
      if (next.status === "active") next.nextCheckAt = nextCheckAt;
      else delete next.nextCheckAt;
      return next;
    });
    if (!updated) return { agentId: agent.id, at: now.toISOString(), fired: true, note: event.title, report };

    this.activity(store, agent.id, "fired", `Reported: ${report.headline}`, {
      reportId: report.id,
      lines: [line("activity.reported", { headline: report.headline })],
    });
    this.deps.emit({ type: "report", report, agent: updated });

    const results: DeliveryResult[] = [];
    const delivery = deliveryFor(updated, report);
    for (const channel of this.deps.channels(store)) {
      if (!updated.channels.includes(channel.channel)) continue;
      try {
        results.push(channel.deliver(delivery));
      } catch {
        results.push({
          channel: channel.channel,
          status: "failed",
          note: `The ${channel.channel} delivery failed.`,
          line: line(
            channel.channel === "desktop" ? "delivery.desktopFailed" : channel.channel === "digest" ? "delivery.digestFailed" : "delivery.mobileFailed",
          ),
        });
      }
    }
    if (results.length > 0) {
      const lines = results.every((r) => r.line) ? results.map((r) => r.line!) : undefined;
      this.activity(store, agent.id, "notified", results.map((r) => r.note).join(" "), { reportId: report.id, lines });
    }
    if (updated.status === "completed") {
      this.activity(store, agent.id, "completed", "Completed. A one-shot agent ends after its first report.", {
        lines: [line("activity.completed")],
      });
    }
    updated = store.get(agent.id) ?? updated;
    this.emitAgent(updated);
    this.log(`${agent.id} fired (${event.kind})${manual ? " on request" : ""}`);
    return { agentId: agent.id, at: now.toISOString(), fired: true, note: report.headline, report };
  }

  /** The agent's end has come: it completes, says so, and is checked no more. */
  private end(store: AgentStore, agent: Agent, state: AgentEngineState, now: Date): AgentRun {
    const ends = agent.ends!;
    store.setState(agent.id, { ...state, failures: 0, nextCheckAt: new Date(now.getTime() + 365 * DAY_MS).toISOString() });
    const updated = store.update(agent.id, (a) => {
      const next: Agent = {
        ...a,
        lastCheckedAt: now.toISOString(),
        status: a.status === "paused" ? "paused" : "completed",
        nextAction: "Ended as set. Nothing more is checked.",
        nextActionLines: [line("next.ended")],
      };
      delete next.nextCheckAt;
      delete next.error;
      return next;
    });
    const text = `Ended ${describeEnds(ends)}, as set.`;
    this.activity(store, agent.id, "completed", text, { lines: [endedLine(ends)] });
    this.emitAgent(updated);
    this.log(`${agent.id} ended (${ends.kind})`);
    return { agentId: agent.id, at: now.toISOString(), fired: false, note: text, noteLines: [endedLine(ends)] };
  }

  /**
   * The daily digest: once a day, at the digest time, one notification for
   * every report held for it from before then. Quiet hours hold it for a later
   * tick; switched-off notifications let the day pass (the reports are in the
   * app, unread).
   */
  flushDigest(): void {
    const send = this.deps.sendDigest;
    if (!send) return;
    const store = this.store();
    const file = store.digest();
    const now = this.now();
    const due = digestDue(file, now);
    if (due.length === 0) return;
    const outcome = send(due.map((e) => ({ agentId: e.agentId, reportId: e.reportId, title: e.title, body: e.body })));
    if (outcome === "held") return;
    const sent = new Set(due.map((e) => e.id));
    store.setDigest({ version: 1, lastSentDay: localYmd(now), entries: file.entries.filter((e) => !sent.has(e.id)) });
    this.log(`digest ${outcome} (${due.length} agent${due.length === 1 ? "" : "s"})`);
  }

  /* ---------------------------------------------------------------- */
  /* Scheduler                                                         */
  /* ---------------------------------------------------------------- */

  /** Agents of the signed-in account whose next check is due. */
  dueAgents(): string[] {
    const store = this.store();
    const now = this.now().getTime();
    return store
      .list()
      .filter((a) => a.status === "active" || a.status === "error")
      .filter((a) => {
        const next = store.state(a.id).nextCheckAt;
        return !next || Date.parse(next) <= now;
      })
      .map((a) => a.id);
  }

  /** One pass: every due agent, one at a time. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try {
        this.deps.onTick?.();
      } catch (err) {
        this.log(`tick hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        this.flushDigest();
      } catch (err) {
        this.log(`digest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const id of this.dueAgents()) {
        try {
          await this.runAgent(id, false);
        } catch (err) {
          this.log(`check of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => {
          if (!this.stopped) loop(TICK_MS);
        });
      }, delay);
      this.timer.unref?.();
    };
    loop(FIRST_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A check a moment from now, outside the tick (after create, resume, edit). */
  private soon(id: string): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      void this.runAgent(id, false).catch((err) => this.log(`first check of ${id} failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 1500);
    t.unref?.();
  }
}
