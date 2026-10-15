/**
 * Settings → Developer contract: what this build is and where it keeps
 * things. Paths are the reader's own machine's; nothing secret is in here.
 */

export type DeveloperBuildInfo = {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  packaged: boolean;
  /** Read from the checkout's .git in a dev build; null when there is none (packaged). */
  commit: { sha: string; branch: string | null } | null;
  /** Engine state, the graph and caches (FALCON_DATA_ROOT or the default). */
  dataRoot: string;
  /** Electron's user-data directory: Chromium storage, local preferences. */
  userData: string;
  devToolsOpen: boolean;
};

/** Folders the pane may ask main to open. A fixed list: the renderer never names a path. */
export type DeveloperFolder = "data" | "userData";
