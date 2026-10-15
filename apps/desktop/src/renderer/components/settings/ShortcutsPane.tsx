import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CONTEXTUAL_SHORTCUTS,
  SHORTCUTS,
  comboFromEvent,
  comboLabels,
  comboToString,
  defaultBindings,
  detectPlatform,
  formatKeys,
  isModifierOnly,
  resetAllBindings,
  resetBinding,
  setBinding,
  type BindingCheck,
  type BindingProblem,
  type ContextualShortcutId,
  type Platform,
  type ReservedUse,
  type ShortcutDef,
  type ShortcutGroup,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useBindings } from "@/lib/use-shortcuts";
import { useI18n, useT, type MessageKey, type TFunction } from "@/lib/i18n";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { listParts } from "./i18n-helpers";

/**
 * Shortcuts — every key the app answers to, from the registry in
 * lib/shortcuts. App-wide shortcuts can be moved: click the keys, press the
 * new ones (Esc gives up), and the change holds at once and across launches.
 * A press that is already taken, or that belongs to the window or to text
 * editing, is refused with the reason. Keys that belong to whatever has focus
 * (Esc, arrows, Enter) are listed below them and cannot be moved.
 */

const PLATFORM: Platform = detectPlatform();

const FIELD =
  "app-no-drag h-9 w-full rounded-xl border border-white/60 bg-white/55 pl-9 pr-3 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-[#9CA3AF] focus:bg-white/75 [&::-webkit-search-cancel-button]:hidden";

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-50";

const REBINDABLE_GROUPS: readonly Exclude<ShortcutGroup, "In context">[] = ["Navigation", "Panels", "Presentation"];

/*
 * The registry (lib/shortcuts) keeps English; these maps give every row,
 * group and refusal its words in the reader's language. Typed by the
 * registry's ids, so a new shortcut fails to compile until it is worded here.
 */

const SHORTCUT_WORDS: Readonly<Record<ShortcutId, { label: MessageKey; description?: MessageKey }>> = {
  search: { label: "settings.shortcuts.def.search" },
  "open-shortcuts": { label: "settings.shortcuts.def.openShortcuts" },
  graph: { label: "settings.shortcuts.def.graph" },
  briefing: { label: "settings.shortcuts.def.briefing" },
  tracker: { label: "settings.shortcuts.def.tracker" },
  base: { label: "settings.shortcuts.def.base" },
  analyst: { label: "settings.shortcuts.def.analyst", description: "settings.shortcuts.def.analystDescription" },
  propagation: { label: "settings.shortcuts.def.propagation" },
  risk: { label: "settings.shortcuts.def.risk" },
  screen: { label: "settings.shortcuts.def.screen" },
  gauge: { label: "settings.shortcuts.def.gauge" },
  quantlab: { label: "settings.shortcuts.def.quantlab" },
  diagnostics: { label: "settings.shortcuts.def.diagnostics" },
  "demo-mode": { label: "settings.shortcuts.def.demoMode", description: "settings.shortcuts.def.demoModeDescription" },
};

const GROUP_WORDS: Readonly<Record<ShortcutGroup, MessageKey>> = {
  Navigation: "settings.shortcuts.group.navigation",
  Panels: "settings.shortcuts.group.panels",
  Presentation: "settings.shortcuts.group.presentation",
  "In context": "settings.shortcuts.group.context",
};

const CONTEXT_WORDS: Readonly<Record<ContextualShortcutId, MessageKey>> = {
  close: "settings.shortcuts.ctx.close",
  "results-move": "settings.shortcuts.ctx.resultsMove",
  "results-open": "settings.shortcuts.ctx.resultsOpen",
  "table-copy": "settings.shortcuts.ctx.tableCopy",
  "table-edit": "settings.shortcuts.ctx.tableEdit",
  "table-extend": "settings.shortcuts.ctx.tableExtend",
  "agents-new": "settings.shortcuts.ctx.agentsNew",
  "calendar-today": "settings.shortcuts.ctx.calendarToday",
  "calendar-step": "settings.shortcuts.ctx.calendarStep",
  "calendar-views": "settings.shortcuts.ctx.calendarViews",
};

const RESERVED_WORDS: Readonly<Record<ReservedUse, MessageKey>> = {
  close: "settings.shortcuts.reserved.close",
  pick: "settings.shortcuts.reserved.pick",
  focus: "settings.shortcuts.reserved.focus",
  lists: "settings.shortcuts.reserved.lists",
  caret: "settings.shortcuts.reserved.caret",
  "select-text": "settings.shortcuts.reserved.selectText",
  copy: "settings.shortcuts.reserved.copy",
  paste: "settings.shortcuts.reserved.paste",
  cut: "settings.shortcuts.reserved.cut",
  "select-all": "settings.shortcuts.reserved.selectAll",
  undo: "settings.shortcuts.reserved.undo",
  redo: "settings.shortcuts.reserved.redo",
  reload: "settings.shortcuts.reserved.reload",
  devtools: "settings.shortcuts.reserved.devtools",
  "close-window": "settings.shortcuts.reserved.closeWindow",
  quit: "settings.shortcuts.reserved.quit",
  minimize: "settings.shortcuts.reserved.minimize",
  "zoom-reset": "settings.shortcuts.reserved.zoomReset",
  "zoom-in": "settings.shortcuts.reserved.zoomIn",
  "zoom-out": "settings.shortcuts.reserved.zoomOut",
  "full-screen": "settings.shortcuts.reserved.fullScreen",
};

export function shortcutLabel(id: ShortcutId, t: TFunction): string {
  return t(SHORTCUT_WORDS[id].label);
}

function shortcutDescription(id: ShortcutId, t: TFunction): string | undefined {
  const key = SHORTCUT_WORDS[id].description;
  return key ? t(key) : undefined;
}

/** A refusal in the reader's language. */
function problemText(problem: BindingProblem, t: TFunction): string {
  switch (problem.code) {
    case "unusable":
      return t("settings.shortcuts.error.unusable");
    case "bare-key":
      return t("settings.shortcuts.error.bareKey", { mod: problem.mod, keys: problem.shown });
    case "reserved":
      return t("settings.shortcuts.error.reserved", { keys: problem.shown, what: t(RESERVED_WORDS[problem.use]) });
    case "taken":
      return t("settings.shortcuts.error.taken", { keys: problem.shown, label: shortcutLabel(problem.by, t) });
  }
}

/** A list's joining word without its commas: keycaps already stand apart. */
function joiner(literal: string): string {
  return literal.replace(/^[\s,،、，]+|\s+$/g, "");
}

function refusal(result: BindingCheck, t: TFunction): string | null {
  return result.ok ? null : problemText(result.problem, t);
}

/** One key, drawn as a keycap. */
function Keycap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-black/[0.1] bg-white/70 px-1.5 font-sans text-[11.5px] font-medium text-[#1d1b1b] shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]">
      {children}
    </kbd>
  );
}

function Keycaps({ labels }: { labels: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {labels.map((label, i) => (
        <Keycap key={`${label}-${i}`}>{label}</Keycap>
      ))}
    </span>
  );
}

/** Whether a row survives the filter: its words, its group, or its keys as printed. */
function matches(query: string, parts: ReadonlyArray<string | undefined>): boolean {
  if (!query) return true;
  return parts.some((p) => p?.toLowerCase().includes(query));
}

/** The modifiers held so far while recording, so the reader sees the press forming. */
type Held = { mod: boolean; alt: boolean; shift: boolean };
const NOTHING_HELD: Held = { mod: false, alt: false, shift: false };

function heldLabels(held: Held): string[] {
  const mac = PLATFORM === "mac";
  const out: string[] = [];
  if (held.mod) out.push(mac ? "⌘" : "Ctrl");
  if (held.alt) out.push(mac ? "⌥" : "Alt");
  if (held.shift) out.push(mac ? "⇧" : "Shift");
  return out;
}

function ShortcutRow({
  def,
  keys,
  recording,
  held,
  error,
  onRecord,
  onCancel,
  onReset,
}: {
  def: ShortcutDef;
  keys: string;
  recording: boolean;
  held: Held;
  error: string | null;
  onRecord: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const t = useT();
  const isDefault = keys === defaultBindings()[def.id];
  const shown = formatKeys(keys, PLATFORM);
  const forming = heldLabels(held);
  const label = shortcutLabel(def.id, t);
  const description = shortcutDescription(def.id, t);
  const defaultShown = formatKeys(defaultBindings()[def.id], PLATFORM);

  // SettingsRow's shape, with room for the refusal under the label: the
  // reason a press was turned down replaces the description until the next
  // try, and is announced.
  return (
    <div className="flex items-center justify-between gap-6 border-b border-black/[0.06] py-4">
      <div className="min-w-0">
        <div className="text-[13.5px] font-normal text-[#1d1b1b]">{label}</div>
        {error ? (
          <p role="alert" className="mt-1 text-[12.5px] font-normal leading-snug text-[#dc2626]">
            {error}
          </p>
        ) : description ? (
          <p className="mt-1 text-[12.5px] font-normal leading-snug text-[#6b7280]">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!isDefault && !recording ? (
          <button
            type="button"
            onClick={onReset}
            aria-label={t("settings.shortcuts.resetOne", { label, keys: defaultShown })}
            title={t("settings.shortcuts.resetTo", { keys: defaultShown })}
            className="app-no-drag rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={recording ? onCancel : onRecord}
          onBlur={recording ? onCancel : undefined}
          aria-label={
            recording ? t("settings.shortcuts.recording", { label }) : t("settings.shortcuts.change", { label, keys: shown })
          }
          className={cn(
            "app-no-drag flex h-8 min-w-[92px] items-center justify-end rounded-lg px-1.5 transition-colors duration-150",
            recording
              ? "bg-white/80 ring-1 ring-black/[0.12]"
              : "hover:bg-black/[0.04]",
          )}
        >
          {recording ? (
            forming.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Keycaps labels={forming} />
                <span className="px-0.5 text-[12.5px] text-[#9CA3AF]">…</span>
              </span>
            ) : (
              <span className="px-1 text-[12.5px] font-normal text-[#6b7280]">{t("settings.shortcuts.pressKeys")}</span>
            )
          ) : (
            <Keycaps labels={comboLabels(keys, PLATFORM)} />
          )}
        </button>
      </div>
    </div>
  );
}

export default function ShortcutsPane() {
  const bindings = useBindings();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [held, setHeld] = useState<Held>(NOTHING_HELD);
  const [errors, setErrors] = useState<Partial<Record<ShortcutId, string>>>({});
  const { t, locale } = useI18n();

  const setError = (id: ShortcutId, reason: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (reason) next[id] = reason;
      else delete next[id];
      return next;
    });

  const stopRecording = () => {
    setRecording(null);
    setHeld(NOTHING_HELD);
  };

  // While a row is recording, every key goes to it and nowhere else: the
  // listener sits on the window's capture phase and stops the press there,
  // so Esc cancels the recording instead of closing Settings, and a press of
  // a panel's keys does not open the panel.
  useEffect(() => {
    if (!recording) return;
    const id = recording;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setError(id, null);
        stopRecording();
        return;
      }
      if (isModifierOnly(e)) {
        setHeld({ mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey });
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        setError(id, t("settings.shortcuts.error.unusable"));
        return;
      }
      const result = setBinding(id, comboToString(combo));
      if (result.ok) {
        setError(id, null);
        stopRecording();
      } else {
        setError(id, refusal(result, t));
        setHeld(NOTHING_HELD);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.stopPropagation();
      setHeld({ mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey });
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording, t]);

  const q = query.trim().toLowerCase();

  const groups = useMemo(
    () =>
      REBINDABLE_GROUPS.map((group) => ({
        group,
        // The filter reads the words shown and the English ones, so either finds a row.
        rows: SHORTCUTS.filter(
          (s) =>
            s.group === group &&
            matches(q, [
              shortcutLabel(s.id, t).toLowerCase(),
              shortcutDescription(s.id, t)?.toLowerCase(),
              t(GROUP_WORDS[group]).toLowerCase(),
              s.label,
              s.description,
              group,
              formatKeys(bindings[s.id], PLATFORM),
              bindings[s.id],
            ]),
        ),
      })).filter((g) => g.rows.length > 0),
    [q, bindings, t],
  );

  const contextual = useMemo(
    () =>
      CONTEXTUAL_SHORTCUTS.filter((c) =>
        matches(q, [
          t(CONTEXT_WORDS[c.id]).toLowerCase(),
          t(GROUP_WORDS[c.group]).toLowerCase(),
          c.label,
          c.group,
          c.display,
          ...c.keys.map((k) => formatKeys(k, PLATFORM)),
          ...c.keys,
        ]),
      ),
    [q, t],
  );

  const allDefault = SHORTCUTS.every((s) => bindings[s.id] === defaultBindings()[s.id]);
  const nothingShown = groups.length === 0 && contextual.length === 0;

  return (
    <>
      <SettingsSection title={t("settings.section.shortcuts")}>
        <p className="mt-1 text-[12.5px] font-normal leading-snug text-[#6b7280]">
          {t("settings.shortcuts.intro", { mod: PLATFORM === "mac" ? "⌘" : "Ctrl" })}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#9CA3AF]"
              strokeWidth={1.75}
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.shortcuts.filter")}
              aria-label={t("settings.shortcuts.filter")}
              className={FIELD}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              stopRecording();
              setErrors({});
              resetAllBindings();
            }}
            disabled={allDefault}
            className={cn(BUTTON, "shrink-0")}
          >
            {t("settings.shortcuts.resetAll")}
          </button>
        </div>
        {nothingShown ? (
          <div className="pt-6 text-[12.5px] font-normal text-[#9CA3AF]">{t("settings.shortcuts.empty")}</div>
        ) : null}
      </SettingsSection>

      {groups.map(({ group, rows }) => (
        <SettingsSection key={group} title={t(GROUP_WORDS[group])}>
          {rows.map((def) => (
            <ShortcutRow
              key={def.id}
              def={def}
              keys={bindings[def.id]}
              recording={recording === def.id}
              held={recording === def.id ? held : NOTHING_HELD}
              error={errors[def.id] ?? null}
              onRecord={() => {
                setHeld(NOTHING_HELD);
                setRecording(def.id);
              }}
              onCancel={() => {
                setError(def.id, null);
                stopRecording();
              }}
              onReset={() => {
                setError(def.id, refusal(resetBinding(def.id), t));
              }}
            />
          ))}
        </SettingsSection>
      ))}

      {contextual.length > 0 ? (
        <SettingsSection title={t(GROUP_WORDS["In context"])}>
          <p className="mt-1 text-[12.5px] font-normal leading-snug text-[#6b7280]">{t("settings.shortcuts.contextIntro")}</p>
          {contextual.map((c) => (
            <SettingsRow key={c.id} label={t(CONTEXT_WORDS[c.id])}>
              {c.display ? (
                <span className="text-[12.5px] font-normal text-[#6b7280]">{t("settings.shortcuts.ctx.shiftClick")}</span>
              ) : (
                // The joining word ("or", "oder", "または") and where it goes are the language's.
                <span className="inline-flex items-center gap-2">
                  {listParts(locale, c.keys.length, "disjunction").map((part, i) =>
                    "item" in part ? (
                      <Keycaps key={`k-${i}`} labels={comboLabels(c.keys[part.item]!, PLATFORM)} />
                    ) : joiner(part.literal) ? (
                      <span key={`l-${i}`} className="text-[12px] text-[#9CA3AF]">
                        {joiner(part.literal)}
                      </span>
                    ) : null,
                  )}
                </span>
              )}
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
