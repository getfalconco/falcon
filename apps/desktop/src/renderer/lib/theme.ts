export type Theme = "dark" | "light";

/**
 * The app is light-only: dark mode has been retired. The Theme type and the
 * function shapes are kept so existing call sites (useTheme, logo selection)
 * keep compiling, but every path resolves to "light".
 */

export function getStoredTheme(): Theme {
  return "light";
}

export function applyTheme(_theme?: Theme): void {
  document.documentElement.dataset.theme = "light";
}

export function toggleTheme(_current?: Theme): Theme {
  applyTheme("light");
  return "light";
}

export function getThemeSnapshot(): Theme {
  return "light";
}

export function subscribeTheme(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
