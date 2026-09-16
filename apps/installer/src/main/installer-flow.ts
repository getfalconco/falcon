import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { PHASE_RANGES, type InstallProgress } from "../shared/install-types";
import { fetchLatestRelease, scale, type ProgressSink, type ReleaseArtifact } from "./release-feed";

/**
 * The bootstrapper's actual job: read the release feed, download the real
 * Falcon installer, check it against the hash the feed publishes, run it
 * silently, and find the installed app so the last screen can launch it.
 *
 * Nothing here is optional — a downloaded executable is only run after its
 * SHA-512 matches what the feed says it should be.
 */

let running = false;
let installedExe: string | null = null;

export function installedFalconPath(): string | null {
  return installedExe;
}

export async function runInstall(report: ProgressSink): Promise<void> {
  if (running) return;
  running = true;

  const emit = (progress: InstallProgress) => report(progress);

  try {
    emit({ phase: "connecting", value: null, label: "Falcon-Setup.exe" });
    const release = await fetchLatestRelease();

    const target = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "falcon-install-")),
      release.name,
    );

    const digest = await download(release, target, (fraction) => {
      emit({
        phase: "downloading",
        value: scale(PHASE_RANGES.downloading, fraction),
        label: release.name,
        version: release.version,
      });
    });

    emit({
      phase: "verifying",
      value: PHASE_RANGES.verifying[1],
      label: "Verifying download",
      version: release.version,
    });
    verify(release, target, digest);

    emit({
      phase: "installing",
      value: PHASE_RANGES.installing[1],
      label: "Installing Falcon",
      version: release.version,
    });
    await runSetup(target);

    installedExe = locateInstalledFalcon();
    if (!installedExe) {
      console.warn("[install] installed, but Falcon.exe could not be located");
    }
    emit({ phase: "done", value: 100, label: "Ready to launch", version: release.version });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[install] failed:", message);
    emit({ phase: "failed", value: null, label: "Install failed", error: message });
  } finally {
    running = false;
  }
}

/** Streams the installer to disk, hashing as it goes so it is read only once. */
async function download(
  release: ReleaseArtifact,
  target: string,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const res = await fetch(release.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (HTTP ${res.status})`);
  }

  const hash = crypto.createHash("sha512");
  const out = fs.createWriteStream(target);
  const reader = res.body.getReader();
  let received = 0;
  // Repainting on every chunk would be thousands of renders for a 100 MB file.
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    received += value.length;
    if (!out.write(value)) {
      await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    if (received - lastReport >= 262_144) {
      lastReport = received;
      onProgress(received / release.size);
    }
  }

  out.end();
  await finished(out);
  onProgress(1);

  if (received !== release.size) {
    throw new Error(`size mismatch: got ${received}, expected ${release.size}`);
  }
  return hash.digest("base64");
}

/** A mismatched file is deleted rather than left on disk to be run by accident. */
function verify(release: ReleaseArtifact, target: string, digest: string): void {
  const expected = Buffer.from(release.sha512, "base64");
  const actual = Buffer.from(digest, "base64");
  const ok =
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!ok) {
    fs.rmSync(target, { force: true });
    throw new Error("downloaded file did not match the published checksum");
  }
}

/** `/S` is NSIS's silent switch; the desktop build sets runAfterFinish: false. */
function runSetup(setupPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(setupPath, ["/S"], { windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`installer exited with code ${code}`));
    });
  });
}

/**
 * Where the silent install put Falcon.
 *
 * NSIS names the install directory after the *package* name rather than the
 * product name, so guessing "Falcon" is not safe on its own — the uninstall
 * entry Windows writes is the authority. Cheap guesses first, registry if
 * they miss.
 */
function locateInstalledFalcon(): string | null {
  const programs = path.join(process.env.LOCALAPPDATA ?? "", "Programs");
  const guesses = [
    path.join(programs, "falcon", "Falcon.exe"),
    path.join(programs, "Falcon", "Falcon.exe"),
  ];
  for (const guess of guesses) {
    if (fs.existsSync(guess)) return path.resolve(guess);
  }
  return fromUninstallRegistry();
}

/** DisplayIcon on the uninstall entry reads "<install dir>\Falcon.exe,0". */
function fromUninstallRegistry(): string | null {
  if (process.platform !== "win32") return null;

  const roots = [
    String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
    String.raw`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
  ];

  for (const root of roots) {
    try {
      const out = execFileSync("reg", ["query", root, "/s", "/v", "DisplayIcon"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      for (const line of out.split(/\r?\n/)) {
        const value = /DisplayIcon\s+REG_\w+\s+(.+)$/.exec(line.trim())?.[1];
        if (!value) continue;
        const exe = value.replace(/,\d+\s*$/, "").replace(/^"|"$/g, "").trim();
        if (/[\/]Falcon\.exe$/i.test(exe) && fs.existsSync(exe)) return exe;
      }
    } catch {
      // No entry under this root, or reg is unavailable — try the next one.
    }
  }
  return null;
}

/** Starts Falcon detached so it outlives this window. */
export function launchFalcon(): boolean {
  if (!installedExe) return false;
  spawn(installedExe, [], { detached: true, stdio: "ignore" }).unref();
  return true;
}
