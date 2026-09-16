import type { InstallProgress } from "../shared/install-types";

/**
 * Falcon's release feed. electron-builder publishes `latest.yml` beside the
 * installer on every release, and GitHub's `latest/download/<name>` URL always
 * points at the newest one, so nothing here needs bumping per release.
 */
const RELEASES_BASE =
  "https://github.com/KuzeyKovalak/Falcon-Releases/releases/latest/download";

/** Overridable so the flow can be exercised against a local fixture. */
export function releasesBase(): string {
  return process.env.FALCON_RELEASE_FEED?.trim() || RELEASES_BASE;
}

export type ReleaseArtifact = {
  version: string;
  /** File name of the installer, as published. */
  name: string;
  url: string;
  /** Base64 SHA-512 of the file, straight from the feed. */
  sha512: string;
  size: number;
};

/**
 * Reads `latest.yml`. It is small and regular enough that the three fields we
 * need can be pulled out directly — pulling in a YAML parser for four lines
 * would be the heavier choice.
 */
export async function fetchLatestRelease(): Promise<ReleaseArtifact> {
  const base = releasesBase();
  const res = await fetch(`${base}/latest.yml`, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`release feed unavailable (HTTP ${res.status})`);
  }
  const yml = await res.text();

  const version = /^version:\s*["']?([^\s"']+)/m.exec(yml)?.[1];
  const name = /^\s*(?:-\s*url|path):\s*["']?([^\s"']+)/m.exec(yml)?.[1];
  const sha512 = /^\s*sha512:\s*["']?([A-Za-z0-9+/=]+)/m.exec(yml)?.[1];
  const size = /^\s*size:\s*(\d+)/m.exec(yml)?.[1];

  if (!version || !name || !sha512 || !size) {
    throw new Error("release feed is malformed");
  }

  return {
    version,
    name,
    url: `${base}/${name}`,
    sha512,
    size: Number.parseInt(size, 10),
  };
}

/** Maps a phase's own 0–1 fraction onto its slice of the overall bar. */
export function scale(
  range: readonly [number, number],
  fraction: number,
): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return range[0] + (range[1] - range[0]) * clamped;
}

export type ProgressSink = (progress: InstallProgress) => void;
