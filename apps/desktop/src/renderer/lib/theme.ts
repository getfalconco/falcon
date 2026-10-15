export type Theme = "dark" | "light";

/**
 * What the reader asked for, which is not quite a theme: "system" is a
 * deferral to the machine, and only becomes one on the day it is read.
 */
export type ThemeChoice = "system" | "light" | "dark";

/**
 * The app has two themes again. Light is what the dashboard was drawn in;
 * dark is the same drawing with its palette translated at the end of
 * `globals.css`, keyed on the `data-theme` attribute this module sets.
 *
 * One switch — Settings, Appearance — and one place it is kept.
 */
const KEY = "falcon.ui.theme.choice";

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function readThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "system" || raw === "light" || raw === "dark") return raw;
  } catch {
    /* storage is not always there */
  }
  return "system";
}

/** The theme a choice comes to right now. "system" asks the machine. */
export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === "system" ? (prefersDark() ? "dark" : "light") : choice;
}

/** Keep the choice and put it into effect, crossfading to it (see `applyTheme`). */
export function writeThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* a choice that cannot be kept is still worth applying */
  }
  applyTheme(resolveTheme(choice), { animate: true });
}

/** The theme in force: the kept choice, resolved. */
export function getStoredTheme(): Theme {
  return resolveTheme(readThemeChoice());
}

type ViewTransition = { updateCallbackDone?: Promise<void>; finished?: Promise<void> };
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransition;
};

/**
 * Whether a theme change may crossfade. Never under reduced motion (the
 * reader's choice is on <html> as `data-motion`, see lib/motion.ts; the OS
 * setting is the fallback before that has run), never in a window that is
 * not on screen, and only where the View Transitions API exists.
 */
function canCrossfade(): boolean {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== "function") return false;
  if (doc.hidden || (doc.visibilityState && doc.visibilityState !== "visible")) return false;
  const motion = document.documentElement.dataset.motion;
  if (motion === "reduce") return false;
  if (motion !== "full") {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    } catch {
      /* no matchMedia: animate */
    }
  }
  return true;
}

/**
 * The longest a crossfade may hold a theme back. A view transition runs its
 * update on the next rendered frame, and a page that is not rendering (a
 * hidden or covered preview pane, a window the OS has stopped painting)
 * may never get one; by then the theme lands without the fade.
 */
export const THEME_FADE_DEADLINE_MS = 250;

/** The theme a crossfade under way is heading to; null when none is. */
let pendingTheme: Theme | null = null;

function land(): void {
  if (pendingTheme === null) return;
  document.documentElement.dataset.theme = pendingTheme;
  pendingTheme = null;
}

/**
 * Put a theme into effect. Called at startup it lands at once (`animate`
 * off, the default), so the first frame is already in the right theme.
 *
 * With `animate`, the change is a crossfade: the View Transitions API takes
 * a picture of the page in the old theme, the new one is laid out behind it,
 * and the compositor fades one into the other (`::view-transition-*(root)`
 * in globals.css, ~300ms). Nothing in the page animates its own colours, so
 * the fade costs two textures, not a transition on every element, and the
 * restyle the switch needs happens while the old picture is still on
 * screen instead of as a dropped frame.
 *
 * The theme always lands: if the transition is skipped, throws, rejects or
 * is never given a frame, it is set directly (THEME_FADE_DEADLINE_MS at the
 * latest). A second change while a fade is on its way retargets it.
 */
export function applyTheme(theme?: Theme, options?: { animate?: boolean }): void {
  const next = theme ?? getStoredTheme();
  const root = document.documentElement;
  if ((pendingTheme ?? root.dataset.theme) === next) return;
  if (!options?.animate || !root.dataset.theme || !canCrossfade()) {
    pendingTheme = null;
    root.dataset.theme = next;
    return;
  }
  if (pendingTheme !== null) {
    pendingTheme = next;
    return;
  }
  pendingTheme = next;
  const deadline = setTimeout(land, THEME_FADE_DEADLINE_MS);
  const update = () => {
    clearTimeout(deadline);
    land();
  };
  try {
    const transition = (document as ViewTransitionDocument).startViewTransition!(update);
    transition?.updateCallbackDone?.catch(update);
  } catch {
    update();
  }
}

/** Flips the theme and keeps the flip, so it survives the next launch. */
export function toggleTheme(current?: Theme): Theme {
  const next: Theme = (current ?? getThemeSnapshot()) === "dark" ? "light" : "dark";
  writeThemeChoice(next);
  return next;
}

export function getThemeSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function subscribeTheme(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * While the choice is "system" the machine can change its mind — at sunset,
 * or because someone flipped it in Windows — and the app follows without
 * being reopened. A choice of light or dark ignores it.
 */
export function watchSystemTheme(): () => void {
  try {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readThemeChoice() === "system") applyTheme(undefined, { animate: true });
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}
