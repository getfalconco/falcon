import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { applyTheme, THEME_FADE_DEADLINE_MS, writeThemeChoice } from "./theme";

/**
 * The theme crossfade (applyTheme with `animate`) runs inside a view
 * transition. Whatever happens to the transition (skipped, thrown,
 * rejected, never given a frame because the page is not being drawn), the
 * theme has to land. A minimal document stands in for the browser.
 */

type FakeTransition = { updateCallbackDone?: Promise<void> };

type FakeDoc = {
  documentElement: { dataset: Record<string, string | undefined> };
  hidden: boolean;
  visibilityState: string;
  startViewTransition?: (update: () => void) => FakeTransition;
};

const g = globalThis as unknown as { document?: FakeDoc; window?: unknown; localStorage?: unknown };
let doc: FakeDoc;
let started = 0;

function install(start?: (update: () => void) => FakeTransition): void {
  doc = {
    documentElement: { dataset: { theme: "dark", motion: "full" } },
    hidden: false,
    visibilityState: "visible",
    startViewTransition: start
      ? (update) => {
          started++;
          return start(update);
        }
      : undefined,
  };
  g.document = doc;
  g.window = { matchMedia: () => ({ matches: false }) };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

const theme = () => doc.documentElement.dataset.theme;

describe("theme crossfade always lands", () => {
  beforeEach(() => {
    started = 0;
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => {
    mock.timers.reset();
    // Let any fade still waiting land, so the next test starts clean.
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.timers.tick(THEME_FADE_DEADLINE_MS);
    mock.timers.reset();
    delete g.document;
    delete g.window;
    delete g.localStorage;
  });

  it("crossfades through the transition's update when the page is drawing", () => {
    let update: (() => void) | null = null;
    install((u) => {
      update = u;
      return {};
    });
    applyTheme("light", { animate: true });
    assert.equal(started, 1);
    assert.equal(theme(), "dark", "the old theme stays on screen until the snapshot");
    update!();
    assert.equal(theme(), "light");
  });

  it("lands by the deadline when the transition never gets a frame (hidden pane)", () => {
    install(() => ({})); // never calls update
    writeThemeChoice("light");
    assert.equal(theme(), "dark");
    mock.timers.tick(THEME_FADE_DEADLINE_MS);
    assert.equal(theme(), "light");
  });

  it("applies at once when the document is not visible", () => {
    install(() => ({}));
    doc.visibilityState = "hidden";
    doc.hidden = true;
    applyTheme("light", { animate: true });
    assert.equal(started, 0);
    assert.equal(theme(), "light");
  });

  it("applies at once when startViewTransition throws", () => {
    install(() => {
      throw new Error("InvalidStateError");
    });
    applyTheme("light", { animate: true });
    assert.equal(theme(), "light");
  });

  it("applies when the update callback promise rejects without running it", async () => {
    install(() => ({ updateCallbackDone: Promise.reject(new Error("skipped")) }));
    applyTheme("light", { animate: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(theme(), "light");
  });

  it("applies at once without the API, and under reduced motion", () => {
    install();
    applyTheme("light", { animate: true });
    assert.equal(theme(), "light");

    install(() => ({}));
    doc.documentElement.dataset.motion = "reduce";
    applyTheme("light", { animate: true });
    assert.equal(started, 0);
    assert.equal(theme(), "light");
  });

  it("a second change while a fade is pending lands on the latest choice", () => {
    let update: (() => void) | null = null;
    install((u) => {
      update = u;
      return {};
    });
    applyTheme("light", { animate: true });
    applyTheme("dark", { animate: true });
    assert.equal(started, 1, "one transition, retargeted");
    update!();
    assert.equal(theme(), "dark");

    applyTheme("light", { animate: true });
    applyTheme("dark"); // an instant change overrides a pending fade
    assert.equal(theme(), "dark");
    update!();
    assert.equal(theme(), "dark");
  });
});
