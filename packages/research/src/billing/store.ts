/**
 * Where billing probes accumulate.
 *
 * One probe proves nothing a vendor has to answer for — it could be a retry, a
 * cold route, a bad minute. A month of probes at a stable 1.75x is a different
 * conversation, and it is only possible if the samples survive a restart. Same
 * file-backed shape every other engine here uses.
 */

import fs from "node:fs";
import path from "node:path";
import type { TokenAuditSample } from "./token-audit.js";

export const BILLING_SCHEMA_VERSION = 1;

/** Keep a quarter of daily probes — enough to show a trend, small enough to read. */
export const DEFAULT_RETENTION = 400;

type Persisted = {
  schema_version: number;
  samples: TokenAuditSample[];
};

export class TokenAuditStore {
  private readonly file: string;
  private cache: Persisted | null = null;

  constructor(
    dir: string,
    private readonly retention = DEFAULT_RETENTION,
  ) {
    this.file = path.join(dir, "token-audit.json");
  }

  private load(): Persisted {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Persisted;
      if (Array.isArray(parsed?.samples)) {
        this.cache = { schema_version: BILLING_SCHEMA_VERSION, samples: parsed.samples };
        return this.cache;
      }
    } catch {
      // Missing or corrupt: start clean rather than take the process down. A
      // lost probe history is a nuisance; a crash loop on boot is an outage.
    }
    this.cache = { schema_version: BILLING_SCHEMA_VERSION, samples: [] };
    return this.cache;
  }

  private persist(): void {
    const data = this.load();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), "utf8");
    fs.renameSync(tmp, this.file);
  }

  append(sample: TokenAuditSample): void {
    const data = this.load();
    data.samples.push(sample);
    if (data.samples.length > this.retention) {
      data.samples = data.samples.slice(-this.retention);
    }
    this.persist();
  }

  /** Newest first, optionally limited to one host. */
  list(options?: { limit?: number; host?: string }): TokenAuditSample[] {
    const data = this.load();
    let out = [...data.samples].reverse();
    if (options?.host) out = out.filter((s) => s.host === options.host);
    if (options?.limit != null) out = out.slice(0, options.limit);
    return out;
  }

  /** Distinct hosts probed — the panel renders one column per account. */
  hosts(): string[] {
    return [...new Set(this.load().samples.map((s) => s.host))].sort();
  }
}
