/// <reference types="vite/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

type InstallProgress = import("../shared/install-types").InstallProgress;

interface FalconInstallerBridge {
  minimize: () => Promise<void>;
  close: () => Promise<void>;
  platform: NodeJS.Platform;
  startInstall: () => Promise<{ ok: true }>;
  getInstallProgress: () => Promise<InstallProgress>;
  onInstallProgress: (listener: (progress: InstallProgress) => void) => () => void;
  launchFalcon: () => Promise<{ ok: boolean; path: string | null }>;
}

interface Window {
  falconInstaller?: FalconInstallerBridge;
}
