/**
 * Base Engine config persistence.
 *
 * §8 requires all weights, thresholds and window parameters to be
 * configuration rather than code, so the calibration pass can move them
 * without a rebuild. This module is deliberately limited to the config file:
 * the incident store, dispatch history and budget counters land with the
 * batching/dispatch layer.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig, type BaseConfig } from "./config.js";

export function resolveBaseDataDir(): string {
  const fromEnv = process.env.FALCON_BASE_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "base");
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

export class BaseConfigStore {
  constructor(private readonly dir: string = resolveBaseDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the pilot defaults out on first run. */
  load(): BaseConfig {
    const stored = readJson<Partial<BaseConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_BASE_CONFIG);
      return mergeBaseConfig(null);
    }
    return mergeBaseConfig(stored);
  }

  save(config: BaseConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

/** Convenience: the effective config for this install. */
export function loadBaseConfig(dir?: string): BaseConfig {
  return new BaseConfigStore(dir).load();
}
