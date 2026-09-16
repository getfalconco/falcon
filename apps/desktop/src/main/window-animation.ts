import type { BrowserWindow } from "electron";
import { screen } from "electron";

/** Keep in sync with workspace enter transition in HomePage (Framer Motion). */
export const WORKSPACE_ENTER_MS = 550;

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Fraction of the display work area used when entering the workspace. */
const WORKSPACE_WIDTH_RATIO = 0.9;
const WORKSPACE_HEIGHT_RATIO = 0.9;

function workspaceTargetBounds(): Bounds {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.round(workArea.width * WORKSPACE_WIDTH_RATIO);
  const height = Math.round(workArea.height * WORKSPACE_HEIGHT_RATIO);

  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

function meridianEase(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function lerp(start: number, end: number, t: number): number {
  return Math.round(start + (end - start) * t);
}

export function animateWindowToWorkspace(window: BrowserWindow): Promise<void> {
  const target = workspaceTargetBounds();
  const start = window.getBounds();
  const startedAt = Date.now();

  window.setMinimumSize(720, 560);
  window.setResizable(true);

  return new Promise((resolve) => {
    const tick = () => {
      if (window.isDestroyed()) {
        resolve();
        return;
      }

      const elapsed = Date.now() - startedAt;
      const progress = Math.min(elapsed / WORKSPACE_ENTER_MS, 1);
      const eased = meridianEase(progress);

      window.setBounds({
        x: lerp(start.x, target.x, eased),
        y: lerp(start.y, target.y, eased),
        width: lerp(start.width, target.width, eased),
        height: lerp(start.height, target.height, eased),
      });

      if (progress < 1) {
        setTimeout(tick, 1000 / 60);
      } else {
        window.setBounds(target);
        resolve();
      }
    };

    tick();
  });
}
