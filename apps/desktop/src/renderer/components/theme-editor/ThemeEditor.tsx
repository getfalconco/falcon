import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ClipboardPaste, Copy, Moon, Pin, PinOff, RotateCcw, Search } from "lucide-react";
import { useT, type MessageKey } from "@/lib/i18n";
import { getStoredTheme, writeThemeChoice, type Theme } from "@/lib/theme";
import { contrastRatio, composite, parseColor, toPickerHex, withPicker, type Rgba } from "@/lib/theme-editor/color";
import { acceptTyped, colorExpression, fromPicked } from "@/lib/theme-editor/edit";
import {
  OVERRIDES_KEY,
  diffOverrides,
  exportBlock,
  importBlock,
  type ThemeOverrides,
} from "@/lib/theme-editor/overrides";
import { loadOverrides, saveOverrides } from "@/lib/theme-editor/live";
import { groupTokens, parseDarkTokens, toneParts, type DarkToken, type TokenGroupId } from "@/lib/theme-editor/tokens";

/**
 * The dark theme colour editor, its own window (Settings, Developer, Testing,
 * "Dark theme colors"). Every dark token globals.css defines, grouped the way
 * the token list at the top of its dark layer is written; each one editable by
 * picker, opacity and text. Edits are local overrides kept in localStorage,
 * which the app window applies as they land (lib/theme-editor/live.ts). "Copy
 * changes" hands back a block shaped like the dark token block, to become the
 * new defaults; "Paste" restores one.
 *
 * This window never applies the overrides to itself: it is drawn in the
 * stylesheet's own dark, so a bad edit cannot make the editor unreadable, and
 * the defaults it compares against stay the file's.
 */

const PIN_KEY = "falcon.dev.themeEditor.onTop";
const EMPTY: ThemeOverrides = {};

const LABELS: Record<string, MessageKey> = {
  "--surface-0": "developer.themeEditor.label.canvas",
  "--surface-1": "developer.themeEditor.label.card",
  "--surface-2": "developer.themeEditor.label.raised",
  "--surface-3": "developer.themeEditor.label.popover",
  "--surface-4": "developer.themeEditor.label.highest",
  "--surface-sunken": "developer.themeEditor.label.rail",
  "--fill-hover": "developer.themeEditor.label.hover",
  "--fill-press": "developer.themeEditor.label.press",
  "--fill-selected": "developer.themeEditor.label.selected",
  "--fill-strong": "developer.themeEditor.label.mark",
  "--border-subtle": "developer.themeEditor.label.hairlineSubtle",
  "--border-default": "developer.themeEditor.label.hairline",
  "--border-strong": "developer.themeEditor.label.hairlineStrong",
  "--highlight": "developer.themeEditor.label.highlight",
  "--focus-ring": "developer.themeEditor.label.focusRing",
  "--text-primary": "developer.themeEditor.label.textPrimary",
  "--text-body": "developer.themeEditor.label.textBody",
  "--text-secondary": "developer.themeEditor.label.textSecondary",
  "--text-tertiary": "developer.themeEditor.label.textTertiary",
  "--text-disabled": "developer.themeEditor.label.textDisabled",
  "--ink-rgb": "developer.themeEditor.label.inkRgb",
  "--cta-bg": "developer.themeEditor.label.fill",
  "--cta-bg-hover": "developer.themeEditor.label.fillHover",
  "--cta-bg-press": "developer.themeEditor.label.fillPress",
  "--cta-fg": "developer.themeEditor.label.text",
  "--cta-border": "developer.themeEditor.label.edge",
  "--primary-bg": "developer.themeEditor.label.fill",
  "--primary-bg-hover": "developer.themeEditor.label.fillHover",
  "--primary-fg": "developer.themeEditor.label.text",
  "--switch-on": "developer.themeEditor.label.trackOn",
  "--switch-off": "developer.themeEditor.label.trackOff",
  "--switch-knob-on": "developer.themeEditor.label.knobOn",
  "--switch-knob-off": "developer.themeEditor.label.knobOff",
  "--backdrop": "developer.themeEditor.label.scrim",
  "--shadow-card": "developer.themeEditor.label.shadowCard",
  "--shadow-popover": "developer.themeEditor.label.shadowPopover",
  "--shadow-modal": "developer.themeEditor.label.shadowModal",
  "--chart-ink": "developer.themeEditor.label.chartInk",
};

const TONE_ROLE: Record<"muted" | "soft" | "line", MessageKey> = {
  muted: "developer.themeEditor.label.toneMuted",
  soft: "developer.themeEditor.label.toneSoft",
  line: "developer.themeEditor.label.toneLine",
};

/** Read against surface-1 (a card): text, and the tones and their quiet text, which are set as text. */
function wantsContrast(token: DarkToken): boolean {
  if (token.group === "text") return true;
  const tone = toneParts(token.name);
  return tone !== null && (tone.role === null || tone.role === "muted");
}

const CHECKER =
  "repeating-conic-gradient(rgba(255,255,255,0.16) 0% 25%, rgba(255,255,255,0.04) 0% 50%) 50% / 8px 8px";

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-[12px] text-content-primary transition-colors hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-50";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readPin(): boolean {
  try {
    return storage()?.getItem(PIN_KEY) !== "0";
  } catch {
    return true;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Every token as the page resolves it, under the given overrides, as channels.
 * A hidden `data-theme="dark"` element carries the overrides inline and one
 * child is coloured with each token in turn, so color-mix() and var() come back
 * as the colour they make.
 */
function useResolved(tokens: readonly DarkToken[], overrides: ThemeOverrides): Map<string, Rgba> {
  const [resolved, setResolved] = useState<Map<string, Rgba>>(() => new Map());
  const probeRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    let probe = probeRef.current;
    if (!probe) {
      probe = document.createElement("div");
      probe.dataset.theme = "dark";
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
      probe.appendChild(document.createElement("span"));
      document.body.appendChild(probe);
      probeRef.current = probe;
    }
    for (const token of tokens) probe.style.removeProperty(token.name);
    for (const [name, value] of Object.entries(overrides)) probe.style.setProperty(name, value);
    const swatch = probe.firstElementChild as HTMLSpanElement;
    const next = new Map<string, Rgba>();
    for (const token of tokens) {
      const expr = colorExpression(token.name, token.kind);
      if (!expr) continue;
      swatch.style.color = "";
      swatch.style.color = expr;
      const c = parseColor(getComputedStyle(swatch).color);
      if (c) next.set(token.name, c);
    }
    setResolved(next);
  }, [tokens, overrides]);
  useEffect(
    () => () => {
      probeRef.current?.remove();
      probeRef.current = null;
    },
    [],
  );
  return resolved;
}

/** The app window's theme, as the kept choice resolves on this machine; follows changes made anywhere. */
function useAppTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const refresh = useCallback(() => setTheme(getStoredTheme()), []);
  useEffect(() => {
    const update = refresh;
    window.addEventListener("storage", update);
    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", update);
    } catch {
      media = null;
    }
    return () => {
      window.removeEventListener("storage", update);
      media?.removeEventListener("change", update);
    };
  }, [refresh]);
  return [theme, refresh];
}

type Flash = { text: string; tone: "ok" | "bad" } | null;

export default function ThemeEditor({ cssSource }: { cssSource: string }) {
  const t = useT();
  const tokens = useMemo(() => parseDarkTokens(cssSource), [cssSource]);
  const [overrides, setOverrides] = useState<ThemeOverrides>(() => loadOverrides());
  const changed = useMemo(() => diffOverrides(tokens, overrides), [tokens, overrides]);
  const resolved = useResolved(tokens, changed);
  const defaults = useResolved(tokens, EMPTY);
  const [appTheme, refreshAppTheme] = useAppTheme();
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState(readPin);
  const [flash, setFlash] = useState<Flash>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [appVersion, setAppVersion] = useState("dev");
  const skipSave = useRef(true);

  // Keep, and so tell the app window. The first run is the load itself.
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    saveOverrides(changed);
  }, [changed]);

  // Another editor (a second browser tab in a harness) changing the set.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== OVERRIDES_KEY && e.key !== null) return;
      skipSave.current = true;
      setOverrides(loadOverrides());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    try {
      storage()?.setItem(PIN_KEY, pinned ? "1" : "0");
    } catch {
      /* the pin still applies for this session */
    }
    void window.meridian?.setThemeEditorOnTop?.(pinned)?.catch(() => {});
  }, [pinned]);

  useEffect(() => {
    let alive = true;
    void window.meridian
      ?.getDeveloperInfo?.()
      ?.then((res) => {
        if (alive && res.ok) setAppVersion(res.info.appVersion);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.title = t("developer.themeEditor.title");
  }, [t]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(id);
  }, [flash]);

  const setValue = useCallback((token: DarkToken, value: string | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null) delete next[token.name];
      else next[token.name] = value;
      return next;
    });
  }, []);

  const labelFor = useCallback(
    (token: DarkToken): string | null => {
      const key = LABELS[token.name];
      if (key) return t(key);
      const tone = toneParts(token.name);
      if (!tone) return null;
      const toneName = t(`developer.themeEditor.tone.${tone.tone}` as MessageKey);
      return tone.role ? t(TONE_ROLE[tone.role], { tone: toneName }) : toneName;
    },
    [t],
  );

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const visible = q
      ? tokens.filter((token) =>
          [token.name, labelFor(token) ?? "", overrides[token.name] ?? token.value].some((s) => s.toLowerCase().includes(q)),
        )
      : tokens;
    return groupTokens(visible);
  }, [tokens, q, labelFor, overrides]);

  const count = Object.keys(changed).length;
  const card = useMemo(() => {
    const s1 = resolved.get("--surface-1");
    const s0 = resolved.get("--surface-0") ?? { r: 0, g: 0, b: 0, a: 1 };
    return s1 ? composite(s1, { ...s0, a: 1 }) : null;
  }, [resolved]);

  const doCopy = async (all: boolean) => {
    const block = exportBlock(tokens, changed, { all, date: new Date(), appVersion });
    const ok = await copyText(block);
    setFlash(ok ? { text: t("developer.themeEditor.copied"), tone: "ok" } : { text: t("developer.themeEditor.copyFailed"), tone: "bad" });
  };

  const doPaste = () => {
    const result = importBlock(tokens, pasteText);
    if (result.read === 0) {
      setFlash({ text: t("developer.themeEditor.pasteEmpty"), tone: "bad" });
      return;
    }
    setOverrides(result.overrides);
    setPasteOpen(false);
    setPasteText("");
    setFlash({ text: t("developer.themeEditor.pasteApplied", { count: result.read }), tone: "ok" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1 text-content-primary">
      <header className="shrink-0 border-b border-edge-subtle bg-surface-1 px-4 pb-3 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-medium text-content-primary">{t("developer.themeEditor.title")}</h1>
            <p className="mt-0.5 text-[11.5px] leading-snug text-content-secondary">
              {t("developer.themeEditor.localNote")}
            </p>
          </div>
          <button
            type="button"
            aria-pressed={pinned}
            onClick={() => setPinned((p) => !p)}
            className={`${BUTTON} shrink-0 ${pinned ? "bg-surface-3" : ""}`}
            title={t("developer.themeEditor.pin")}
          >
            {pinned ? <Pin className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /> : <PinOff className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />}
            {t("developer.themeEditor.pin")}
          </button>
        </div>

        {appTheme !== "dark" ? (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-tone-warning-line bg-tone-warning-soft px-2.5 py-2">
            <p className="text-[12px] leading-snug text-content-body">{t("developer.themeEditor.lightNote")}</p>
            <button type="button" onClick={() => {
                // The app window follows through the storage event (live.ts); this window hears no
                // event for its own write, so it reads the choice back itself.
                writeThemeChoice("dark");
                refreshAppTheme();
              }} className={`${BUTTON} shrink-0`}>
              <Moon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              {t("developer.themeEditor.switchDark")}
            </button>
          </div>
        ) : null}

        <label className="mt-3 flex items-center gap-2 rounded-lg border border-edge bg-surface-2 px-2.5 focus-within:border-edge-strong">
          <Search className="h-3.5 w-3.5 shrink-0 text-content-tertiary" strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("developer.themeEditor.search")}
            aria-label={t("developer.themeEditor.search")}
            className="h-8 min-w-0 flex-1 bg-transparent text-[12.5px] text-content-primary outline-none placeholder:text-content-tertiary"
          />
        </label>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => void doCopy(false)} disabled={count === 0} className={BUTTON}>
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {t("developer.themeEditor.copy")}
          </button>
          <button type="button" onClick={() => void doCopy(true)} className={BUTTON}>
            {t("developer.themeEditor.copyAll")}
          </button>
          <button type="button" aria-expanded={pasteOpen} onClick={() => setPasteOpen((o) => !o)} className={BUTTON}>
            <ClipboardPaste className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {t("developer.themeEditor.paste")}
          </button>
          <button type="button" onClick={() => setOverrides({})} disabled={count === 0} className={BUTTON}>
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {t("developer.themeEditor.resetAll")}
          </button>
          <span className="ml-auto text-[11.5px] tabular-nums text-content-secondary" data-testid="changed-count">
            {t("developer.themeEditor.changed", { count })}
          </span>
        </div>

        {flash ? (
          <p
            role="status"
            className={`mt-2 flex items-center gap-1.5 text-[12px] ${flash.tone === "ok" ? "text-tone-positive" : "text-tone-negative"}`}
          >
            {flash.tone === "ok" ? <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> : null}
            {flash.text}
          </p>
        ) : null}

        {pasteOpen ? (
          <div className="mt-2.5">
            <p className="text-[11.5px] leading-snug text-content-secondary">{t("developer.themeEditor.pasteHint")}</p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={5}
              spellCheck={false}
              aria-label={t("developer.themeEditor.paste")}
              className="mt-1.5 w-full resize-y rounded-lg border border-edge bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] text-content-primary outline-none focus:border-edge-strong"
              placeholder={'[data-theme="dark"] {\n  --surface-1: #131312;\n}'}
            />
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" onClick={doPaste} disabled={!pasteText.trim()} className={BUTTON}>
                {t("developer.themeEditor.pasteApply")}
              </button>
              <button type="button" onClick={() => setPasteOpen(false)} className={BUTTON}>
                {t("developer.themeEditor.pasteCancel")}
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {tokens.length === 0 ? (
          <p className="pt-6 text-[12.5px] text-content-secondary">{t("developer.themeEditor.none")}</p>
        ) : groups.length === 0 ? (
          <p className="pt-6 text-[12.5px] text-content-secondary">{t("developer.themeEditor.empty")}</p>
        ) : (
          groups.map(({ group, tokens: list }) => (
            <Group key={group} group={group} filtering={q !== ""} title={t(`developer.themeEditor.group.${group}` as MessageKey)}>
              {group === "legacy" ? (
                <p className="mb-1 text-[11.5px] leading-snug text-content-tertiary">{t("developer.themeEditor.legacyNote")}</p>
              ) : null}
              {list.map((token) => (
                <TokenRow
                  key={token.name}
                  token={token}
                  label={labelFor(token)}
                  current={changed[token.name] ?? token.value}
                  changed={token.name in changed}
                  resolved={resolved.get(token.name) ?? null}
                  defaultResolved={defaults.get(token.name) ?? null}
                  card={wantsContrast(token) ? card : null}
                  onChange={setValue}
                />
              ))}
            </Group>
          ))
        )}
      </main>
    </div>
  );
}


function Group({
  group,
  title,
  filtering,
  children,
}: {
  group: TokenGroupId;
  title: string;
  filtering: boolean;
  children: ReactNode;
}) {
  const heading = <span className="text-[12px] font-medium text-content-secondary">{title}</span>;
  if (group === "legacy" && !filtering) {
    return (
      <details className="group/legacy pt-4">
        <summary className="cursor-pointer select-none list-none py-1">
          {heading}
          <span className="ml-1.5 text-content-tertiary group-open/legacy:hidden">+</span>
        </summary>
        <div className="mt-1">{children}</div>
      </details>
    );
  }
  return (
    <section className="pt-4">
      <h2 className="py-1">{heading}</h2>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function TokenRow({
  token,
  label,
  current,
  changed,
  resolved,
  defaultResolved,
  card,
  onChange,
}: {
  token: DarkToken;
  label: string | null;
  current: string;
  changed: boolean;
  resolved: Rgba | null;
  defaultResolved: Rgba | null;
  card: Rgba | null;
  onChange: (token: DarkToken, value: string | null) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(current);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(current);
  }, [current, focused]);

  const typed = acceptTyped(token.kind, draft);
  const invalid = draft.trim() !== current && typed === null;
  const isShadow = token.kind === "shadow";
  const hasAlpha =
    !isShadow &&
    token.kind !== "hsl-channels" &&
    token.kind !== "rgb-channels" &&
    ((resolved?.a ?? 1) < 1 || (defaultResolved?.a ?? 1) < 1 || (parseColor(token.value)?.a ?? 1) < 1);
  const alpha = resolved?.a ?? 1;

  const write = (value: string | null) => {
    if (value === null) return;
    const same = value.trim().replace(/\s+/g, " ").toLowerCase() === token.value.toLowerCase();
    onChange(token, same ? null : value);
  };

  const pick = (hex: string) => {
    const c = withPicker(hex, hasAlpha ? alpha : 1);
    if (c) write(fromPicked(token.kind, c));
  };

  const setAlpha = (a: number) => {
    if (!resolved) return;
    write(fromPicked(token.kind, { ...resolved, a }));
  };

  const ratio = card && resolved ? contrastRatio(resolved, card) : null;
  const ratioTone = ratio === null ? "" : ratio >= 4.5 ? "text-content-secondary" : ratio >= 3 ? "text-tone-warning" : "text-tone-negative";
  const swatch = resolved ? `rgba(${resolved.r}, ${resolved.g}, ${resolved.b}, ${resolved.a})` : "transparent";

  return (
    <div className="flex items-start gap-2.5 border-b border-edge-subtle py-2.5 last:border-b-0" data-token={token.name}>
      {isShadow ? (
        <span
          aria-hidden
          className="mt-0.5 h-7 w-7 shrink-0 rounded-md border border-edge bg-surface-3"
          style={{ boxShadow: current }}
        />
      ) : (
        <label className="relative mt-0.5 h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-edge">
          <span aria-hidden className="absolute inset-0" style={{ background: CHECKER }} />
          <span aria-hidden className="absolute inset-0" style={{ background: swatch }} />
          <input
            type="color"
            value={resolved ? toPickerHex(resolved) : "#000000"}
            onChange={(e) => pick(e.target.value)}
            aria-label={t("developer.themeEditor.picker", { name: token.name })}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            {label ? <div className="truncate text-[12.5px] text-content-primary">{label}</div> : null}
            <div className={`truncate font-mono text-[11px] ${label ? "text-content-tertiary" : "text-content-primary"}`}>
              {token.name}
              {changed ? <span className="ml-1.5 text-tone-info">*</span> : null}
            </div>
          </div>
          {ratio !== null ? (
            <span className={`shrink-0 text-[11px] tabular-nums ${ratioTone}`}>
              {t("developer.themeEditor.contrast", { ratio: ratio.toFixed(1) })}
            </span>
          ) : null}
        </div>

        <input
          type="text"
          value={draft}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setDraft(current);
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            const next = acceptTyped(token.kind, e.target.value);
            if (next !== null) write(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(current);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label={token.name}
          aria-invalid={invalid}
          title={invalid ? t("developer.themeEditor.invalid") : undefined}
          className={`mt-1.5 h-7 w-full rounded-md border bg-surface-2 px-2 font-mono text-[11.5px] text-content-primary outline-none ${
            invalid ? "border-tone-negative-line" : "border-edge focus:border-edge-strong"
          }`}
        />

        {hasAlpha ? (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-content-tertiary">{t("developer.themeEditor.opacity")}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={alpha}
              onChange={(e) => setAlpha(Number(e.target.value))}
              aria-label={`${t("developer.themeEditor.opacity")} ${token.name}`}
              className="h-1 min-w-0 flex-1 accent-[var(--text-secondary)]"
            />
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-content-secondary">
              {Math.round(alpha * 1000) / 10}%
            </span>
          </div>
        ) : null}

        {token.kind === "derived" && !changed ? (
          <p className="mt-1 text-[11px] leading-snug text-content-tertiary">{t("developer.themeEditor.derived")}</p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onChange(token, null)}
        disabled={!changed}
        aria-label={t("developer.themeEditor.reset", { name: token.name })}
        title={t("developer.themeEditor.reset", { name: token.name })}
        className="mt-0.5 rounded-md p-1.5 text-content-tertiary transition-colors hover:bg-fill-hover hover:text-content-primary disabled:invisible"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
