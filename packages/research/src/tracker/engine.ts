/**
 * Tracker engine (Engine1) — deterministic per-ticker monitoring.
 *
 * Owns: backfill (§1), the three inbound channels (§2), live quant state (§3),
 * message emission (§4), detector evaluation on the §5 schedule, and the
 * infrastructure guarantees of §6 (channel isolation, rate-limit discipline,
 * persistence, clock/session awareness).
 *
 * Contains no LLM calls and no interpretation — measurement and reporting only.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  addTradingDays,
  calendarDaysBetween,
  classifySession,
  isCatchUpRun,
  isInEarningsWindow,
  isTradingDay,
  lastCompletedTradingDay,
  nyYmd,
  previousTradingDay,
  sessionTimes,
  tradingDaysBetween,
} from "./calendar.js";
import { mergeTrackerConfig, type TrackerConfig } from "./config.js";
import {
  applyEdgeTransition,
  applySnapshotFire,
  decideEdgeFire,
  decideSnapshotFire,
  evaluateDrift,
  evaluateFilingOverdue,
  evaluateInsiderCluster,
  evaluateNewsBurst,
  evaluateSilence,
  evaluateUnexplainedMove,
  gapTriggered,
  insiderClusterHasNewMember,
  newsBaselineRate,
  newsBurstRearmed,
  volumeTriggered,
} from "./detectors.js";
import type { InsiderClusterExclusion } from "./detectors.js";
import {
  computeContextFlags,
  computeDriftZ,
  computeGapStats,
  computeQuantContext,
  type QuoteLike,
} from "./quant.js";
import {
  fetchAdjustedDailyBars,
  fetchCompanyNews,
  fetchEarningsCalendar,
  fetchForm4Details,
  fetchQuote,
  fetchSubmissions,
  filingArchiveUrl,
  fiscalPeriodLabel,
  isOpenMarketInsiderTxn,
  FinnhubRateLimitError,
  isEarningsRelease,
  resolveCikCached,
  sleep,
} from "./sources.js";
import { emptyTickerState, TrackerStore } from "./store.js";
import { discoverCachedTickers } from "./universe.js";
import type {
  ContextFlag,
  DailyBar,
  EarningsRecord,
  FilingRecord,
  QuantContext,
  RateLimitTally,
  TickerState,
  TrackerMessage,
  TrackerMessageType,
  TrackerPayload,
  TrackerStatus,
} from "./types.js";
import { TRACKER_SCHEMA_VERSION } from "./types.js";

export type TrackerEmitHook = (message: TrackerMessage) => void;
export type UniverseChangeEvent = { type: "add" | "remove"; ticker: string };
export type UniverseChangeHook = (event: UniverseChangeEvent) => void;

const MAX_SEEN_ARTICLE_IDS = 4000;
const MAX_NEWS_TIMESTAMPS = 2000;
const EDGAR_REQUEST_SPACING_MS = 350; // polite spacing (§6)
const FINNHUB_BACKOFF_BASE_MS = 2_000;
/** Per-cycle wall-clock budgets — keep one stage from starving the others. */
const INSIDER_BACKFILL_BUDGET_MS = 20_000;
const NEWS_POLL_BUDGET_MS = 20_000;
const FILING_POLL_BUDGET_MS = 15_000;
/** Finnhub returns at most this many articles per company-news request. */
const NEWS_RESPONSE_CAP = 250;
/** Ceiling on backfill requests per ticker, so subdivision cannot run away. */
const NEWS_BACKFILL_MAX_REQUESTS = 60;
/** T1.4: warn when the universe's median r² vs the benchmark sits below this. */
const R2_SANITY_MEDIAN = 0.2;

type ChannelName = "news" | "filings" | "calendar" | "price";

export class TrackerEngine {
  private readonly store: TrackerStore;
  private config: TrackerConfig;
  private states = new Map<string, TickerState>();
  /** Upper-cased `config.priceTierTickers`, rebuilt whenever the universe is resolved. */
  private priceTier = new Set<string>();
  private benchBars: DailyBar[] = [];
  private benchBarsAsOf: string | null = null;
  private splitDates = new Map<string, string | null>();
  private quoteCache = new Map<string, { quote: QuoteLike; at: number }>();
  private emitHooks: TrackerEmitHook[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt: string | null = null;
  private messagesEmitted = 0;
  private lastMessageAt: string | null = null;
  // News and filing cadence is tracked per ticker (TickerState); only the
  // calendar sweep is engine-wide.
  private lastCalendarRefreshAt = 0;
  private busy = false;
  /** Last logged §5.8 exclusion fingerprint per ticker, to keep the audit log quiet when nothing changed. */
  private readonly lastInsiderExclusionLog = new Map<string, string>();
  private finnhubBackoffUntil = 0;
  /** T1.4 sanity warning fires once per engine start. */
  private r2SanityChecked = false;
  /** Server-side universe, supplied before start() (null = local-only). */
  private remoteUniverse: { active: string[]; inactive: string[] } | null = null;
  private universeHooks: UniverseChangeHook[] = [];
  /** T7: per-channel 429 tally for the current ET day (persisted). */
  private rateLimits: RateLimitTally = { day: "", news: 0, calendar: 0, filings: 0, price: 0 };

  constructor(store: TrackerStore = new TrackerStore()) {
    this.store = store;
    this.config = store.loadConfig();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onMessage(hook: TrackerEmitHook): void {
    this.emitHooks.push(hook);
  }

  getConfig(): TrackerConfig {
    return this.config;
  }

  updateConfig(partial: Partial<TrackerConfig>): TrackerConfig {
    this.config = mergeTrackerConfig({ ...this.config, ...partial });
    this.store.saveConfig(this.config);
    return this.config;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date().toISOString();

    const persisted = this.store.loadBenchmarkBars();
    this.benchBars = persisted.bars;
    this.benchBarsAsOf = persisted.asOf;

    // T4: the header counter counts ALL persisted messages, matching the
    // stream below it — not just this process's lifetime.
    this.rateLimits = this.store.loadRateLimits();
    const messageStats = this.store.messageStats();
    this.messagesEmitted = messageStats.count;
    this.lastMessageAt = messageStats.lastAt;

    this.resolveUniverse();

    for (const ticker of this.config.tickers) {
      const state = this.store.loadTickerState(ticker) ?? emptyTickerState(ticker, this.startedAt);
      this.states.set(state.ticker, state);
    }

    // Kick off backfill + first cycle without blocking the caller (the desktop
    // main process must not stall on network I/O during boot).
    void this.runCycle().catch((err) => {
      console.error("[tracker] initial cycle failed:", err);
    });

    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        console.error("[tracker] cycle error:", err);
      });
    }, this.config.intervals.schedulerTickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /**
   * Under universeMode "cached", the tracked list is whatever the rest of the
   * app already has data for (§1) — rediscovered on every start so a ticker
   * added to any cache is picked up on the next launch.
   */
  private resolveUniverse(): void {
    const remote = this.remoteUniverse;
    const inactive = new Set((remote?.inactive ?? []).map((t) => t.toUpperCase()));
    const merged = new Set<string>();

    if (this.config.universeMode === "cached") {
      // Discover relative to the tracker's own data dir (its parent is the
      // data root), never the process cwd — a packaged exe has no repo cwd.
      const dataRoot = path.dirname(this.store.dataDir);
      const discovered = discoverCachedTickers(dataRoot, { exclude: [this.config.benchmark] });
      for (const t of discovered.tickers) merged.add(t);
      console.info(
        `[tracker] universe: ${discovered.tickers.length} cached tickers ` +
          `(candles ${discovered.sources.candles}, edgar ${discovered.sources.edgar}, ` +
          `tracked ${discovered.sources.tracked}, step1 ${discovered.sources.step1})`,
      );
      // The configured list is a source in its own right, not a fallback:
      // universe growth is decided in the config file (expand-universe writes
      // it, the engine service folds the shipped copy in at boot), and a
      // cache that predates that decision must not out-vote it. Removal is
      // safe either way — removeTicker flips the mode to explicit.
      for (const t of this.config.tickers) merged.add(t);
    } else {
      for (const t of this.config.tickers) merged.add(t);
      console.info(`[tracker] universe: explicit (${this.config.tickers.length} tickers)`);
    }

    // Server-authoritative list: everything the server marks active is
    // tracked on every install (a fresh machine has no local caches to
    // discover from); anything it marks inactive was removed deliberately
    // somewhere and must not be resurrected by local discovery.
    if (remote) {
      for (const t of remote.active) merged.add(t.toUpperCase());
      for (const t of inactive) merged.delete(t);
      console.info(
        `[tracker] universe: server list merged (${remote.active.length} active, ${inactive.size} inactive)`,
      );
    }
    merged.delete(this.config.benchmark);

    // Price tier: declared names that are actually in the universe. A name
    // listed as price-tier but not tracked at all is not silently added — the
    // tier says HOW a ticker is followed, never WHETHER it is.
    const priceTier = new Set(
      (this.config.priceTierTickers ?? [])
        .map((t) => t.toUpperCase())
        .filter((t) => merged.has(t) && t !== this.config.benchmark),
    );
    this.priceTier = priceTier;

    this.config = { ...this.config, tickers: [...merged].sort(), priceTierTickers: [...priceTier].sort() };
    this.store.saveConfig(this.config);
    const eventTier = this.config.tickers.length - priceTier.size;
    console.info(
      `[tracker] universe: ${this.config.tickers.length} tickers — ` +
        `${eventTier} event tier (news + filings + price), ${priceTier.size} price tier (no news)`,
    );
    console.info(`[tracker] universe: ${this.config.tickers.join(", ")}`);
  }

  /**
   * Provide the server's universe before start(): active symbols are added to
   * the local universe, inactive ones are excluded even if local caches still
   * know them. Null = server unavailable, local-only.
   */
  setRemoteUniverse(remote: { active: string[]; inactive: string[] } | null): void {
    this.remoteUniverse = remote;
  }

  /** Subscribe to local universe changes (add/remove), e.g. to mirror them to the server. */
  onUniverseChange(hook: UniverseChangeHook): void {
    this.universeHooks.push(hook);
  }

  private notifyUniverse(event: UniverseChangeEvent): void {
    for (const hook of this.universeHooks) {
      try {
        hook(event);
      } catch (err) {
        console.warn("[tracker] universe hook failed:", err);
      }
    }
  }

  getUniverse(): string[] {
    return [...this.states.keys()].sort();
  }

  getStatus(): TrackerStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      tickers: [...this.states.values()].map((s) => ({
        ticker: s.ticker,
        backfilled: s.backfilledAt != null,
        insiderSeeded: s.insiderBackfilledAt != null,
        barsAsOf: s.barsAsOf,
        health: s.health,
      })),
      messagesEmitted: this.messagesEmitted,
      lastMessageAt: this.lastMessageAt,
      rateLimits: this.rateLimitsToday(),
    };
  }

  listMessages(options?: { limit?: number; ticker?: string }): TrackerMessage[] {
    return this.store.readMessages(options);
  }

  /**
   * True once start() has loaded the persisted state into memory. Before
   * that, every per-ticker read is empty — not because the universe is, but
   * because nothing has been read yet; callers that can wait should.
   */
  isStarted(): boolean {
    return this.running;
  }

  /**
   * The complete persisted state for a ticker — every series and counter the
   * engine holds, nothing summarized away. Backing the panel's data browser.
   */
  getTickerState(ticker: string): TickerState | null {
    return this.states.get(ticker.trim().toUpperCase()) ?? null;
  }

  /** Benchmark bars, so the regression inputs are inspectable too. */
  getBenchmarkBars(): { symbol: string; bars: DailyBar[]; asOf: string | null } {
    return { symbol: this.config.benchmark, bars: this.benchBars, asOf: this.benchBarsAsOf };
  }

  /** Live quant context for a ticker, computed on demand (§3). */
  async getQuantContext(ticker: string): Promise<QuantContext | null> {
    const state = this.states.get(ticker.trim().toUpperCase());
    if (!state) return null;
    return this.buildQuantContext(state, new Date());
  }

  /** Where the raw JSON lives on disk, for opening the folder directly. */
  getDataDir(): string {
    return this.store.dataDir;
  }

  /**
   * Force the close-run for every tracked ticker against the most recently
   * completed trading day, regardless of whether it has already been computed.
   * Used to repopulate quant state after a scheduling or formula change
   * without waiting for the next close.
   */
  async recomputeCloseState(): Promise<{ computed: string[]; failed: string[] }> {
    const now = new Date();
    const day = lastCompletedTradingDay(now);
    const computed: string[] = [];
    const failed: string[] = [];

    await this.ensureBenchmarkBars(now);
    for (const state of this.states.values()) {
      if (!state.backfilledAt) continue;
      try {
        await this.refreshBars(state, now);
        const measuredDay = this.latestBarDayUpTo(state, day);
        if (!measuredDay) {
          failed.push(state.ticker);
          continue;
        }
        await this.evaluateCloseDetectorsFor(state, now, measuredDay);
        state.lastCloseComputedFor = measuredDay;
        this.store.saveTickerState(state);
        computed.push(state.ticker);
      } catch (err) {
        this.recordHealth(state, "price", err);
        this.store.saveTickerState(state);
        failed.push(state.ticker);
      }
    }
    console.info(
      `[tracker] forced close-compute for ${day}: ${computed.length} computed, ${failed.length} failed`,
    );
    return { computed, failed };
  }

  /** §6 hot ticker management — add triggers the full backfill (§1). */
  async addTicker(ticker: string): Promise<void> {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol || this.states.has(symbol)) return;
    const state = this.store.loadTickerState(symbol) ?? emptyTickerState(symbol, new Date().toISOString());
    this.states.set(symbol, state);
    if (!this.config.tickers.includes(symbol)) {
      // Adding does NOT pin the universe to "explicit": the new ticker's state
      // file is itself a discovery source ("once tracked, stays tracked"), so
      // it survives restarts without freezing the rest of the universe. Only
      // removal pins, because a removed ticker could otherwise be rediscovered
      // from another subsystem's cache.
      this.config = { ...this.config, tickers: [...this.config.tickers, symbol] };
      this.store.saveConfig(this.config);
    }
    this.notifyUniverse({ type: "add", ticker: symbol });
    await this.backfillTicker(state);
  }

  removeTicker(ticker: string): void {
    const symbol = ticker.trim().toUpperCase();
    this.states.delete(symbol);
    this.config = {
      ...this.config,
      // Pin the list: cache rediscovery would otherwise re-add it on restart.
      universeMode: "explicit",
      tickers: this.config.tickers.filter((t) => t !== symbol),
    };
    this.store.saveConfig(this.config);
    this.store.removeTickerState(symbol);
    this.notifyUniverse({ type: "remove", ticker: symbol });
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /** One scheduler tick: backfill gaps, channel polls, then detector windows. */
  async runCycle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      await this.ensureBenchmarkBars(now);

      for (const state of this.states.values()) {
        // §6 channel isolation: one ticker's failure never affects others.
        try {
          if (!state.backfilledAt) await this.backfillTicker(state);
        } catch (err) {
          this.recordHealth(state, "price", err);
        }
      }

      // Each stage is individually bounded so no single slow or rate-limited
      // channel can consume the cycle and starve the stages behind it. The
      // per-stage timings make it visible when one is overrunning.
      const timings: Array<[string, number]> = [];
      const stage = async (name: string, run: () => Promise<void>) => {
        const t0 = Date.now();
        await run();
        timings.push([name, Date.now() - t0]);
      };

      await stage("news", () => this.pollNewsChannel(now));
      if (now.getTime() - this.lastCalendarRefreshAt >= this.config.intervals.calendarRefreshMs) {
        this.lastCalendarRefreshAt = now.getTime();
        await stage("calendar", () => this.refreshCalendarChannel(now));
      }
      await stage("scheduled", () => this.announcePendingScheduledEarnings(now));
      await stage("filings", () => this.pollFilingChannel(now));
      await stage("detectors", () => this.runScheduledDetectors(now));
      this.checkR2Sanity();
      await stage("insiders", () => this.runInsiderBackfillPhase());
      await stage("insiderCluster", () => this.runInsiderClusterDetector(now));

      const total = timings.reduce((sum, [, ms]) => sum + ms, 0);
      if (total > 5_000) {
        console.info(
          `[tracker] cycle ${(total / 1000).toFixed(1)}s — ` +
            timings.map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)}s`).join(", "),
        );
      }
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // §1 Backfill
  // -------------------------------------------------------------------------

  private async ensureBenchmarkBars(now: Date): Promise<void> {
    const targetDay = lastCompletedTradingDay(now);
    if (this.benchBarsAsOf === targetDay && this.benchBars.length > 0) return;
    try {
      const lookbackDays = Math.ceil(this.config.windows.backfillTradingDays * 1.5);
      const result = await fetchAdjustedDailyBars(this.config.benchmark, lookbackDays);
      if (result.bars.length > 0) {
        this.benchBars = result.bars;
        this.benchBarsAsOf = result.bars[result.bars.length - 1].d;
        this.store.saveBenchmarkBars(this.benchBars, this.benchBarsAsOf);
      }
    } catch (err) {
      console.warn(
        `[tracker] benchmark bars failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Seeds every subsystem before live tracking begins (§1). */
  private async backfillTicker(state: TickerState): Promise<void> {
    console.info(`[tracker] backfilling ${state.ticker}…`);

    // Price: 252 trading days of adjusted bars (ticker + SPY cached together).
    const lookbackDays = Math.ceil(this.config.windows.backfillTradingDays * 1.5);
    try {
      const result = await fetchAdjustedDailyBars(state.ticker, lookbackDays);
      state.bars = result.bars;
      state.barsAsOf = result.bars[result.bars.length - 1]?.d ?? null;
      this.splitDates.set(state.ticker, result.latestSplitDate);
      this.recordHealth(state, "price", null);
    } catch (err) {
      this.recordHealth(state, "price", err);
    }

    // News-rate baseline: trailing 30 trading days of real per-day counts.
    // Skipped for price-tier names — this is the expensive part of onboarding
    // a ticker (up to 24 Finnhub calls for a busy one) and it exists to feed
    // the news-burst and silence detectors, which a price-tier name does not
    // run. Its price history, filings and quant context are backfilled exactly
    // as usual, so propagation can still score it.
    if (this.isPriceTier(state.ticker)) {
      console.info(`[tracker] ${state.ticker}: price tier — skipping news baseline`);
    } else {
      try {
        await this.backfillNewsBaseline(state);
        this.recordHealth(state, "news", null);
      } catch (err) {
        this.recordHealth(state, "news", err);
      }
    }

    // Filing history: full lag series from EDGAR submissions (one call).
    // Runs before earnings history, which is derived from it.
    try {
      const cik = await resolveCikCached(state.ticker);
      state.cik = cik;
      if (cik) {
        await sleep(EDGAR_REQUEST_SPACING_MS);
        const { filings } = await fetchSubmissions(cik);
        state.filings = filings;
      }
      this.recordHealth(state, "filings", null);
    } catch (err) {
      this.recordHealth(state, "filings", err);
    }

    // Earnings history (§1): announcement dates come from 8-K item 2.02
    // filings. Finnhub's earnings calendar returns future dates only on this
    // tier, and its historical endpoint reports fiscal period ends rather than
    // announcement dates — neither can date the 1-day reaction move (§3.8).
    state.earnings = earningsHistoryFromFilings(
      state.filings,
      this.config.windows.earningsHistoryCount,
    );

    // Upcoming announced earnings still come from the calendar channel.
    try {
      const today = nyYmd(new Date());
      const entries = await this.finnhubCall(
        () => fetchEarningsCalendar(state.ticker, today, shiftYear(today, 1)),
        "calendar",
      );
      state.scheduledEarnings = toScheduledEarnings(
        [...entries].filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
        this.config.windows.confirmedEarningsCount,
      );
      this.recordHealth(state, "calendar", null);
    } catch (err) {
      this.recordHealth(state, "calendar", err);
    }

    state.backfilledAt = new Date().toISOString();
    this.store.saveTickerState(state);
    console.info(
      `[tracker] ${state.ticker} backfilled: ${state.bars.length} bars, ` +
        `${state.filings.length} filings, ${state.earnings.length} earnings`,
    );
  }

  /**
   * Phase 2 of backfill: parse Form 4s filed inside the insider-cluster window
   * (§5.8), one SEC request per filing. Without it the detector would be blind
   * for its first 10 business days, which §1 rules out — but it is far too slow
   * to run inline for a large universe, so it proceeds in the background under
   * a per-cycle time budget until every ticker is seeded.
   */
  /**
   * §5.8 periodic re-evaluation of the cluster condition for every seeded
   * ticker. Pure computation over persisted state — no network, no EDGAR
   * budget — so it can run every cycle.
   *
   * It exists for two reasons the change-triggered calls cannot cover. A
   * ticker whose insider window was seeded before the evaluation path was
   * wired up has `insiderBackfilledAt` set, so the backfill branch never runs
   * again and its standing cluster would stay invisible forever. And the
   * 10-business-day window slides: a cluster expires with the passage of time
   * and nothing else would ever observe the release, leaving the edge
   * detector latched active and unable to re-arm.
   */
  private async runInsiderClusterDetector(now: Date): Promise<void> {
    for (const state of this.states.values()) {
      if (!state.insiderBackfilledAt) continue;
      const before = JSON.stringify(state.detectors.insiderCluster);
      try {
        await this.evaluateInsiderClusterFor(state, now);
      } catch (err) {
        this.recordHealth(state, "filings", err);
      }
      if (JSON.stringify(state.detectors.insiderCluster) !== before) {
        this.store.saveTickerState(state);
      }
    }
  }

  private async runInsiderBackfillPhase(): Promise<void> {
    // Anchored at stage entry, not the cycle timestamp: earlier stages can
    // consume the whole cycle, which would leave this one a spent budget and
    // silently skip it on every tick.
    const deadline = Date.now() + INSIDER_BACKFILL_BUDGET_MS;
    for (const state of this.states.values()) {
      if (Date.now() >= deadline) return;
      if (!state.backfilledAt || state.insiderBackfilledAt) continue;
      try {
        await this.backfillInsiderWindow(state, deadline);
        // Only mark complete if the budget did not cut the work short.
        if (Date.now() < deadline) {
          state.insiderBackfilledAt = new Date().toISOString();
          console.info(
            `[tracker] ${state.ticker} insider window seeded: ${state.insiderTxns.length} txns`,
          );
          // §5.8 the seed is a change to the transaction set like any other.
          // Without this the whole backfilled window was never evaluated: a
          // cluster already standing when the ticker was added stayed invisible
          // until some later Form 4 happened to arrive through the live poll.
          await this.evaluateInsiderClusterFor(state, new Date());
        }
        this.recordHealth(state, "filings", null);
      } catch (err) {
        this.recordHealth(state, "filings", err);
      }
      this.store.saveTickerState(state);
    }
  }

  /** Parse Form 4s filed within the insider-cluster window (§5.8). */
  private async backfillInsiderWindow(state: TickerState, deadline?: number): Promise<void> {
    const cik = state.cik;
    if (!cik) return;
    // Scan the full history window, not just the 10-business-day cluster
    // window: the cluster detector only counts the recent slice, but the
    // stored series is the record of open-market insider activity and has to
    // cover the same span as the price history.
    const windowStart = addTradingDays(
      nyYmd(new Date()),
      -this.config.windows.insiderBackfillTradingDays,
    );
    // Track every accession fetched, not just the ones kept: the P/S filter
    // discards most Form 4s, and keying off stored transactions alone would
    // make those look unseen and re-download them on every single cycle.
    const scanned = new Set(state.insiderScanned);
    const pending = state.filings
      .filter((f) => f.form === "4" && f.filedAt >= windowStart && !scanned.has(f.accessionNumber))
      .sort((a, b) => b.filedAt.localeCompare(a.filedAt)); // newest first

    for (const filing of pending) {
      if (deadline != null && Date.now() >= deadline) return;
      state.insiderScanned.push(filing.accessionNumber);
      await sleep(EDGAR_REQUEST_SPACING_MS);
      state.insiderParse.attempted += 1;
      const details = await fetchForm4Details(cik, filing);
      if (!details) continue;
      state.insiderParse.parsed += 1;
      // Open-market P/S only — grants, exercises, withholding, gifts and
      // 10b5-1 executions never enter the stored series (§5.8).
      if (!isOpenMarketInsiderTxn(details)) continue;
      state.insiderParse.kept += 1;
      state.insiderTxns.push({
        accessionNumber: filing.accessionNumber,
        insiderName: details.insiderName,
        role: details.role,
        transactionCode: details.transactionCode,
        is10b51Plan: details.is10b51Plan,
        shares: details.shares,
        value: details.value,
        transactionDate: details.transactionDate,
        filedAt: `${filing.filedAt}T00:00:00.000Z`,
        direction: details.direction,
      });
    }

    // Drop ledger entries for filings that have aged out of the window, so it
    // stays the size of the window rather than growing without limit.
    const inWindow = new Set(
      state.filings.filter((f) => f.filedAt >= windowStart).map((f) => f.accessionNumber),
    );
    state.insiderScanned = state.insiderScanned.filter((a) => inWindow.has(a));
    state.insiderTxns = state.insiderTxns.filter(
      (t) => t.filedAt.slice(0, 10) >= windowStart,
    );
  }

  /**
   * Seed the 30-trading-day news baseline with real per-day counts (§1).
   *
   * A single 30-day request cannot do this: Finnhub caps a company-news
   * response at ~250 articles and returns the newest first, so for an active
   * ticker everything older than a day or two is silently dropped — which then
   * reads as a run of zero-article days and would trip the silence detector.
   * Instead the range is walked in small windows sized to the ticker's actual
   * volume, so each window comes back under the cap and every day in it is
   * genuinely observed.
   */
  private async backfillNewsBaseline(state: TickerState): Promise<void> {
    const today = nyYmd(new Date());
    const windowDays = this.config.windows.newsBaselineTradingDays;
    const oldest = addTradingDays(today, -(windowDays + 2));

    // Probe the most recent stretch to size the chunk: a ticker that produces
    // hundreds of articles a week needs 2-day windows, a quiet one is fine
    // with 7 and costs a fraction of the requests.
    const probeFrom = addCalendarDaysYmd(today, -2);
    const probe = await this.finnhubCall(() =>
      fetchCompanyNews(state.ticker, probeFrom, today),
    );
    const perDay = probe.length / 3;
    const chunkDays =
      perDay >= this.config.intervals.newsHighVolumePerDay
        ? this.config.intervals.newsChunkDaysHighVolume
        : this.config.intervals.newsChunkDaysLowVolume;

    const counts: Record<string, number> = {};
    // Every trading day in the window starts as observed-zero; the walk below
    // either fills it or, if a window fails, deletes it again so it stays
    // "unknown" rather than a false blackout (§3.11).
    let day = addTradingDays(today, -1);
    for (let i = 0; i < windowDays; i++) {
      counts[day] = 0;
      day = addTradingDays(day, -1);
    }

    // Work a queue of ranges. A range that still comes back at the cap is
    // split and retried, down to a single day — for the busiest names even a
    // 2-day window overflows, and accepting it would silently undercount.
    const queue: Array<[string, string]> = [];
    for (let to = today; to >= oldest; ) {
      const from = addCalendarDaysYmd(to, -(chunkDays - 1));
      queue.push([from < oldest ? oldest : from, to]);
      to = addCalendarDaysYmd(from, -1);
    }

    const markUnknown = (from: string, to: string) => {
      for (let d = from; d <= to; d = addCalendarDaysYmd(d, 1)) delete counts[d];
    };

    let requests = 1; // the probe
    let capped = 0;
    let failed = 0;
    while (queue.length > 0 && requests < NEWS_BACKFILL_MAX_REQUESTS) {
      const [from, to] = queue.shift()!;
      let articles;
      try {
        articles = await this.finnhubCall(() => fetchCompanyNews(state.ticker, from, to));
        requests++;
      } catch (err) {
        // Unknown, not zero — a failed window must not read as a quiet stretch.
        markUnknown(from, to);
        failed++;
        console.warn(
          `[tracker] ${state.ticker} news window ${from}→${to} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (articles.length >= NEWS_RESPONSE_CAP) {
        if (from < to) {
          // Split and retry both halves rather than accept a truncated count.
          const mid = addCalendarDaysYmd(
            from,
            Math.floor(calendarDaysBetween(from, to) / 2),
          );
          queue.unshift([from, mid], [addCalendarDaysYmd(mid, 1), to]);
        } else {
          // A single day over the cap cannot be subdivided further.
          capped++;
          markUnknown(from, to);
        }
        continue;
      }

      for (const article of articles) {
        const articleDay = nyYmd(new Date(article.datetime * 1000));
        if (articleDay in counts) counts[articleDay] += 1;
        state.seenArticleIds.push(String(article.id));
        state.newsTimestamps.push(new Date(article.datetime * 1000).toISOString());
      }
    }

    // Anything still queued when the request ceiling hit was never observed.
    for (const [from, to] of queue) markUnknown(from, to);
    if (queue.length > 0) {
      console.warn(
        `[tracker] ${state.ticker} news backfill hit the ${NEWS_BACKFILL_MAX_REQUESTS}-request ` +
          `ceiling with ${queue.length} window(s) unread — left unknown`,
      );
    }

    state.newsCounts = counts;
    state.seenArticleIds = dedupeTail(state.seenArticleIds, MAX_SEEN_ARTICLE_IDS);
    state.newsTimestamps = state.newsTimestamps.slice(-MAX_NEWS_TIMESTAMPS).sort();

    const covered = Object.keys(counts).length;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.info(
      `[tracker] ${state.ticker} news baseline: ${covered}/${windowDays} trading days covered, ` +
        `${total} articles, ${requests} requests (${chunkDays}-day windows` +
        `${capped > 0 ? `, ${capped} single day(s) over the cap` : ""}` +
        `${failed > 0 ? `, ${failed} window(s) failed` : ""})`,
    );
  }

  // -------------------------------------------------------------------------
  // §2.1 News channel
  // -------------------------------------------------------------------------

  private async pollNewsChannel(now: Date): Promise<void> {
    const toYmd = nyYmd(now);
    const fromYmd = addTradingDays(toYmd, -3);
    const deadline = Date.now() + NEWS_POLL_BUDGET_MS;

    // Sequential across tickers with exponential backoff on 429 (§6). Each
    // ticker carries its own poll clock and the sweep is bounded per cycle, so
    // a rate-limited channel resumes next cycle instead of starving the
    // detector and insider-backfill stages that run after it.
    for (const state of this.dueForNews(now)) {
      if (Date.now() >= deadline) break;
      try {
        state.lastNewsPollAt = new Date().toISOString();
        const articles = await this.finnhubCall(() =>
          fetchCompanyNews(state.ticker, fromYmd, toYmd),
        );
        const seen = new Set(state.seenArticleIds);
        const fresh = articles
          .filter((a) => !seen.has(String(a.id)))
          .sort((a, b) => a.datetime - b.datetime);

        for (const article of fresh) {
          state.seenArticleIds.push(String(article.id));
          const publishedAt = new Date(article.datetime * 1000);
          state.newsTimestamps.push(publishedAt.toISOString());
          const day = nyYmd(publishedAt);
          state.newsCounts[day] = (state.newsCounts[day] ?? 0) + 1;

          await this.emit(state, "news_item", now, {
            headline: article.headline,
            source: article.source,
            url: article.url,
            published_at: publishedAt.toISOString(),
            article_id: String(article.id),
            summary: article.summary,
          });
        }

        state.seenArticleIds = dedupeTail(state.seenArticleIds, MAX_SEEN_ARTICLE_IDS);
        state.newsTimestamps = state.newsTimestamps.slice(-MAX_NEWS_TIMESTAMPS);
        this.recordHealth(state, "news", null);

        // §5.7 news_burst is evaluated on every news poll.
        await this.evaluateNewsBurstFor(state, now);
        this.store.saveTickerState(state);
      } catch (err) {
        this.recordHealth(state, "news", err);
        this.store.saveTickerState(state);
      }
    }
  }

  /**
   * The hot lane: a ticker whose confirmed earnings release is within
   * `hotWindowHours` either side of now. Its filings and news are polled on
   * the minute and served before the shared per-cycle budget, because the
   * whole second-order chain downstream is only as fast as this poll.
   */
  isHot(state: TickerState, now: Date): boolean {
    return isInEarningsWindow(state.scheduledEarnings, now, this.config.intervals.hotWindowHours);
  }

  /** Tickers currently in the hot lane — for the panel and the cycle log. */
  hotTickers(now = new Date()): string[] {
    return [...this.states.values()]
      .filter((s) => s.backfilledAt != null && this.isHot(s, now))
      .map((s) => s.ticker)
      .sort();
  }

  /**
   * Due tickers, hot ones first. `normalMs` is the round-robin interval,
   * `hotMs` the one that applies inside an earnings window; within each group
   * the oldest poll goes first, so the fair rotation is unchanged.
   */
  private dueFor(
    now: Date,
    lastAt: (s: TickerState) => string | null,
    normalMs: number,
    hotMs: number,
  ): TickerState[] {
    const t = now.getTime();
    return [...this.states.values()]
      .filter((s) => s.backfilledAt != null)
      .filter((s) => {
        const last = lastAt(s);
        const cutoff = t - (this.isHot(s, now) ? hotMs : normalMs);
        return last == null || Date.parse(last) <= cutoff;
      })
      .sort((a, b) => {
        const hot = Number(this.isHot(b, now)) - Number(this.isHot(a, now));
        if (hot !== 0) return hot;
        return (lastAt(a) ?? "").localeCompare(lastAt(b) ?? "");
      });
  }

  /**
   * Whether this ticker is followed for price only (§S2). A price-tier name is
   * priced, scored and detected on exactly like any other; it just never
   * spends news quota, which is what lets the universe grow past the Finnhub
   * free tier's ceiling.
   */
  isPriceTier(ticker: string): boolean {
    return this.priceTier.has(ticker.toUpperCase());
  }

  /**
   * Backfilled tickers whose news poll is due, oldest poll first (§2.1).
   * Price-tier names are never due: they have no news clock to fall behind on.
   */
  private dueForNews(now: Date): TickerState[] {
    return this.dueFor(
      now,
      (s) => s.lastNewsPollAt,
      this.config.intervals.newsPollMs,
      this.config.intervals.hotNewsPollMs,
    ).filter((s) => !this.isPriceTier(s.ticker));
  }

  /** Backfilled tickers whose filing check is due, oldest check first (§2.2). */
  private dueForFilings(now: Date): TickerState[] {
    const intervalMs =
      (6.5 * 60 * 60_000) / Math.max(1, this.config.intervals.filingChecksPerTradingDay);
    return this.dueFor(
      now,
      (s) => s.lastFilingCheckAt,
      intervalMs,
      this.config.intervals.hotFilingPollMs,
    );
  }

  // -------------------------------------------------------------------------
  // §2.2 Filing channel
  // -------------------------------------------------------------------------

  private async pollFilingChannel(now: Date): Promise<void> {
    const todayYmd = nyYmd(now);
    // EDGAR is quiet outside trading days — except around a release, where a
    // Friday-evening or holiday 8-K would otherwise wait for the next session
    // (BA and NOC filed Friday 21:06 ET and were not seen until Monday).
    if (!isTradingDay(todayYmd) && this.hotTickers(now).length === 0) return;
    // Anchored at stage entry, not the cycle timestamp: earlier stages can
    // consume the whole cycle, which would leave this one a spent budget and
    // silently skip it on every tick.
    const deadline = Date.now() + FILING_POLL_BUDGET_MS;

    for (const state of this.dueForFilings(now)) {
      if (Date.now() >= deadline) break;
      try {
        state.lastFilingCheckAt = new Date().toISOString();
        if (!state.cik) state.cik = await resolveCikCached(state.ticker);
        if (!state.cik) continue;

        await sleep(EDGAR_REQUEST_SPACING_MS);
        const { filings } = await fetchSubmissions(state.cik);
        const known = new Set(state.filings.map((f) => f.accessionNumber));
        const fresh = filings
          .filter((f) => f.accessionNumber && !known.has(f.accessionNumber))
          .sort((a, b) => a.filedAt.localeCompare(b.filedAt));

        let insiderTxnsAdded = false;
        for (const filing of fresh) {
          state.filings.push(filing);
          // SEC's real acceptance instant when we have it. The date-only
          // fallback stamps midnight UTC, which made a 16:05 ET earnings 8-K
          // read as ~20 hours old: Base's freshness scored it at zero and the
          // incident could fall below the propagation dispatch band, and
          // propagation anchored its pricing reference on the wrong session.
          const filedAtIso = filing.acceptedAt ?? `${filing.filedAt}T00:00:00.000Z`;

          if (filing.form === "4") {
            await sleep(EDGAR_REQUEST_SPACING_MS);
            state.insiderParse.attempted += 1;
            const details = await fetchForm4Details(state.cik, filing);
            if (details) state.insiderParse.parsed += 1;

            // The channel reports every Form 4 arrival with its code and plan
            // flag (§2.2) — that is raw observation. Only open-market P/S
            // enters the stored series the cluster detector counts (§5.8).
            await this.emit(state, "insider_filing", now, {
              insider_name: details?.insiderName ?? "unknown",
              role: details?.role ?? "insider",
              transaction_code: details?.transactionCode ?? "",
              is_10b5_1_plan: details?.is10b51Plan ?? false,
              shares: details?.shares ?? null,
              value: details?.value ?? null,
              transaction_date: details?.transactionDate ?? null,
              filed_at: filedAtIso,
              filing_url: filingArchiveUrl(state.cik, filing),
            });

            if (details && isOpenMarketInsiderTxn(details)) {
              state.insiderParse.kept += 1;
              state.insiderTxns.push({
                accessionNumber: filing.accessionNumber,
                insiderName: details.insiderName,
                role: details.role,
                transactionCode: details.transactionCode,
                is10b51Plan: details.is10b51Plan,
                shares: details.shares,
                value: details.value,
                transactionDate: details.transactionDate,
                filedAt: filedAtIso,
                direction: details.direction,
              });
              insiderTxnsAdded = true;
            }
          } else {
            await this.emit(state, "filing_item", now, {
              form_type: filing.form,
              accession_number: filing.accessionNumber,
              filed_at: filedAtIso,
              item_codes: filing.items,
              filing_url: filingArchiveUrl(state.cik, filing),
            });
          }
        }

        // §5.8 the cluster condition is a property of the whole transaction
        // set, so it is evaluated once this poll has finished adding to it.
        // Evaluating per arrival assessed an incomplete set N times over.
        if (insiderTxnsAdded) await this.evaluateInsiderClusterFor(state, now);

        // A new earnings release (8-K item 2.02) extends the rhythm history.
        if (fresh.some(isEarningsRelease)) {
          state.earnings = earningsHistoryFromFilings(
            state.filings,
            this.config.windows.earningsHistoryCount,
          );
        }

        this.recordHealth(state, "filings", null);
        this.store.saveTickerState(state);
      } catch (err) {
        this.recordHealth(state, "filings", err);
        this.store.saveTickerState(state);
      }
    }
  }

  // -------------------------------------------------------------------------
  // §2.3 Calendar channel
  // -------------------------------------------------------------------------

  /**
   * Emit scheduled_event for every confirmed upcoming earnings date that has
   * not been announced yet (§2.3). Deliberately decoupled from the calendar
   * fetch: dates the initial backfill loaded were never announced because the
   * old diff-based dedupe saw no change, and a rate-limited refresh must not
   * delay announcing dates we already hold. Runs every cycle, needs no network.
   *
   * Dedupe ledger is per (fiscal_period, due_at): a new due_at for a period
   * that was already announced is a reschedule and carries the prior date.
   */
  private async announceScheduledEarnings(state: TickerState, now: Date): Promise<void> {
    const ledger = (state.scheduledEmitted ??= []);
    const today = nyYmd(now);
    for (const entry of state.scheduledEarnings) {
      // Far-future entries are provider projections that drift; only
      // company-confirmed dates are worth announcing downstream.
      if (!entry.confirmed) continue;
      if (entry.dueAt.slice(0, 10) < today) continue; // already past
      if (ledger.some((l) => l.dueAt === entry.dueAt)) continue; // §2.3 once per (ticker, due_at)

      const prior = ledger.find((l) => l.fiscalPeriod === entry.fiscalPeriod);
      ledger.push({ fiscalPeriod: entry.fiscalPeriod, dueAt: entry.dueAt });
      await this.emit(state, "scheduled_event", now, {
        event_type: "earnings" as const,
        due_at: entry.dueAt,
        fiscal_period: entry.fiscalPeriod,
        earnings_rhythm: null, // filled from quant_context by emit()
        rescheduled: prior != null,
        previous_due_at: prior?.dueAt ?? null,
      });
    }
    // Keep the ledger to roughly a year so it cannot grow without bound.
    state.scheduledEmitted = ledger.filter((l) => l.dueAt.slice(0, 10) >= shiftYear(today, -1));
  }

  /** Cycle stage: announce any pending confirmed dates for every ticker. */
  private async announcePendingScheduledEarnings(now: Date): Promise<void> {
    for (const state of this.states.values()) {
      if (!state.backfilledAt) continue;
      const before = (state.scheduledEmitted ?? []).length;
      try {
        await this.announceScheduledEarnings(state, now);
      } catch (err) {
        this.recordHealth(state, "calendar", err);
      }
      if ((state.scheduledEmitted ?? []).length !== before) this.store.saveTickerState(state);
    }
  }

  private async refreshCalendarChannel(now: Date): Promise<void> {
    const today = nyYmd(now);

    for (const state of this.states.values()) {
      if (!state.backfilledAt) continue;
      try {
        const entries = await this.finnhubCall(
          () => fetchEarningsCalendar(state.ticker, today, shiftYear(today, 1)),
          "calendar",
        );
        const upcoming = entries
          .filter((e) => e.date >= today)
          .sort((a, b) => a.date.localeCompare(b.date));

        const previous = state.scheduledEarnings;
        const next = toScheduledEarnings(upcoming, this.config.windows.confirmedEarningsCount);

        // Earnings history is normally derived from 8-K item 2.02 filings,
        // which carry real acceptance timestamps. Foreign private issuers
        // (TSM et al.) file 6-K/20-F instead and so never produce a 2.02, so
        // a due date we previously observed as scheduled is rolled into
        // history once it passes — an announcement date we watched arrive,
        // not a fiscal period end standing in for one.
        const elapsed = previous.filter((p) => p.dueAt.slice(0, 10) < today);
        if (elapsed.length > 0) {
          const known = new Set(state.earnings.map((e) => e.date));
          const rolled = elapsed
            .filter((p) => !known.has(p.dueAt.slice(0, 10)))
            .map((p) => ({
              date: p.dueAt.slice(0, 10),
              fiscalPeriod: p.fiscalPeriod,
              // 12:00Z is the "bmo" marker written when the entry was scheduled.
              hour: p.dueAt.slice(11, 16) === "12:00" ? "bmo" : "amc",
            }));
          if (rolled.length > 0) {
            const merged = [...state.earnings, ...rolled].sort((a, b) =>
              a.date.localeCompare(b.date),
            );
            state.earnings = merged.slice(-this.config.windows.earningsHistoryCount);
          }
        }

        state.scheduledEarnings = next;
        this.recordHealth(state, "calendar", null);
        // Announce straight away rather than waiting for the next cycle.
        await this.announceScheduledEarnings(state, now);
        this.store.saveTickerState(state);
      } catch (err) {
        this.recordHealth(state, "calendar", err);
        this.store.saveTickerState(state);
      }
    }
  }

  // -------------------------------------------------------------------------
  // §5 Detector schedule
  // -------------------------------------------------------------------------

  private async runScheduledDetectors(now: Date): Promise<void> {
    const todayYmd = nyYmd(now);
    const session = classifySession(now);
    const times = isTradingDay(todayYmd) ? sessionTimes(todayYmd) : null;

    for (const state of this.states.values()) {
      if (!state.backfilledAt) continue;
      try {
        // Gap — from the open onwards. The overnight gap is a settled fact
        // once the session has opened, so a late start still records it;
        // requiring the *regular* session would silently skip the whole day
        // whenever the app happened to start after the close.
        if (
          times &&
          now.getTime() >= times.openUtc.getTime() &&
          state.lastGapCheckedFor !== todayYmd &&
          (session.session === "regular" || session.session === "post")
        ) {
          await this.refreshBars(state, now);
          await this.evaluateGapFor(state, now, todayYmd);
          state.lastGapCheckedFor = todayYmd;
          this.store.saveTickerState(state);
        }

        // volume / unexplained / silence / filing_overdue / drift — evaluated
        // against the most recent trading day whose session has completed.
        //
        // The gate is "is there a completed day we have not computed yet",
        // NOT "has today's close just passed": the latter only fires while the
        // app happens to be running between the close and midnight, and never
        // at all on weekends or holidays, which left the whole quant state
        // uncomputed. lastCompletedTradingDay() already resolves to the right
        // day mid-session, after the close, and on non-trading days alike.
        const completedDay = lastCompletedTradingDay(now);
        if (state.lastCloseComputedFor !== completedDay) {
          await this.refreshBars(state, now);
          // Measure the latest session we actually hold a bar for. The data
          // provider can lag a day, and labelling that snapshot with the day
          // we *wanted* would describe the wrong session. Recording the
          // measured day also makes this self-correcting: once the missing
          // bar lands, the stored day no longer matches and it recomputes.
          const measuredDay = this.latestBarDayUpTo(state, completedDay);
          if (measuredDay) {
            await this.evaluateCloseDetectorsFor(state, now, measuredDay);
            state.lastCloseComputedFor = measuredDay;
            this.store.saveTickerState(state);
          }
        }
      } catch (err) {
        this.recordHealth(state, "price", err);
        this.store.saveTickerState(state);
      }
    }
  }

  /**
   * T1.4 — one-shot sanity check after the first close-computes: a median r²
   * this low across the whole universe is the signature of a systemic
   * alignment or data bug (mismatched dates, raw-vs-adjusted mix), not a
   * market condition, so it is worth a loud line. It can also be a genuine
   * low-correlation regime — the 2026-08 diagnosis found exactly that, with
   * the date-keyed join verified pair-by-pair against an independent
   * recompute — which is why this only warns and never blocks.
   */
  private checkR2Sanity(): void {
    if (this.r2SanityChecked) return;
    const r2s = [...this.states.values()]
      .map((s) => s.quant?.r_squared)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    if (r2s.length < Math.min(10, this.config.tickers.length)) return; // wait for coverage
    this.r2SanityChecked = true;
    const median = r2s[Math.floor(r2s.length / 2)];
    if (median < R2_SANITY_MEDIAN) {
      console.warn(
        `[tracker] SANITY: median r² vs ${this.config.benchmark} is ${median.toFixed(3)} ` +
          `across ${r2s.length} tickers (< ${R2_SANITY_MEDIAN}). Verify return alignment ` +
          `(date-keyed join, adjusted closes both sides) before trusting residuals — ` +
          `the §5.5 low-r² fallback is active for most of the universe.`,
      );
    }
  }

  /** Latest trading day at or before `day` that the bar series covers. */
  private latestBarDayUpTo(state: TickerState, day: string): string | null {
    for (let i = state.bars.length - 1; i >= 0; i--) {
      if (state.bars[i].d <= day) return state.bars[i].d;
    }
    return null;
  }

  /** One bar fetch per ticker per day (§6 rate-limit discipline). */
  private async refreshBars(state: TickerState, now: Date): Promise<void> {
    const target = lastCompletedTradingDay(now);
    // `>=` not `===`: mid-session the series can already carry a partial bar
    // for today while the target is yesterday, and an equality check would
    // refetch the whole history on every cycle.
    if (state.barsAsOf != null && state.barsAsOf >= target) return;
    const lookbackDays = Math.ceil(this.config.windows.backfillTradingDays * 1.5);
    const result = await fetchAdjustedDailyBars(state.ticker, lookbackDays);
    if (result.bars.length > 0) {
      state.bars = result.bars;
      state.barsAsOf = result.bars[result.bars.length - 1].d;
      this.splitDates.set(state.ticker, result.latestSplitDate);
    }
    this.recordHealth(state, "price", null);
  }

  private async evaluateGapFor(state: TickerState, now: Date, todayYmd: string): Promise<void> {
    const stats = computeGapStats(state.bars, this.config);
    if (!stats || !gapTriggered(stats.gapZ, this.config)) return;

    const decision = decideSnapshotFire(
      state.detectors.gap,
      todayYmd,
      stats.gapZ,
      this.config.thresholds.escalationMultiple,
    );
    if (!decision.fire) return;

    state.detectors.gap = applySnapshotFire(todayYmd, stats.gapZ);
    await this.emit(state, "gap_event", now, {
      gap_pct: stats.gapPct,
      gap_z: stats.gapZ,
      direction: stats.gapPct >= 0 ? ("up" as const) : ("down" as const),
      prev_close: stats.prevClose,
      open_price: stats.open,
    });
  }

  private async evaluateCloseDetectorsFor(
    state: TickerState,
    now: Date,
    dayYmd: string,
  ): Promise<void> {
    // Measure the completed session, not a partial one: mid-session both the
    // ticker and benchmark series can already carry an in-progress bar.
    this.markNewsDayObserved(state, dayYmd);
    const quant = await this.buildQuantContext(state, now, {
      skipQuote: true,
      asOfDay: dayYmd,
      asOfCompletedSession: true,
    });
    // T3: the close-run normally fires shortly after the measured session's
    // close, on the same NY date. When the app was closed at the time, the
    // run happens later as a catch-up (e.g. 03:39 the next morning) — the
    // measurement is identical, but downstream must be able to tell a live
    // close signal from a backfilled one, so every close-run payload says so.
    const catchUp = isCatchUpRun(now, dayYmd);
    // Persist it: otherwise the whole §3 state exists only inside emitted
    // messages, and a ticker that triggered nothing has no readable quant
    // state at all.
    state.quant = quant;
    state.quantAsOf = dayYmd;
    const flags = computeContextFlags(state, dayYmd);
    const escalation = this.config.thresholds.escalationMultiple;

    // §5.2 volume anomaly (snapshot) — full-day ratio only.
    if (volumeTriggered(quant.volume_ratio, quant.volume_ratio_partial, this.config)) {
      const ratio = quant.volume_ratio as number;
      const decision = decideSnapshotFire(state.detectors.volume, dayYmd, ratio, escalation);
      if (decision.fire) {
        state.detectors.volume = applySnapshotFire(dayYmd, ratio);
        await this.emit(
          state,
          "volume_anomaly",
          now,
          { volume_ratio: ratio, threshold_crossed: this.config.thresholds.volumeRatio, catch_up: catchUp },
          { quant, flags },
        );
      }
    }

    // §5.5 unexplained move (snapshot).
    const unexplained = evaluateUnexplainedMove(
      {
        residualZ: quant.residual_zscore,
        moveZ: quant.move_zscore,
        r2: quant.r_squared,
        burstActive: state.detectors.newsBurst.active,
        inEarningsWindow: flags.includes("earnings_window"),
      },
      this.config,
    );
    if (unexplained.conditionTrue && unexplained.value != null) {
      const decision = decideSnapshotFire(
        state.detectors.unexplained,
        dayYmd,
        unexplained.value,
        escalation,
      );
      if (decision.fire) {
        state.detectors.unexplained = applySnapshotFire(dayYmd, unexplained.value);
        await this.emit(
          state,
          "unexplained_move",
          now,
          {
            residual_zscore: unexplained.value,
            measure_used: unexplained.measureUsed,
            direction: unexplained.value >= 0 ? ("up" as const) : ("down" as const),
            volume_ratio: quant.volume_ratio,
            news_items_since_prev_close: this.countNewsSincePrevClose(state, dayYmd),
            catch_up: catchUp,
          },
          { quant, flags },
        );
      }
    }

    // §5.3 silence (edge-triggered).
    const silence = evaluateSilence(state.newsCounts, dayYmd, this.config);
    const silenceFire = decideEdgeFire(
      state.detectors.silence,
      silence.conditionTrue,
      silence.tradingDaysSilent,
      escalation,
    );
    if (silenceFire.fire) {
      await this.emit(
        state,
        "silence_anomaly",
        now,
        {
          expected_daily_article_rate: silence.baselineRate ?? 0,
          trading_days_silent: silence.tradingDaysSilent,
          next_earnings_due_at: this.nextEarningsWithin(
            state,
            dayYmd,
            this.config.thresholds.silenceEarningsLookaheadDays,
          ),
          catch_up: catchUp,
        },
        { quant, flags },
      );
    }
    state.detectors.silence = applyEdgeTransition(
      state.detectors.silence,
      silence.conditionTrue,
      silenceFire.fire,
      silence.tradingDaysSilent,
      now.toISOString(),
      dayYmd,
    );

    // §5.4 filing overdue (edge-triggered).
    const overdue = evaluateFilingOverdue(state.filings, dayYmd, this.config);
    const overdueFire = decideEdgeFire(
      state.detectors.filingOverdue,
      overdue.conditionTrue,
      overdue.businessDaysOverdue,
      escalation,
    );
    if (overdueFire.fire && overdue.expectedByDate && overdue.medianLagDays != null) {
      await this.emit(
        state,
        "filing_overdue",
        now,
        {
          expected_form: overdue.expectedForm,
          expected_by_date: overdue.expectedByDate,
          business_days_overdue: overdue.businessDaysOverdue,
          historical_median_lag_days: overdue.medianLagDays,
          catch_up: catchUp,
        },
        { quant, flags },
      );
    }
    state.detectors.filingOverdue = applyEdgeTransition(
      state.detectors.filingOverdue,
      overdue.conditionTrue,
      overdueFire.fire,
      overdue.businessDaysOverdue,
      now.toISOString(),
      dayYmd,
    );

    // §5.6 drift (edge-triggered).
    const driftZ = computeDriftZ(quant);
    const newsLast5d = this.countNewsInLastTradingDays(state, dayYmd, this.config.thresholds.driftNewsFreeDays);
    const burstInWindow = this.newsBurstWithinTradingDays(
      state,
      dayYmd,
      this.config.thresholds.driftNewsFreeDays,
    );
    const driftTrue = evaluateDrift(driftZ, burstInWindow, this.config);
    const driftFire = decideEdgeFire(state.detectors.drift, driftTrue, driftZ, escalation);
    if (driftFire.fire && driftZ != null && quant.momentum_5d != null) {
      await this.emit(
        state,
        "drift_event",
        now,
        {
          momentum_5d: quant.momentum_5d,
          drift_z: driftZ,
          direction: quant.momentum_5d >= 0 ? ("up" as const) : ("down" as const),
          news_items_last_5d: newsLast5d,
          catch_up: catchUp,
        },
        { quant, flags },
      );
    }
    state.detectors.drift = applyEdgeTransition(
      state.detectors.drift,
      driftTrue,
      driftFire.fire,
      driftZ,
      now.toISOString(),
      dayYmd,
    );
  }

  private async evaluateNewsBurstFor(state: TickerState, now: Date): Promise<void> {
    const todayYmd = nyYmd(now);
    const cutoff = now.getTime() - 24 * 60 * 60_000;
    const articles24h = state.newsTimestamps.filter((ts) => Date.parse(ts) >= cutoff).length;
    const baseline = newsBaselineRate(state.newsCounts, todayYmd, this.config);
    const burst = evaluateNewsBurst(articles24h, baseline, this.config);

    // §5 re-arm hysteresis: must stay false one full trading day before re-firing.
    const rearmed = newsBurstRearmed(state.detectors.newsBurst, todayYmd);
    const decision = decideEdgeFire(
      state.detectors.newsBurst,
      burst.conditionTrue,
      burst.burstMultiple,
      this.config.thresholds.escalationMultiple,
    );
    const fire = decision.fire && rearmed;

    if (fire && burst.burstMultiple != null && burst.baselineRate != null) {
      await this.emit(state, "news_burst", now, {
        articles_last_24h: burst.articlesLast24h,
        baseline_daily_rate: burst.baselineRate,
        burst_multiple: burst.burstMultiple,
      });
    }
    state.detectors.newsBurst = applyEdgeTransition(
      state.detectors.newsBurst,
      burst.conditionTrue,
      fire,
      burst.burstMultiple,
      now.toISOString(),
      todayYmd,
    );
  }

  /**
   * Audit trail for the §5.8 noise filters. Logged when the exclusion set
   * changes rather than on every evaluation — the periodic sweep re-derives
   * the same exclusions each cycle, and repeating them would bury the moment
   * one actually appears or clears.
   */
  private logInsiderExclusions(state: TickerState, excluded: InsiderClusterExclusion[]): void {
    const fingerprint = excluded
      .map((e) => `${e.insiderName}|${e.filedAt}|${e.reason}`)
      .sort()
      .join(";");
    if (this.lastInsiderExclusionLog.get(state.ticker) === fingerprint) return;
    this.lastInsiderExclusionLog.set(state.ticker, fingerprint);
    if (excluded.length === 0) return;

    const byReason = new Map<string, number>();
    for (const e of excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
    const summary = [...byReason.entries()].map(([r, n]) => `${r} ${n}`).join(", ");
    console.info(
      `[tracker] ${state.ticker} insider_cluster excluded ${excluded.length} txn(s): ${summary}`,
    );
    const LOG_DETAIL_CAP = 20;
    for (const e of excluded.slice(0, LOG_DETAIL_CAP)) {
      const value = e.value == null ? "value unknown" : `$${Math.round(e.value).toLocaleString()}`;
      console.info(
        `[tracker]   ${state.ticker} ${e.filedAt.slice(0, 10)} ${e.direction} ` +
          `${e.insiderName} ${value} — ${e.reason}`,
      );
    }
    if (excluded.length > LOG_DETAIL_CAP) {
      console.info(`[tracker]   ${state.ticker} … ${excluded.length - LOG_DETAIL_CAP} more`);
    }
  }

  private async evaluateInsiderClusterFor(state: TickerState, now: Date): Promise<void> {
    const todayYmd = nyYmd(now);
    const cluster = evaluateInsiderCluster(state.insiderTxns, todayYmd, this.config);
    this.logInsiderExclusions(state, cluster.excluded);

    let fire = false;
    if (cluster.conditionTrue) {
      // Fire on the transition, and re-fire only when a new insider joins (§5.8).
      fire =
        !state.detectors.insiderCluster.active ||
        insiderClusterHasNewMember(state.detectors.insiderCluster, cluster.insiders);
    }

    if (fire && cluster.direction) {
      await this.emit(state, "insider_cluster", now, {
        window_business_days: this.config.thresholds.insiderClusterWindowBusinessDays,
        insider_count: cluster.insiders.length,
        direction: cluster.direction,
        // Every counted transaction carries a value — the §5.8 notional filter
        // drops the ones that do not — so the sum is always computable.
        total_notional: cluster.transactions.reduce((sum, t) => sum + (t.value ?? 0), 0),
        transactions: cluster.transactions.map((t) => ({
          insider_name: t.insiderName,
          transaction_code: t.transactionCode,
          is_10b5_1_plan: t.is10b51Plan,
          transaction_date: t.transactionDate ?? null,
          filed_at: t.filedAt,
          value: t.value ?? 0,
        })),
      });
    }

    const next = applyEdgeTransition(
      state.detectors.insiderCluster,
      cluster.conditionTrue,
      fire,
      cluster.insiders.length,
      now.toISOString(),
      todayYmd,
    );
    state.detectors.insiderCluster = {
      ...next,
      lastClusterInsiders: cluster.conditionTrue ? cluster.insiders : [],
    };
  }

  // -------------------------------------------------------------------------
  // §3–4 quant refresh + message emission
  // -------------------------------------------------------------------------

  private async buildQuantContext(
    state: TickerState,
    now: Date,
    options?: { skipQuote?: boolean; asOfDay?: string; asOfCompletedSession?: boolean },
  ): Promise<QuantContext> {
    let quote: QuoteLike | null = null;
    let benchQuote: QuoteLike | null = null;
    if (!options?.skipQuote) {
      // Ticker + SPY fetched together (§3, §6).
      quote = await this.getQuoteCached(state.ticker);
      benchQuote = await this.getQuoteCached(this.config.benchmark);
    }
    const cutoff = options?.asOfDay;
    return computeQuantContext({
      state: cutoff ? { ...state, bars: state.bars.filter((b) => b.d <= cutoff) } : state,
      benchBars: cutoff ? this.benchBars.filter((b) => b.d <= cutoff) : this.benchBars,
      config: this.config,
      now,
      quote,
      benchQuote,
      splitDate: this.splitDates.get(state.ticker) ?? null,
      asOfCompletedSession: options?.asOfCompletedSession,
    });
  }

  private async getQuoteCached(symbol: string): Promise<QuoteLike | null> {
    const cached = this.quoteCache.get(symbol);
    if (cached && Date.now() - cached.at < this.config.intervals.quoteCacheMs) {
      return cached.quote;
    }
    try {
      const quote = await fetchQuote(symbol);
      this.quoteCache.set(symbol, { quote, at: Date.now() });
      return quote;
    } catch {
      return cached?.quote ?? null;
    }
  }

  /** Build + persist + broadcast a §4 envelope. */
  private async emit(
    state: TickerState,
    type: TrackerMessageType,
    now: Date,
    payload: TrackerPayload,
    precomputed?: { quant: QuantContext; flags: ContextFlag[] },
  ): Promise<void> {
    const quant = precomputed?.quant ?? (await this.buildQuantContext(state, now));
    const flags = precomputed?.flags ?? computeContextFlags(state, nyYmd(now));

    // scheduled_event carries the ticker's earnings_rhythm (§2.3).
    const finalPayload =
      type === "scheduled_event"
        ? { ...(payload as Record<string, unknown>), earnings_rhythm: quant.earnings_rhythm }
        : payload;

    const message: TrackerMessage = {
      id: randomUUID(),
      schema_version: TRACKER_SCHEMA_VERSION,
      type,
      ticker: state.ticker,
      timestamp: now.toISOString(),
      source_engine: "tracker",
      context_flags: flags,
      quant_context: quant,
      payload: finalPayload as TrackerPayload,
    };

    this.store.appendMessage(message);
    this.messagesEmitted += 1;
    this.lastMessageAt = message.timestamp;
    for (const hook of this.emitHooks) {
      try {
        hook(message);
      } catch (err) {
        console.warn("[tracker] emit hook failed:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Record a completed trading day as genuinely observed. A day the engine
   * polled from before its open through its close has a real count — zero
   * included — whereas a day it never covered must stay absent so the baseline
   * reports "not computable" rather than a false blackout (§3.11).
   */
  private markNewsDayObserved(state: TickerState, dayYmd: string): void {
    const times = sessionTimes(dayYmd);
    if (!times) return;
    const watchedFrom = state.backfilledAt ? Date.parse(state.backfilledAt) : null;
    if (watchedFrom == null || watchedFrom > times.openUtc.getTime()) return;
    if (!(dayYmd in state.newsCounts)) state.newsCounts[dayYmd] = 0;
    this.pruneNewsCounts(state);
  }

  /** Keep the counts map bounded to a little over the baseline window. */
  private pruneNewsCounts(state: TickerState): void {
    const keep = this.config.windows.newsBaselineTradingDays * 2;
    const days = Object.keys(state.newsCounts).sort();
    if (days.length <= keep) return;
    for (const day of days.slice(0, days.length - keep)) delete state.newsCounts[day];
  }

  /** Articles published since the previous regular-session close (§5.5). */
  private countNewsSincePrevClose(state: TickerState, dayYmd: string): number {
    const prevDay = previousTradingDay(dayYmd);
    const prevTimes = sessionTimes(prevDay);
    if (!prevTimes) return 0;
    const since = prevTimes.closeUtc.getTime();
    return state.newsTimestamps.filter((ts) => Date.parse(ts) >= since).length;
  }

  private countNewsInLastTradingDays(state: TickerState, dayYmd: string, days: number): number {
    let day = dayYmd;
    let total = 0;
    for (let i = 0; i < days; i++) {
      total += state.newsCounts[day] ?? 0;
      day = addTradingDays(day, -1);
    }
    return total;
  }

  private nextEarningsWithin(
    state: TickerState,
    dayYmd: string,
    calendarDays: number,
  ): string | null {
    for (const entry of state.scheduledEarnings) {
      const entryDay = entry.dueAt.slice(0, 10);
      if (entryDay < dayYmd) continue;
      if (tradingDaysBetween(dayYmd, entryDay) <= calendarDays) return entry.dueAt;
    }
    return null;
  }

  /** True if news_burst is active or fired within the last `days` trading days (incl. today). */
  private newsBurstWithinTradingDays(state: TickerState, dayYmd: string, days: number): boolean {
    const nb = state.detectors.newsBurst;
    if (nb.active) return true;
    if (!nb.lastFiredAt) return false;
    const firedDay = nyYmd(new Date(nb.lastFiredAt));
    if (firedDay > dayYmd) return false;
    return tradingDaysBetween(firedDay, dayYmd) < days;
  }

  private recordHealth(state: TickerState, channel: ChannelName, err: unknown): void {
    const nowIso = new Date().toISOString();
    if (err == null) {
      state.health[channel] = { last_success_at: nowIso, last_error: null };
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    state.health[channel] = { ...state.health[channel], last_error: message };
    // Finnhub 429s are already tallied per attempt inside finnhubCall; count
    // here only the ones from other sources (SEC/Yahoo) so nothing is double-counted.
    if (!(err instanceof FinnhubRateLimitError) && /\b429\b|rate limit/i.test(message)) {
      this.noteRateLimit(channel);
    }
    console.warn(`[tracker] ${state.ticker} ${channel}: ${message}`);
  }

  /**
   * T7 — persistent per-channel 429 tally, reset at ET midnight. Health alone
   * only keeps the last attempt's outcome, which hides a channel that is
   * limping through the day on retries.
   */
  private noteRateLimit(channel: ChannelName): void {
    const today = nyYmd(new Date());
    if (this.rateLimits.day !== today) {
      this.rateLimits = { day: today, news: 0, calendar: 0, filings: 0, price: 0 };
    }
    this.rateLimits[channel] += 1;
    this.store.saveRateLimits(this.rateLimits);
  }

  /** Current tally, rolled to today so a stale day never reads as live. */
  private rateLimitsToday(): RateLimitTally {
    const today = nyYmd(new Date());
    return this.rateLimits.day === today
      ? this.rateLimits
      : { day: today, news: 0, calendar: 0, filings: 0, price: 0 };
  }

  /** Finnhub sequential access with exponential backoff on 429 (§6). */
  private async finnhubCall<T>(fn: () => Promise<T>, channel: ChannelName = "news"): Promise<T> {
    const waitMs = this.finnhubBackoffUntil - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    let attempt = 0;
    for (;;) {
      try {
        const result = await fn();
        this.finnhubBackoffUntil = 0;
        return result;
      } catch (err) {
        if (err instanceof FinnhubRateLimitError) this.noteRateLimit(channel);
        if (!(err instanceof FinnhubRateLimitError) || attempt >= 4) throw err;
        const delay = FINNHUB_BACKOFF_BASE_MS * 2 ** attempt;
        this.finnhubBackoffUntil = Date.now() + delay;
        attempt += 1;
        await sleep(delay);
      }
    }
  }
}

/**
 * Map calendar entries to scheduled-earnings records (§2.3).
 *
 * Providers return a full year of future dates, but only the next one or two
 * are company-announced — the rest are projections off the historical cadence
 * and shift as the year goes on. Emitting scheduled_event for those would
 * announce dates that were never actually scheduled, so they are retained for
 * context (the earnings_window flag still uses them) but flagged unconfirmed.
 */
function toScheduledEarnings(
  entries: Array<{ date: string; hour: string | null; quarter: number | null; year: number | null }>,
  confirmedCount: number,
): Array<{ dueAt: string; fiscalPeriod: string; confirmed: boolean }> {
  return entries.map((entry, index) => ({
    dueAt: `${entry.date}T${entry.hour === "bmo" ? "12:00" : "20:00"}:00.000Z`,
    fiscalPeriod: fiscalPeriodLabel(entry),
    confirmed: index < confirmedCount,
  }));
}

function addCalendarDaysYmd(ymdStr: string, n: number): string {
  const d = new Date(`${ymdStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dedupeTail(values: string[], max: number): string[] {
  return [...new Set(values)].slice(-max);
}

/**
 * Earnings announcement history from 8-K item 2.02 filings. The EDGAR
 * acceptance timestamp resolves whether the release landed before the open
 * ("bmo") or after the close ("amc"), which decides the reaction session for
 * earnings_rhythm (§3.8).
 */
export function earningsHistoryFromFilings(
  filings: FilingRecord[],
  count: number,
): EarningsRecord[] {
  return filings
    .filter(isEarningsRelease)
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt))
    .slice(-count)
    .map((filing) => ({
      date: filing.filedAt,
      fiscalPeriod: filing.reportDate ?? filing.filedAt,
      hour: acceptanceHour(filing),
    }));
}

/** "bmo" | "amc" | "dmh" from the EDGAR acceptance timestamp. */
function acceptanceHour(filing: FilingRecord): string | null {
  if (!filing.acceptedAt) return null;
  const accepted = new Date(filing.acceptedAt);
  if (Number.isNaN(accepted.getTime())) return null;
  const times = sessionTimes(filing.filedAt);
  if (!times) return "amc";
  if (accepted.getTime() < times.openUtc.getTime()) return "bmo";
  if (accepted.getTime() >= times.closeUtc.getTime()) return "amc";
  return "dmh";
}

function shiftYear(ymdStr: string, years: number): string {
  const [y, m, d] = ymdStr.split("-").map(Number);
  return `${String(y + years).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Singleton accessor (desktop main process)
// ---------------------------------------------------------------------------

let engineSingleton: TrackerEngine | null = null;

export function getTrackerEngine(): TrackerEngine {
  if (!engineSingleton) engineSingleton = new TrackerEngine();
  return engineSingleton;
}
