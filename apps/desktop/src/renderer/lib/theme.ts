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
 * One switch — Settings, General, Appearance — and one place it is kept.
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

/** Keep the choice and put it into effect at once. */
export function writeThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* a choice that cannot be kept is still worth applying */
  }
  applyTheme(resolveTheme(choice));
}

/** The theme in force: the kept choice, resolved. */
export function getStoredTheme(): Theme {
  return resolveTheme(readThemeChoice());
}

export function applyTheme(theme?: Theme): void {
  document.documentElement.dataset.theme = theme ?? getStoredTheme();
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
      if (readThemeChoice() === "system") applyTheme();
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}
