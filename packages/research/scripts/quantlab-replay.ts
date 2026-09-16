/**
 * Quant Lab replay harness — run a backtest on the real backfilled series
 * without Electron (§12 evidence, §13 calibration).
 *
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts seed [--write]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts list
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts backtest <strategy_id> [--from YYYY-MM-DD] [--to …] [--write] [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts all [--write] [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts signals <strategy_id> [--limit 40]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts live <strategy_id> [--off]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts sweep [--session YYYY-MM-DD] [--write]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-replay.ts fixture > ../../apps/desktop/src/renderer/__preview__/quantlab-fixture.json
 *
 * `seed` writes the §9 strategy library into strategies.json (idempotent).
 * Backtests print to stdout and write a stored report only with `--write` —
 * the desktop host owns the store, and every stored report increments the
 * family's variant counter, so an exploratory run must not inflate it.
 *
 * Data dirs: FALCON_QUANTLAB_DATA_DIR / FALCON_TRACKER_DATA_DIR /
 * FALCON_SCREEN_DATA_DIR, plus FALCON_GRAPH_PATH.
 */

import { loadEnvironment, runBacktest, type BacktestEnvironment } from "../src/quantlab/backtest.js";
import { missingSeeds, SEED_STRATEGIES } from "../src/quantlab/seeds.js";
import { LedgerStore, QuantLabConfigStore, ResultStore, SeriesStore, StrategyStore } from "../src/quantlab/store.js";
import { canEnable, evaluateLive, fillForwardReturns } from "../src/quantlab/ledger.js";
import { isBacktestable, unavailableComponents, validateStrategy } from "../src/quantlab/strategy.js";
import type { BacktestReport, HorizonStats, SampleStats, Strategy } from "../src/quantlab/types.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const pct = (v: number | null): string => (v == null ? "     —" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const num2 = (v: number | null): string => (v == null ? "   —" : v.toFixed(2));

function setup() {
  const configStore = new QuantLabConfigStore();
  return {
    config: configStore.load(),
    strategyStore: new StrategyStore(),
    resultStore: new ResultStore(),
  };
}

function seed(): void {
  const { strategyStore } = setup();
  const existing = new Set(strategyStore.all().map((s) => s.strategy_id));
  const pending = missingSeeds(existing);
  if (pending.length === 0) {
    console.log(`all ${SEED_STRATEGIES.length} seed strategies already present`);
    return;
  }
  for (const strategy of pending) {
    const validation = validateStrategy(strategy);
    if (!validation.ok) {
      console.error(`REFUSED ${strategy.strategy_id}: ${validation.errors.map((e) => `${e.field} ${e.message}`).join("; ")}`);
      process.exitCode = 1;
      continue;
    }
    for (const warning of validation.warnings) {
      console.log(`  warn ${strategy.strategy_id}: ${warning.field} — ${warning.message}`);
    }
    strategyStore.append(strategy);
    console.log(`seeded ${strategy.strategy_id} v${strategy.version} — ${strategy.name}`);
  }
}

function list(): void {
  const { config, strategyStore, resultStore } = setup();
  const heads = strategyStore.heads();
  if (heads.length === 0) {
    console.log("no strategies — run `quantlab-replay.ts seed`");
    return;
  }
  console.log("STRATEGY                      VER  RUNS  LIVE  BACKTESTABLE  NAME");
  for (const s of heads) {
    const runs = resultStore.forStrategy(s.strategy_id).length;
    const testable = isBacktestable(s, config.unavailableHistorically);
    console.log(
      `${s.strategy_id.padEnd(29)} ${String(s.version).padStart(3)} ${String(runs).padStart(5)}  ` +
        `${(s.live_enabled ? "yes" : "no").padEnd(4)}  ${(testable ? "yes" : "NO").padEnd(12)}  ${s.name}`,
    );
    for (const c of unavailableComponents(s, config.unavailableHistorically)) {
      console.log(`    ${c.component}: ${c.reason}`);
    }
  }
}

function horizonRow(h: HorizonStats): string {
  if (h.insufficient) {
    return `  ${String(h.sessions).padStart(3)}d  n=${String(h.n).padStart(4)}  INSUFFICIENT (floor not met) — base rate ${pct(h.base_rate_median)}`;
  }
  return (
    `  ${String(h.sessions).padStart(3)}d  n=${String(h.n).padStart(4)} (${String(h.n_tickers).padStart(3)} tickers)  ` +
    `med ${pct(h.median)}  base ${pct(h.base_rate_median)}  hit ${h.hit_rate == null ? "  —" : (h.hit_rate * 100).toFixed(0) + "%"}  ` +
    `Sh ${num2(h.sharpe)}  So ${num2(h.sortino)}  mDD ${pct(h.max_drawdown)}  CI [${pct(h.ci_low)}, ${pct(h.ci_high)}]`
  );
}

function printSample(sample: SampleStats): void {
  console.log(`\n${sample.label.toUpperCase().replace(/_/g, "-")}  ${sample.from} → ${sample.to}`);
  for (const h of sample.horizons) console.log(horizonRow(h));
}

function printReport(report: BacktestReport): void {
  console.log(`\n${"=".repeat(100)}`);
  console.log(`${report.strategy_name}  (${report.strategy_id} v${report.strategy_version})`);
  console.log(`window ${report.window.from} → ${report.window.to} · headline layer ${report.headline_layer}`);
  console.log(`variant ${report.variant_number}`);
  console.log(`\nVERDICT: ${report.verdict}`);
  if (report.variant_warning) console.log(`WARNING: ${report.variant_warning}`);
  if (report.overfit_warning) console.log(`WARNING: ${report.overfit_warning}`);
  if (report.split_warning) console.log(`WARNING: ${report.split_warning}`);
  if (report.created_after_oos_view) console.log("NOTE: this version was created after an out-of-sample result was viewed.");

  printSample(report.full);
  printSample(report.in_sample);
  printSample(report.out_of_sample);

  const full = report.full.horizons.find((h) => h.deciles.length > 0);
  if (full) {
    console.log(`\ndeciles (${full.sessions}d, p10→p90): ${full.deciles.map((d) => pct(d).trim()).join("  ")}`);
  }

  if (report.excluded.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const e of report.excluded) {
      const list = byReason.get(e.reason) ?? [];
      list.push(e.ticker);
      byReason.set(e.reason, list);
    }
    console.log("\nexcluded:");
    for (const [reason, tickers] of byReason) {
      console.log(`  ${reason} (${tickers.length}): ${tickers.slice(0, 14).join(" ")}${tickers.length > 14 ? " …" : ""}`);
    }
  }
  console.log("\ncaveats:");
  for (const c of report.caveats) console.log(`  · ${c}`);
}

function resolveStrategy(store: StrategyStore, id: string): Strategy {
  const strategy = store.latest(id);
  if (!strategy) {
    console.error(`unknown strategy "${id}" — run \`list\` to see what exists`);
    process.exit(1);
  }
  return strategy;
}

function runOne(strategy: Strategy, env: BacktestEnvironment, resultStore: ResultStore): BacktestReport {
  const variantNumber = resultStore.nextVariantNumber(strategy.strategy_id);
  const report = runBacktest(strategy, env, {
    from: arg("--from") ?? undefined,
    to: arg("--to") ?? undefined,
    variantNumber,
  });
  if (flag("--write")) resultStore.save(report);
  return report;
}

function backtest(): void {
  const id = process.argv[3];
  if (!id) {
    console.error("usage: quantlab-replay.ts backtest <strategy_id>");
    process.exit(1);
  }
  const { strategyStore, resultStore } = setup();
  const strategy = resolveStrategy(strategyStore, id);
  const started = Date.now();
  const env = loadEnvironment();
  const loaded = Date.now();
  const report = runOne(strategy, env, resultStore);

  if (flag("--json")) {
    console.log(JSON.stringify(report, null, 1));
    return;
  }
  printReport(report);
  console.log(`\nenv ${((loaded - started) / 1000).toFixed(1)}s · backtest ${((Date.now() - loaded) / 1000).toFixed(1)}s · ${report.signals.length} signals`);
}

function all(): void {
  const { config, strategyStore, resultStore } = setup();
  const env = loadEnvironment();
  const reports: BacktestReport[] = [];
  for (const strategy of strategyStore.heads()) {
    if (!isBacktestable(strategy, config.unavailableHistorically)) {
      console.log(`\nSKIP ${strategy.strategy_id} — ${unavailableComponents(strategy, config.unavailableHistorically).map((c) => c.component).join(", ")} unavailable historically`);
      continue;
    }
    const report = runOne(strategy, env, resultStore);
    reports.push(report);
    if (!flag("--json")) printReport(report);
  }
  if (flag("--json")) {
    console.log(JSON.stringify(reports, null, 1));
    return;
  }
  console.log(`\n${"=".repeat(100)}\nSUMMARY`);
  for (const r of reports) console.log(`  ${r.strategy_id.padEnd(29)} ${r.verdict}`);
}

function signals(): void {
  const id = process.argv[3];
  if (!id) {
    console.error("usage: quantlab-replay.ts signals <strategy_id>");
    process.exit(1);
  }
  const { strategyStore, resultStore } = setup();
  const strategy = resolveStrategy(strategyStore, id);
  const env = loadEnvironment();
  const report = runOne(strategy, env, resultStore);
  const limit = Number(arg("--limit") ?? 40);

  console.log(`${report.signals.length} signals for ${strategy.strategy_id} v${strategy.version}\n`);
  console.log("SESSION     TICKER  SIGN  ENTRY      SECTOR                    REASON");
  for (const s of report.signals.slice(0, limit)) {
    console.log(
      `${s.session}  ${s.ticker.padEnd(6)}  ${s.sign > 0 ? "  +1" : "  -1"}  ${s.entry_price.toFixed(2).padStart(8)}  ` +
        `${(s.sector ?? "—").slice(0, 24).padEnd(24)}  ${s.reason}`,
    );
  }
  if (report.signals.length > limit) console.log(`… ${report.signals.length - limit} more`);
}

/** Enable or disable live evaluation, honouring the §8 gate. */
function live(): void {
  const { config, strategyStore, resultStore } = setup();
  const id = process.argv[3];
  if (!id) {
    console.error("usage: quantlab-replay.ts live <strategy_id> [--off]");
    process.exit(1);
  }
  const strategy = resolveStrategy(strategyStore, id);
  const enable = !flag("--off");
  if (enable) {
    const decision = canEnable(strategy, resultStore.list(), config);
    if (!decision.ok) {
      console.error(`REFUSED: ${decision.reason}`);
      process.exit(1);
    }
  }
  strategyStore.setLiveEnabled(strategy.strategy_id, strategy.version, enable);
  console.log(`${strategy.strategy_id} v${strategy.version} live_enabled = ${enable}`);
}

/** Evaluate enabled strategies on the last session and fill matured returns. */
function sweep(): void {
  const { strategyStore } = setup();
  const ledgerStore = new LedgerStore();
  const env = loadEnvironment();
  const session = env.calendar.last;
  if (!session) {
    console.error("no sessions on file");
    process.exit(1);
  }
  const target = arg("--session") ?? session;
  const now = arg("--now") ?? `${target}T21:00:00.000Z`;
  // Evaluating a session that has already closed is a REPLAY, not a forward
  // record. Marking it keeps the ledger's one guarantee — that its contents
  // were committed to before the outcome existed — intact.
  const backfilled = target !== session;
  const enabled = strategyStore.all().filter((s) => s.live_enabled);
  const fresh = enabled.flatMap((strategy) =>
    evaluateLive({
      strategy,
      ctx: env.ctx,
      calendar: env.calendar,
      screenConfig: env.screenConfig,
      gaugeConfig: env.gaugeConfig,
      r2Floor: env.r2Floor,
      graph: env.graph,
      filingsByTicker: env.filingsByTicker,
      earningsByTicker: env.earningsByTicker,
      earningsKnowledgeHorizonSessions: env.config.data.earningsKnowledgeHorizonSessions,
      universe: env.universe,
      session: target,
      now,
      backfilled,
    }),
  );
  const known = new Set(ledgerStore.read().map((s) => s.id));
  const novel = fresh.filter((s) => !known.has(s.id));
  if (flag("--write")) ledgerStore.append(novel);

  const strategiesById = new Map(strategyStore.all().map((s) => [`${s.strategy_id}:${s.version}`, s]));
  const { updated, filled } = fillForwardReturns(ledgerStore.read(), {
    ctx: env.ctx,
    calendar: env.calendar,
    strategiesById,
  });
  if (flag("--write") && filled > 0) ledgerStore.compact(updated);

  console.log(
    `session ${target}${backfilled ? " (REPLAY — rows marked backfilled)" : ""} · ${enabled.length} enabled · ` +
      `${novel.length} new signal(s) · ${filled} forward return(s) filled` +
      (flag("--write") ? "" : "  (dry run — pass --write to persist)"),
  );
  for (const s of novel.slice(0, 20)) console.log(`  ${s.session}  ${s.ticker.padEnd(6)} ${s.sign > 0 ? "long " : "short"}  ${s.reason}`);
}

/**
 * Dumps the exact payloads the Shift+Q panel reads, for the renderer preview
 * harness. Recorded real data beats a hand-written fixture: a screenshot of
 * invented numbers proves nothing about the panel.
 */
function fixture(): void {
  const { config, strategyStore, resultStore } = setup();
  const ledgerStore = new LedgerStore();
  const seriesStore = new SeriesStore();
  const reports = resultStore.list();
  const coverage = seriesStore.coverage();
  const withData = coverage.filter((c) => c.sessions > 0);

  const strategies = strategyStore.heads().map((strategy) => {
    const enable = canEnable(strategy, reports, config);
    return {
      strategy,
      runs: reports.filter((r) => r.strategy_id === strategy.strategy_id).length,
      unavailable: unavailableComponents(strategy, config.unavailableHistorically),
      backtestable: isBacktestable(strategy, config.unavailableHistorically),
      enable_blocked_reason: enable.ok ? null : enable.reason,
      versions: strategyStore.versions(strategy.strategy_id).map((s) => s.version),
    };
  });

  console.log(
    JSON.stringify(
      {
        status: {
          dataDir: config ? new QuantLabConfigStore().dataDir : "",
          configFile: new QuantLabConfigStore().configFile,
          seriesDir: seriesStore.seriesDir,
          strategiesFile: strategyStore.file,
          ledgerFile: ledgerStore.file,
          seriesCount: coverage.length,
          seriesFrom: withData.map((c) => c.from).filter(Boolean).sort()[0] ?? null,
          seriesTo: withData.map((c) => c.to).filter(Boolean).sort().pop() ?? null,
          benchmark: config.data.benchmark,
          universeSize: Math.max(0, coverage.length - 1),
          strategyCount: strategies.length,
          reportCount: reports.length,
          ledgerCount: ledgerStore.read().length,
          lastError: null,
          running: false,
        },
        strategies,
        // Signals are the bulk of a report and the panel never renders them
        // individually; dropping them keeps the fixture small enough to read.
        reports: reports.map((r) => ({ ...r, signals: [] })),
        ledger: ledgerStore.read(),
      },
      null,
      1,
    ),
  );
}

const cmd = process.argv[2] ?? "list";
if (cmd === "seed") seed();
else if (cmd === "list") list();
else if (cmd === "backtest") backtest();
else if (cmd === "all") all();
else if (cmd === "signals") signals();
else if (cmd === "live") live();
else if (cmd === "sweep") sweep();
else if (cmd === "fixture") fixture();
else {
  console.error(`unknown command "${cmd}" — use seed | list | backtest | all | signals | live | sweep | fixture`);
  process.exit(1);
}
