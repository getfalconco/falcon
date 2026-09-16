/**
 * First-boot seeding of the Railway volume.
 *
 * A volume starts empty, and an empty volume is not a neutral starting point:
 *
 *   * the Classifier keys its verdicts by article, so with no verdict store it
 *     re-classifies every article it already has an answer for — real Anthropic
 *     spend, for nothing;
 *   * the Tracker would re-fetch three years of bars for the whole universe
 *     against a Finnhub free tier that is already the binding constraint;
 *   * Base's budget ledger and the propagation attempt log would forget what
 *     was already tried, so the breaker and the daily caps restart blind.
 *
 * The repo carries a checked-in copy of all of it (`apps/falcon-engine/seed-data`),
 * which the image already contains. So on the first boot — and only when the
 * target is genuinely empty — copy it in. A restart with a populated volume
 * touches nothing: this is a seed, never a sync, and the running chain's own
 * writes are always the newer truth.
 *
 * It lives beside this service, not under `apps/desktop/data`, because the
 * desktop no longer runs the chain and so no longer keeps this history. A copy
 * sitting in the app that stopped writing it reads like stale app state; here
 * it is what it actually is — this service's cold-start baseline.
 */

import fs from "node:fs";
import path from "node:path";

export type SeedResult = { dir: string; seeded: boolean; files: number; from: string | null };

/** Files that would make the target look populated when it is not really. */
function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true; // missing counts as empty
  }
}

function copyTree(from: string, to: string): number {
  let files = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) files += copyTree(src, dst);
    else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      files += 1;
    }
  }
  return files;
}

/**
 * Seed `targetDir` from the bundled copy for `name`, if the target is empty.
 * Returns what happened so the caller can log it — a seed that silently did or
 * did not run is the kind of thing that is only noticed by a surprise bill.
 */
export function seedDataDir(name: string, targetDir: string | undefined): SeedResult | null {
  if (!targetDir) return null;
  const bundled = path.resolve(
    process.env.FALCON_SEED_ROOT ?? "/app/apps/falcon-engine/seed-data",
    name,
  );
  if (!isEmptyDir(targetDir)) return { dir: targetDir, seeded: false, files: 0, from: null };
  if (!fs.existsSync(bundled)) return { dir: targetDir, seeded: false, files: 0, from: null };
  try {
    const files = copyTree(bundled, targetDir);
    return { dir: targetDir, seeded: true, files, from: bundled };
  } catch (err) {
    console.warn(`[engine] seed ${name} failed — ${err instanceof Error ? err.message : String(err)}`);
    return { dir: targetDir, seeded: false, files: 0, from: bundled };
  }
}

/**
 * Seed every engine's dir. Called before any store is constructed, because the
 * stores read their files on first touch and cache what they find.
 */
export function seedAllDataDirs(): void {
  const targets: Array<[string, string | undefined]> = [
    ["tracker", process.env.FALCON_TRACKER_DATA_DIR],
    ["classifier", process.env.FALCON_CLASSIFIER_DATA_DIR],
    ["base", process.env.FALCON_BASE_DATA_DIR],
    ["propagation", process.env.FALCON_PROPAGATION_DATA_DIR],
    ["analyst", process.env.FALCON_ANALYST_DATA_DIR],
    // Risk ships its calibration config (anchors, weights, the card flag) and
    // keeps 180 days of snapshots — both have to survive a deploy, or the
    // calibration week restarts every time this process does.
    ["risk", process.env.FALCON_RISK_DATA_DIR],
    // Screen keeps its findings store and its watchlist; Gauge keeps the
    // calibrated config. Gauge's stored config overrides the built-in
    // templates field by field, so without it the readouts here would be
    // worded differently from the ones the calibration week settled on.
    ["screen", process.env.FALCON_SCREEN_DATA_DIR],
    ["gauge", process.env.FALCON_GAUGE_DATA_DIR],
  ];
  for (const [name, dir] of targets) {
    const result = seedDataDir(name, dir);
    if (!result) continue;
    if (result.seeded) console.info(`[engine] seeded ${name}: ${result.files} file(s) → ${result.dir}`);
    else console.info(`[engine] ${name}: volume already populated (${result.dir})`);
  }
}

/**
 * The one exception to "a seed never syncs": the tracked-ticker list.
 *
 * The repo's tracker config is where universe growth is decided — the
 * expand-universe script writes the graph-derived price tier there, on a
 * branch, reviewed. But a populated volume never reads the seed again, so
 * that decision would only ever reach a FRESH volume; the live one would sit
 * on its old list until someone edited a file they cannot reach (Railway
 * volumes have no usable shell). So on every boot the shipped list is folded
 * into the volume's config — strictly additively:
 *
 *   * tickers:            union. Nothing is ever removed here — removal is a
 *                         runtime act (`tracker:remove-ticker`) that pins the
 *                         universe, and un-pinning it from a file would
 *                         resurrect deliberately removed names.
 *   * priceTierTickers:   union, MINUS anything the volume already tracks as
 *                         event tier. The tier says how a name is followed;
 *                         a shipped file must never demote a name someone
 *                         promoted to news at runtime.
 *
 * Every other field stays the volume's own. Idempotent by construction.
 */
export function applySeedUniverse(): void {
  const dir = process.env.FALCON_TRACKER_DATA_DIR?.trim();
  if (!dir) return;
  const seedPath = path.resolve(
    process.env.FALCON_SEED_ROOT ?? "/app/apps/falcon-engine/seed-data",
    "tracker/config.json",
  );
  const livePath = path.join(dir, "config.json");
  if (!fs.existsSync(seedPath) || !fs.existsSync(livePath)) return;

  try {
    type UniverseSlice = { tickers?: string[]; priceTierTickers?: string[] };
    const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as UniverseSlice;
    const live = JSON.parse(fs.readFileSync(livePath, "utf8")) as UniverseSlice & Record<string, unknown>;

    const up = (list: string[] | undefined) => (list ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);
    const liveTickers = new Set(up(live.tickers));
    const livePrice = new Set(up(live.priceTierTickers));
    const liveEventTier = new Set([...liveTickers].filter((t) => !livePrice.has(t)));

    const tickers = new Set(liveTickers);
    for (const t of up(seed.tickers)) tickers.add(t);
    const priceTier = new Set(livePrice);
    for (const t of up(seed.priceTierTickers)) {
      if (!liveEventTier.has(t)) priceTier.add(t);
    }

    const addedTickers = tickers.size - liveTickers.size;
    const addedPrice = priceTier.size - livePrice.size;
    if (addedTickers === 0 && addedPrice === 0) return;

    live.tickers = [...tickers].sort();
    live.priceTierTickers = [...priceTier].sort();
    fs.writeFileSync(livePath, JSON.stringify(live, null, 1));
    console.info(
      `[engine] universe folded from seed: +${addedTickers} ticker(s), +${addedPrice} price-tier → ` +
        `${live.tickers.length} total`,
    );
  } catch (err) {
    console.warn(`[engine] seed universe fold failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
