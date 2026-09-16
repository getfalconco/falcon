/**
 * Risk persistence — plain JSON under `apps/desktop/data/risk/` (override with
 * `FALCON_RISK_DATA_DIR`): `config.json` (calibration + the card flag),
 * `account.json` (last paper-account push from the renderer), `snapshots.json`
 * (history, pruned to `historyRetentionDays`).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_RISK_CONFIG, mergeRiskConfig, type RiskConfig } from "./config.js";
import type { RiskAccountInput, RiskHistoryItem, RiskSnapshot } from "./types.js";

export function resolveRiskDataDir(): string {
  const fromEnv = process.env.FALCON_RISK_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "risk");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export class RiskConfigStore {
  constructor(private readonly dir: string = resolveRiskDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): RiskConfig {
    const stored = readJson<Partial<RiskConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_RISK_CONFIG);
      return mergeRiskConfig(null);
    }
    // One-time graduation (schema 2): the card gate shipped default-off and
    // stored configs froze it. A schema-1 file's riskCardEnabled is the old
    // default, not a choice — drop it so the new default applies; configs
    // saved from here on carry schema 2 and are honoured as-is.
    const version = stored.schemaVersion ?? 1;
    if (version < 3) {
      // One-time graduation (schema 2): the card gate shipped default-off and
      // stored configs froze it — that false is the old default, not a choice.
      if (version < 2) delete stored.riskCardEnabled;
      // Schema 3 added the Sharpe component. A stored blend was balanced over
      // five components and sums to 1 without it; keeping those numbers and
      // adding Sharpe's default would weight the book to 1.12 and inflate
      // every score. Anchors and every other override survive.
      delete stored.weights;
      const migrated = mergeRiskConfig(stored);
      writeJsonAtomic(this.configFile, migrated);
      return migrated;
    }
    return mergeRiskConfig(stored);
  }

  save(config: RiskConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

export class RiskAccountStore {
  constructor(private readonly dir: string = resolveRiskDataDir()) {}

  get file(): string {
    return path.join(this.dir, "account.json");
  }

  load(): RiskAccountInput | null {
    const stored = readJson<RiskAccountInput>(this.file);
    if (!stored || stored.account !== "paper" || !Array.isArray(stored.positions)) return null;
    return {
      account: "paper",
      cash: typeof stored.cash === "number" && Number.isFinite(stored.cash) ? stored.cash : 0,
      positions: stored.positions
        .filter((p) => p && typeof p.ticker === "string" && typeof p.shares === "number")
        .map((p) => ({
          ticker: p.ticker.toUpperCase(),
          shares: p.shares,
          cost_usd: typeof p.cost_usd === "number" ? p.cost_usd : 0,
          market_value: typeof p.market_value === "number" && Number.isFinite(p.market_value) ? p.market_value : null,
        })),
      as_of: typeof stored.as_of === "string" ? stored.as_of : null,
    };
  }

  save(account: RiskAccountInput): void {
    writeJsonAtomic(this.file, account);
  }
}

export function toHistoryItem(s: RiskSnapshot): RiskHistoryItem {
  return {
    computed_at: s.computed_at,
    score: s.score,
    band: s.band,
    driver_component: s.driver?.component ?? null,
    driver_sentence: s.driver?.sentence ?? null,
    trigger: s.trigger,
    empty: s.empty,
  };
}

export class RiskSnapshotStore {
  private cache: RiskSnapshot[] | null = null;

  constructor(
    private readonly dir: string = resolveRiskDataDir(),
    private readonly retentionDays: number = DEFAULT_RISK_CONFIG.historyRetentionDays,
  ) {}

  get file(): string {
    return path.join(this.dir, "snapshots.json");
  }

  private all(): RiskSnapshot[] {
    if (!this.cache) {
      const stored = readJson<RiskSnapshot[]>(this.file);
      this.cache = Array.isArray(stored) ? stored.filter((s) => s && typeof s.computed_at === "string") : [];
    }
    return this.cache;
  }

  /** Drop snapshots older than the retention window relative to `now`. */
  prune(now: string): void {
    const cutoff = Date.parse(now) - this.retentionDays * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(cutoff)) return;
    const kept = this.all().filter((s) => Date.parse(s.computed_at) >= cutoff);
    if (kept.length !== this.all().length) {
      this.cache = kept;
      writeJsonAtomic(this.file, kept);
    }
  }

  append(snapshot: RiskSnapshot): void {
    const list = this.all();
    list.push(snapshot);
    list.sort((a, b) => a.computed_at.localeCompare(b.computed_at));
    this.cache = list;
    this.prune(snapshot.computed_at);
    writeJsonAtomic(this.file, this.cache);
  }

  latest(): RiskSnapshot | null {
    const list = this.all();
    return list.length > 0 ? list[list.length - 1] : null;
  }

  /** Newest first. */
  history(limit = 200): RiskHistoryItem[] {
    const list = this.all();
    return list.slice(Math.max(0, list.length - limit)).reverse().map(toHistoryItem);
  }

  count(): number {
    return this.all().length;
  }

  /** Forget the in-memory copy (a second writer may have touched the file). */
  reload(): void {
    this.cache = null;
  }
}
