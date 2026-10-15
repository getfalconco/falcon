import fs from "node:fs";
import path from "node:path";
import { normalizeSystemSettings, type SystemSettings } from "../../shared/system-settings";

/**
 * The System pane's own switches on this machine, in
 * `<data root>/system/settings.json`. Synchronous on purpose: hardware
 * acceleration has to be read before Electron is ready, when nothing async
 * has had a chance to run.
 *
 * Nothing here knows about Electron, so it can be driven against a temp dir.
 */

export function systemSettingsFile(root: string): string {
  return path.join(root, "system", "settings.json");
}

/** The stored settings; a missing or unreadable file reads as the defaults. */
export function readSystemSettings(root: string): SystemSettings {
  try {
    return normalizeSystemSettings(JSON.parse(fs.readFileSync(systemSettingsFile(root), "utf8")));
  } catch {
    return normalizeSystemSettings(null);
  }
}

/** Merges a change into the stored settings; temp file + rename, so a crash never leaves half a file. */
export function writeSystemSettings(root: string, patch: Partial<SystemSettings>): SystemSettings {
  const next = normalizeSystemSettings({ ...readSystemSettings(root), ...patch });
  const file = systemSettingsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/**
 * Total size of a directory tree in bytes. Symlinks are not followed, and an
 * entry that vanishes or cannot be read mid-walk is skipped rather than
 * failing the whole count. A missing root is zero.
 */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.stat(full)).size;
        } catch {
          /* gone or locked — not worth failing the count over */
        }
      }
    }
  };
  await walk(root);
  return total;
}
