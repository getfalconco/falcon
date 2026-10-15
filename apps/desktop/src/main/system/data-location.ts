import fs from "node:fs";
import path from "node:path";
import type { DataMoveProblem, DataRootSource } from "../../shared/system-settings";

/**
 * Where the data folder lives when the reader has moved it (Settings, System,
 * Storage folder), and the move itself.
 *
 * The choice is kept outside the data folder, in `<userData>/data-location.json`,
 * because it is what says where the data folder is: it has to be readable
 * before the data folder is known. The order is FALCON_DATA_ROOT (a developer
 * or support override), then the reader's choice, then the build's default.
 * The choice only applies from the next launch: every store resolves its paths
 * from the root this run started with, so switching under a running engine
 * would split its files across two folders.
 *
 * A move copies, checks the copy, and only then records the new folder. The
 * old folder is never deleted from here; the pane says it can be removed by
 * hand. Nothing in this file knows about Electron, so it runs against temp
 * dirs under `node --test`.
 */

export const DATA_LOCATION_FILE = "data-location.json";

/** The folder name a move creates inside a chosen folder that already has files in it. */
export const DATA_FOLDER_NAME = "Falcon";

export function dataLocationFile(userDataDir: string): string {
  return path.join(userDataDir, DATA_LOCATION_FILE);
}

/** The folder the reader chose, or null for none (or an unreadable, relative or malformed file). */
export function readDataLocation(userDataDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(dataLocationFile(userDataDir), "utf8"));
    const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>).root : null;
    return typeof root === "string" && root.trim() && path.isAbsolute(root.trim()) ? path.resolve(root.trim()) : null;
  } catch {
    return null;
  }
}

/** Records the chosen folder (null goes back to the default). Temp file + rename, so a crash never leaves half a file. */
export function writeDataLocation(userDataDir: string, root: string | null): void {
  const file = dataLocationFile(userDataDir);
  if (root == null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ root: path.resolve(root) }, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export type DataRootChoice = {
  root: string;
  source: DataRootSource;
  /** A chosen folder that was not there, so the default stood in for it. */
  missing: string | null;
};

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Which folder this run uses. A chosen folder that is gone (an unplugged
 * drive, a deleted folder) falls back to the default for this run and is
 * reported, rather than silently starting an empty folder in its place.
 */
export function chooseDataRoot(input: {
  envRoot: string | undefined | null;
  customRoot: string | null;
  defaultRoot: string;
  exists?: (p: string) => boolean;
}): DataRootChoice {
  const env = input.envRoot?.trim();
  if (env) return { root: env, source: "env", missing: null };
  const exists = input.exists ?? isDirectory;
  if (input.customRoot) {
    if (exists(input.customRoot)) return { root: input.customRoot, source: "custom", missing: null };
    return { root: input.defaultRoot, source: "default", missing: input.customRoot };
  }
  return { root: input.defaultRoot, source: "default", missing: null };
}

function comparable(p: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(p);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/** True when `child` is `parent` itself or somewhere below it. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = comparable(child, platform);
  const p = comparable(parent, platform);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isEmptyOrMissing(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export type DataMovePlan = { ok: true; target: string } | { ok: false; problem: DataMoveProblem };

/**
 * Where the data goes for a folder the reader picked: the folder itself when
 * it is empty or new, else a "Falcon" folder inside it, so picking Documents
 * does not scatter files across Documents. Refused when it is the folder in
 * use, lies inside it (a copy into itself), or the "Falcon" folder inside it
 * already has files.
 */
export function planDataMove(current: string, chosen: string, platform: NodeJS.Platform = process.platform): DataMovePlan {
  const picked = path.resolve(chosen);
  if (samePath(picked, current, platform)) return { ok: false, problem: "same-folder" };
  if (isInside(picked, current, platform)) return { ok: false, problem: "inside-current" };
  if (isEmptyOrMissing(picked)) return { ok: true, target: picked };
  const nested = path.join(picked, DATA_FOLDER_NAME);
  if (samePath(nested, current, platform)) return { ok: false, problem: "same-folder" };
  if (!isEmptyOrMissing(nested)) return { ok: false, problem: "not-empty" };
  return { ok: true, target: nested };
}

export class DataMoveError extends Error {
  constructor(
    readonly problem: DataMoveProblem,
    message: string,
  ) {
    super(message);
    this.name = "DataMoveError";
  }
}

type CopiedFile = { rel: string; size: number };

async function listFiles(root: string): Promise<CopiedFile[]> {
  const out: CopiedFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ rel: path.relative(root, full), size: (await fs.promises.stat(full)).size });
    }
  };
  await walk(root);
  return out;
}

async function listDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      await walk(full);
    }
  };
  await walk(root);
  return out;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Copies the data folder `from` into `to` (empty or new) and checks the copy:
 * every file there, at its source's size. A file the running app rewrote
 * mid-copy is copied once more. On any failure what this call created is
 * removed and `to` is left as it was found; `from` is only ever read.
 * Asynchronous, so the window stays responsive while a large folder copies.
 */
export async function copyDataFolder(from: string, to: string): Promise<{ files: number; bytes: number }> {
  const existed = fs.existsSync(to);
  if (!isEmptyOrMissing(to)) throw new DataMoveError("not-empty", `${to} is not empty`);
  try {
    await fs.promises.mkdir(to, { recursive: true });
    const probe = path.join(to, `.falcon-write-test-${process.pid}`);
    await fs.promises.writeFile(probe, "");
    await fs.promises.rm(probe);
  } catch (err) {
    if (!existed) await fs.promises.rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw new DataMoveError("not-writable", message(err));
  }

  const undo = async () => {
    try {
      if (existed) {
        for (const name of await fs.promises.readdir(to)) {
          await fs.promises.rm(path.join(to, name), { recursive: true, force: true });
        }
      } else {
        await fs.promises.rm(to, { recursive: true, force: true });
      }
    } catch {
      /* best effort: the new folder was never recorded, so the app still reads the old one */
    }
  };

  let files: CopiedFile[];
  try {
    files = await listFiles(from);
    // Empty folders too, so a store that expects its folder finds it.
    for (const dir of await listDirs(from)) await fs.promises.mkdir(path.join(to, dir), { recursive: true });
    for (const file of files) {
      const src = path.join(from, file.rel);
      const dest = path.join(to, file.rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
      // The app keeps running while this copies: a store that rewrote its
      // file in between gets one more copy, at the size it has now.
      const now = (await fs.promises.stat(src)).size;
      if ((await fs.promises.stat(dest)).size !== now) await fs.promises.copyFile(src, dest);
      file.size = now;
    }
  } catch (err) {
    await undo();
    throw new DataMoveError("copy-failed", message(err));
  }

  let copied: Map<string, number>;
  try {
    copied = new Map((await listFiles(to)).map((f) => [comparable(f.rel, process.platform), f.size]));
  } catch (err) {
    await undo();
    throw new DataMoveError("verify-failed", message(err));
  }
  const bad = files.find((f) => copied.get(comparable(f.rel, process.platform)) !== f.size);
  if (bad || copied.size !== files.length) {
    await undo();
    throw new DataMoveError("verify-failed", bad ? `${bad.rel} did not copy intact` : "file count differs");
  }
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}
