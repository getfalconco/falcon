/**
 * Live paper book for the 60-day Falcon competition.
 *
 * Consumes the same `second_order_signals` rows the apps show users.
 * No extra model. Fills at the live last quote (Yahoo extended → Finnhub).
 */

import {
  PAPER_COMPETITION_POLICY,
  PAPER_COMPETITION_RUN_ID,
  addWeekdays,
  competitionHeadline,
  evaluateSignal,
  type CompetitionSignal,
} from "@meridian/research/competition";
import { fetchLatestPrice } from "@meridian/research/propagation";

const RUN_ID = PAPER_COMPETITION_RUN_ID;
const POLICY = PAPER_COMPETITION_POLICY;

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianWorker/1.0",
  "Content-Type": "application/json",
};

type RunRow = {
  id: string;
  status: string;
  started_at: string;
  ends_at: string;
  initial_cash: number | string;
  cash: number | string;
  spy_start: number | string | null;
  peak_nav: number | string;
};

type PositionRow = {
  id: string;
  signal_id: string;
  ticker: string;
  direction: string;
  shares: number | string;
  weight: number | string;
  notional_usd: number | string;
  entry_price: number | string;
  entry_at: string;
  planned_exit_at: string;
  status: string;
  headline: string | null;
};

type SignalRow = {
  id: string;
  terminal_ticker: string | null;
  root_ticker: string | null;
  direction: string | null;
  magnitude: string | null;
  path_confidence: number | null;
  priced_in_status: string | null;
  generated_at: string | null;
  event_summary: string | null;
  reasoning: string | null;
  mechanism: string | null;
  expected_move_pct: number | null;
  expected_days: number | null;
  event_type: string | null;
};

function supabaseConfig(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function num(v: number | string | null | undefined, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function rest<T>(
  config: { url: string; serviceKey: string },
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...SUPABASE_HEADERS,
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      Prefer: "return=representation",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${body.slice(0, 240)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function logEvent(
  config: { url: string; serviceKey: string },
  input: {
    stage: string;
    message: string;
    signalId?: string;
    ticker?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await rest(config, "paper_competition_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      run_id: RUN_ID,
      stage: input.stage,
      message: input.message,
      signal_id: input.signalId ?? null,
      ticker: input.ticker ?? null,
      payload: input.payload ?? {},
    }),
  });
}

async function loadRun(
  config: { url: string; serviceKey: string },
): Promise<RunRow | null> {
  const rows = await rest<RunRow[]>(
    config,
    `paper_competition_runs?id=eq.${encodeURIComponent(RUN_ID)}&select=*`,
  );
  return rows[0] ?? null;
}

async function loadOpenPositions(
  config: { url: string; serviceKey: string },
): Promise<PositionRow[]> {
  return rest<PositionRow[]>(
    config,
    `paper_competition_positions?run_id=eq.${encodeURIComponent(RUN_ID)}&status=eq.open&select=*`,
  );
}

async function loadDecidedIds(
  config: { url: string; serviceKey: string },
): Promise<Set<string>> {
  const rows = await rest<Array<{ signal_id: string }>>(
    config,
    `paper_competition_decisions?run_id=eq.${encodeURIComponent(RUN_ID)}&select=signal_id`,
  );
  return new Set(rows.map((r) => r.signal_id));
}

async function loadFreshSignals(
  config: { url: string; serviceKey: string },
  sinceIso: string,
): Promise<SignalRow[]> {
  return rest<SignalRow[]>(
    config,
    `second_order_signals?generated_at=gte.${encodeURIComponent(sinceIso)}&select=id,terminal_ticker,root_ticker,direction,magnitude,path_confidence,priced_in_status,generated_at,event_summary,reasoning,mechanism,expected_move_pct,expected_days,event_type&order=generated_at.asc&limit=200`,
  );
}

function toCompetitionSignal(row: SignalRow): CompetitionSignal {
  return {
    id: row.id,
    terminal_ticker: (row.terminal_ticker ?? "").toUpperCase(),
    direction: row.direction ?? "unclear",
    magnitude: row.magnitude ?? "low",
    path_confidence: typeof row.path_confidence === "number" ? row.path_confidence : 0,
    priced_in_status: row.priced_in_status ?? "likely priced in",
    generated_at: row.generated_at ?? new Date(0).toISOString(),
  };
}

async function quoteMap(tickers: string[]): Promise<Map<string, { price: number; source: string }>> {
  const out = new Map<string, { price: number; source: string }>();
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  for (const ticker of unique) {
    const q = await fetchLatestPrice(ticker);
    if (q && q.price > 0) out.set(ticker, q);
  }
  return out;
}

async function markBook(
  cash: number,
  opens: PositionRow[],
  prices: Map<string, { price: number; source: string }>,
): Promise<{ nav: number; positionsValue: number }> {
  let positionsValue = 0;
  for (const pos of opens) {
    const shares = num(pos.shares);
    const px = prices.get(pos.ticker.toUpperCase())?.price ?? num(pos.entry_price);
    positionsValue += shares * px;
  }
  return { nav: cash + positionsValue, positionsValue };
}

async function patchRun(
  config: { url: string; serviceKey: string },
  patch: Record<string, unknown>,
): Promise<void> {
  await rest(
    config,
    `paper_competition_runs?id=eq.${encodeURIComponent(RUN_ID)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    },
  );
}

async function writeSnapshot(
  config: { url: string; serviceKey: string },
  input: {
    cash: number;
    positionsValue: number;
    nav: number;
    spyPrice: number | null;
    spyStart: number | null;
    openCount: number;
    peakNav: number;
  },
): Promise<void> {
  const spyNav =
    input.spyPrice != null && input.spyStart != null && input.spyStart > 0
      ? round2(POLICY.startingCashUsd * (input.spyPrice / input.spyStart))
      : null;
  const drawdown =
    input.peakNav > 0 ? round2(((input.peakNav - input.nav) / input.peakNav) * 100) : 0;
  await rest(config, "paper_competition_snapshots", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      run_id: RUN_ID,
      cash: round2(input.cash),
      positions_value: round2(input.positionsValue),
      nav: round2(input.nav),
      spy_price: input.spyPrice,
      spy_nav: spyNav,
      open_count: input.openCount,
      peak_nav: round2(input.peakNav),
      drawdown_pct: Math.max(0, drawdown),
    }),
  });
}

async function closePosition(
  config: { url: string; serviceKey: string },
  pos: PositionRow,
  exitPrice: number,
  exitReason: string,
  cash: number,
): Promise<number> {
  const shares = num(pos.shares);
  const entry = num(pos.entry_price);
  const pnl = round2(shares * (exitPrice - entry));
  const gross = entry !== 0 ? (exitPrice / entry - 1) * 100 : 0;
  const directionAdjusted = pos.direction === "negative" ? -gross : gross;
  const newCash = cash + shares * exitPrice;

  await rest(
    config,
    `paper_competition_positions?id=eq.${encodeURIComponent(pos.id)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "closed",
        exit_price: round2(exitPrice),
        exit_at: new Date().toISOString(),
        exit_reason: exitReason,
        pnl_usd: pnl,
        return_pct: round2(directionAdjusted),
      }),
    },
  );

  await logEvent(config, {
    stage: "position_closed",
    message: `Closed ${pos.ticker} @ ${round2(exitPrice)} (${exitReason}), PnL ${pnl}`,
    signalId: pos.signal_id,
    ticker: pos.ticker,
    payload: { exitPrice, exitReason, pnl, returnPct: round2(directionAdjusted) },
  });

  return newCash;
}

async function recordDecision(
  config: { url: string; serviceKey: string },
  row: SignalRow,
  verdict: "skipped" | "filled" | "fill_failed",
  skipReason: string | null,
  extra: Record<string, unknown>,
): Promise<void> {
  const ticker = (row.terminal_ticker ?? "").toUpperCase();
  const headline = competitionHeadline({
    ticker,
    direction: row.direction ?? "unclear",
    reasoning: row.reasoning ?? "",
    eventSummary: row.event_summary ?? "",
    mechanism: row.mechanism ?? "",
  });
  try {
    await rest(config, "paper_competition_decisions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        run_id: RUN_ID,
        signal_id: row.id,
        ticker,
        direction: row.direction ?? "unclear",
        generated_at: row.generated_at,
        verdict,
        skip_reason: skipReason,
        path_confidence: row.path_confidence,
        magnitude: row.magnitude,
        priced_in_status: row.priced_in_status,
        headline,
        event_summary: row.event_summary ?? "",
        reasoning: row.reasoning ?? "",
        mechanism: row.mechanism ?? "",
        expected_move_pct: row.expected_move_pct,
        expected_days: row.expected_days,
        snapshot: extra,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate|23505/i.test(msg)) throw err;
  }
}

let tickRunning = false;

export async function runPaperCompetitionTick(): Promise<string> {
  const config = supabaseConfig();
  if (!config) return "supabase not configured — skipped";
  if (tickRunning) return "previous tick still running — skipped";
  tickRunning = true;

  const tickStart = Date.now();
  try {
    const run = await loadRun(config);
    if (!run) return "no competition run row";

    const now = new Date();
    let status = run.status;
    let cash = num(run.cash);
    let spyStart = run.spy_start == null ? null : num(run.spy_start);
    let peakNav = num(run.peak_nav, num(run.initial_cash, 10_000));
    const startedAt = new Date(run.started_at);
    const endsAt = new Date(run.ends_at);
    const expired = now >= endsAt;

    await logEvent(config, {
      stage: "tick_started",
      message: expired ? "Tick — run window elapsed, flattening book" : "Tick — ingest signals, MTM, exits",
      payload: { status, cash, expired },
    });

    let opens = await loadOpenPositions(config);
    const heldTickers = opens.map((p) => p.ticker.toUpperCase());
    const prices = await quoteMap([...heldTickers, "SPY"]);
    const spyPx = prices.get("SPY")?.price ?? null;
    if (spyStart == null && spyPx != null) {
      spyStart = spyPx;
      await patchRun(config, { spy_start: spyStart });
      await logEvent(config, {
        stage: "benchmark_seeded",
        message: `SPY start marked at ${spyPx}`,
        ticker: "SPY",
        payload: { spyStart: spyPx },
      });
    }

    if (status === "paused") {
      await logEvent(config, { stage: "tick_skipped", message: "Run is paused" });
      return "paused";
    }

    // Time exits first.
    if (status === "active" || expired) {
      for (const pos of [...opens]) {
        const due = expired || now >= new Date(pos.planned_exit_at);
        if (!due) continue;
        const px = prices.get(pos.ticker.toUpperCase())?.price;
        if (px == null) {
          await logEvent(config, {
            stage: "exit_blocked",
            message: `Exit due for ${pos.ticker} but no live quote — will retry`,
            signalId: pos.signal_id,
            ticker: pos.ticker,
            payload: { reason: expired ? "run_end" : "time" },
          });
          continue;
        }
        cash = await closePosition(
          config,
          pos,
          px,
          expired ? "run_end" : "hold_weekdays",
          cash,
        );
      }
      opens = await loadOpenPositions(config);
    }

    if (expired && status === "active") {
      const leftover = opens.filter((p) => p.status === "open");
      if (leftover.length === 0) {
        status = "completed";
        await patchRun(config, { status: "completed", cash: round2(cash) });
        await logEvent(config, {
          stage: "run_completed",
          message: "60-day window ended; book flattened",
        });
      }
    }

    const decided = await loadDecidedIds(config);
    let filled = 0;
    let skipped = 0;
    let considered = 0;

    if (status === "active" && !expired) {
      const since = new Date(now.getTime() - POLICY.maxSignalAgeHours * 3_600_000);
      const rows = await loadFreshSignals(config, since.toISOString());
      await logEvent(config, {
        stage: "signals_ingested",
        message: `Fetched ${rows.length} second-order signal(s) since ${since.toISOString()}`,
        payload: { count: rows.length, alreadyDecided: decided.size },
      });

      for (const row of rows) {
        if (decided.has(row.id)) continue;
        considered += 1;
        const signal = toCompetitionSignal(row);
        const ticker = signal.terminal_ticker;

        await logEvent(config, {
          stage: "policy_eval",
          message: `Evaluating ${ticker} ${signal.direction} conf=${signal.path_confidence}`,
          signalId: row.id,
          ticker,
          payload: {
            path_confidence: signal.path_confidence,
            magnitude: signal.magnitude,
            priced_in_status: signal.priced_in_status,
            generated_at: signal.generated_at,
          },
        });

        const { nav } = await markBook(cash, opens, prices);
        const decision = evaluateSignal(signal, {
          now,
          runStartedAt: startedAt,
          runActive: true,
          cash,
          equity: nav,
          openTickers: new Set(opens.map((p) => p.ticker.toUpperCase())),
          openCount: opens.length,
        });

        if (decision.action === "skip") {
          skipped += 1;
          await recordDecision(config, row, "skipped", decision.reason, {
            stage: "policy_skip",
          });
          await logEvent(config, {
            stage: "decision_skip",
            message: `Skip ${ticker}: ${decision.reason}`,
            signalId: row.id,
            ticker,
            payload: { reason: decision.reason },
          });
          decided.add(row.id);
          continue;
        }

        await logEvent(config, {
          stage: "order_intended",
          message: `Take ${ticker} — 10% sleeve, 5 weekday hold`,
          signalId: row.id,
          ticker,
        });

        let quote = prices.get(ticker);
        if (!quote) {
          const fresh = await fetchLatestPrice(ticker);
          if (fresh && fresh.price > 0) {
            quote = fresh;
            prices.set(ticker, fresh);
          }
        }
        if (!quote) {
          skipped += 1;
          await recordDecision(config, row, "fill_failed", "missing_price", {
            stage: "quote_failed",
          });
          await logEvent(config, {
            stage: "fill_failed",
            message: `No live quote for ${ticker}`,
            signalId: row.id,
            ticker,
            payload: { reason: "missing_price" },
          });
          decided.add(row.id);
          continue;
        }

        const { nav: equityNow } = await markBook(cash, opens, prices);
        const notional = equityNow * POLICY.positionFraction;
        if (cash < notional) {
          skipped += 1;
          await recordDecision(config, row, "skipped", "insufficient_cash", {
            stage: "pre_fill_cash",
          });
          decided.add(row.id);
          continue;
        }

        const isShort = signal.direction === "negative";
        const shares = (isShort ? -1 : 1) * (notional / quote.price);
        cash -= shares * quote.price;
        const entryAt = new Date();
        const plannedExit = addWeekdays(entryAt, POLICY.holdWeekdays);
        const headline = competitionHeadline({
          ticker,
          direction: signal.direction,
          reasoning: row.reasoning ?? "",
          eventSummary: row.event_summary ?? "",
          mechanism: row.mechanism ?? "",
        });

        await rest(config, "paper_competition_positions", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            run_id: RUN_ID,
            signal_id: row.id,
            ticker,
            direction: signal.direction,
            shares,
            weight: POLICY.positionFraction,
            notional_usd: round2(notional),
            entry_price: round2(quote.price),
            entry_at: entryAt.toISOString(),
            entry_source: quote.source,
            planned_exit_at: plannedExit.toISOString(),
            status: "open",
            headline,
            path_confidence: signal.path_confidence,
            event_summary: row.event_summary ?? "",
            reasoning: row.reasoning ?? "",
            mechanism: row.mechanism ?? "",
          }),
        });

        await recordDecision(config, row, "filled", null, {
          stage: "filled",
          price: quote.price,
          source: quote.source,
          shares,
          notional,
        });
        await logEvent(config, {
          stage: "filled",
          message: `Filled ${isShort ? "short" : "long"} ${ticker} ${Math.abs(shares).toFixed(4)} @ ${round2(quote.price)} (${quote.source})`,
          signalId: row.id,
          ticker,
          payload: {
            price: quote.price,
            source: quote.source,
            shares,
            notional: round2(notional),
            plannedExit: plannedExit.toISOString(),
          },
        });

        decided.add(row.id);
        filled += 1;
        opens = await loadOpenPositions(config);
        const heldQuote = await fetchLatestPrice(ticker);
        if (heldQuote) prices.set(ticker, heldQuote);
      }
    }

    const marked = await markBook(cash, opens, prices);
    peakNav = Math.max(peakNav, marked.nav);
    await writeSnapshot(config, {
      cash,
      positionsValue: marked.positionsValue,
      nav: marked.nav,
      spyPrice: spyPx,
      spyStart,
      openCount: opens.length,
      peakNav,
    });
    await logEvent(config, {
      stage: "snapshot_written",
      message: `NAV ${round2(marked.nav)} · cash ${round2(cash)} · ${opens.length} open`,
      payload: {
        nav: round2(marked.nav),
        cash: round2(cash),
        positionsValue: round2(marked.positionsValue),
        spy: spyPx,
      },
    });

    const summary = `considered ${considered}, filled ${filled}, skipped ${skipped}, open ${opens.length}, nav ${round2(marked.nav)}`;
    await patchRun(config, {
      cash: round2(cash),
      peak_nav: round2(peakNav),
      last_tick_at: new Date().toISOString(),
      last_tick_summary: summary,
    });
    await logEvent(config, {
      stage: "tick_completed",
      message: summary,
      payload: { ms: Date.now() - tickStart },
    });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (config) {
        await logEvent(config, {
          stage: "tick_error",
          message,
        });
      }
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    tickRunning = false;
  }
}

export function startPaperCompetition(): void {
  const intervalMs = Math.max(
    30_000,
    Number.parseInt(process.env.PAPER_COMPETITION_INTERVAL_MS ?? "120000", 10) ||
      120_000,
  );
  console.info(`[paper-competition] starting — every ${intervalMs}ms, run ${RUN_ID}`);

  void (async () => {
    for (;;) {
      try {
        const summary = await runPaperCompetitionTick();
        console.info(`[paper-competition] ${summary}`);
      } catch (err) {
        console.warn(
          "[paper-competition] tick failed:",
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
}
