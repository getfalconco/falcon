/**
 * Desktop download links. Releases live in the public `Falcon-Releases` repo
 * (the source repo is private); GitHub's `latest/download/<asset>` URL always
 * resolves to the newest release, so these never need bumping. The env vars
 * stay as an override for staging or a mirror.
 */
const RELEASES = "https://github.com/KuzeyKovalak/Falcon-Releases/releases/latest/download";

export const MAC_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL ?? `${RELEASES}/Falcon-arm64.dmg`;
export const WINDOWS_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL ?? `${RELEASES}/Falcon-Setup.exe`;
