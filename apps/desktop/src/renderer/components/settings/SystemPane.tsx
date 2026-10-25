import { useCallback, useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUpdateStatus } from "@/hooks/useUpdateStatus";
import type {
  DataMoveProblem,
  QuickOpenError,
  SystemInfo,
  SystemStorage,
  UpdateCheckOutcome,
} from "../../../shared/system-settings";
import { checkGlobalShortcut, type GlobalShortcutProblem } from "../../../shared/quick-open-shortcut";
import {
  comboFromEvent,
  comboLabels,
  comboToString,
  detectPlatform,
  formatKeys,
  getBindings,
  isModifierOnly,
  type Platform,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useI18n, useT, type MessageKey, type TFunction } from "@/lib/i18n";
import { withClock } from "@/lib/clock";
import { Switch } from "./controls";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { shortcutLabel } from "./ShortcutsPane";
import { capabilityReason } from "./capability-reason";

/**
 * System: what this install is and what it does on this machine. The rows
 * people reach for first (version and updates, the quick open shortcut, the
 * tray, keeping the computer awake, where the data lives) come first;
 * hardware acceleration and the web cache sit under Advanced. Opening at
 * login lives in General, Startup, through the same main/system handlers.
 *
 * Everything is read from and written through the main process (main/system),
 * which asks the OS and Chromium directly, so a switch here always shows what
 * is really in force. Where a build cannot do a thing (a dev build has no
 * in-app restart) the row says so instead of offering a
 * control that would do nothing.
 */

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-60";

/** A quiet action beside a value: no chrome until hovered. */
const TEXT_BUTTON =
  "app-no-drag rounded-md px-1.5 py-1 text-[12.5px] font-normal text-content-secondary transition-colors hover:bg-black/[0.04] hover:text-content-primary disabled:pointer-events-none disabled:opacity-60";

const PLATFORM: Platform = detectPlatform();

/** The public release page an unsigned macOS build has to update from by hand. */
const RELEASES_PAGE = "https://github.com/KuzeyKovalak/Falcon-Releases/releases/latest";

function formatBytes(bytes: number | null, t: TFunction): string {
  if (bytes == null) return t("settings.system.sizeUnknown");
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function clock(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(locale, withClock({ hour: "numeric", minute: "2-digit" })) : "";
}

function Note({ tone = "muted", title, children }: { tone?: "muted" | "error"; title?: string; children: React.ReactNode }) {
  return (
    <span role="status" title={title} className={cn("text-[12px] font-normal", tone === "error" ? "text-tone-negative" : "text-content-tertiary")}>
      {children}
    </span>
  );
}

/** SettingsRow's shape, with a description that can turn red and carry more than a line. */
function Row({
  label,
  description,
  error,
  children,
  className,
}: {
  label: string;
  description?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6 border-b border-black/[0.06] py-4", className)}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-normal text-content-primary">{label}</div>
        {error ? (
          <p role="alert" className="mt-1 text-[12.5px] font-normal leading-snug text-tone-negative">
            {error}
          </p>
        ) : description ? (
          <div className="mt-1 text-[12.5px] font-normal leading-snug text-content-secondary">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Version, with the update check folded in
// ---------------------------------------------------------------------------

function UpdateStatusNote({ outcome, t, locale }: { outcome: UpdateCheckOutcome; t: TFunction; locale: string }) {
  if (outcome.kind === "current") {
    return <Note title={t("system.update.checkedAt", { time: clock(outcome.checkedAt, locale) })}>{t("system.update.current")}</Note>;
  }
  if (outcome.kind === "available") return <Note>{t("system.update.available", { version: outcome.version })}</Note>;
  return (
    <Note tone="error" title={outcome.error}>
      {t("system.update.failed")}
    </Note>
  );
}

function VersionRow({ info, onChecked }: { info: SystemInfo; onChecked: (outcome: UpdateCheckOutcome) => void }) {
  const status = useUpdateStatus();
  const { t, locale } = useI18n();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const lastCheck = info.updates.lastCheck;

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await window.meridian!.checkForUpdates();
      if (result.ok) onChecked(result.value);
      else setError(result.error);
    } catch {
      setError(t("settings.system.updates.failed"));
    } finally {
      setChecking(false);
    }
  };

  let update: React.ReactNode = null;
  if (status.kind === "ready") {
    update = (
      <button
        type="button"
        disabled={installing}
        onClick={() => {
          setInstalling(true);
          void window.meridian?.installUpdate().then((r) => {
            if (!r.ok) setInstalling(false);
          });
        }}
        className={BUTTON}
      >
        {installing ? t("settings.system.restarting") : t("settings.system.updates.restart")}
      </button>
    );
  } else if (status.kind === "unsigned") {
    update = (
      <>
        <Note>{t("system.update.unsigned", { version: status.version })}</Note>
        <button type="button" onClick={() => void window.meridian?.openExternal(RELEASES_PAGE)} className={BUTTON}>
          {t("system.update.download")}
        </button>
      </>
    );
  } else if (!info.packaged) {
    update = <Note>{t("settings.system.devBuild")}</Note>;
  } else if (!info.updates.supported) {
    update = <Note>{capabilityReason(info.updates, t)}</Note>;
  } else {
    update = (
      <>
        {checking ? (
          <Note>{t("settings.pane.checking")}</Note>
        ) : error ? (
          <Note tone="error" title={error}>
            {t("system.update.failed")}
          </Note>
        ) : lastCheck ? (
          <UpdateStatusNote outcome={lastCheck} t={t} locale={locale} />
        ) : null}
        <button type="button" disabled={checking} onClick={() => void check()} className={TEXT_BUTTON}>
          {t("settings.system.updates.check")}
        </button>
      </>
    );
  }

  return (
    <Row label={t("settings.system.version")}>
      {update}
      <span data-selectable className="select-text font-['Geist_Mono'] text-[12.5px] text-content-body">
        {info.version}
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Quick open shortcut
// ---------------------------------------------------------------------------

type Held = { mod: boolean; alt: boolean; shift: boolean };
const NOTHING_HELD: Held = { mod: false, alt: false, shift: false };

const MOD_NAME = PLATFORM === "mac" ? "⌘" : "Ctrl";
const ALT_NAME = PLATFORM === "mac" ? "⌥" : "Alt";

function heldLabels(held: Held): string[] {
  const out: string[] = [];
  if (held.mod) out.push(MOD_NAME);
  if (held.alt) out.push(ALT_NAME);
  if (held.shift) out.push(PLATFORM === "mac" ? "⇧" : "Shift");
  return out;
}

function Keycaps({ labels }: { labels: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {labels.map((label, i) => (
        <kbd
          key={`${label}-${i}`}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-black/[0.1] bg-white/70 px-1.5 font-sans text-[11.5px] font-medium text-content-primary shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]"
        >
          {label}
        </kbd>
      ))}
    </span>
  );
}

function globalProblemText(problem: GlobalShortcutProblem, shown: string, t: TFunction): string {
  if (problem === "needs-modifier") {
    return t("system.quickOpen.error.needsModifier", { mod: MOD_NAME, alt: ALT_NAME, keys: shown });
  }
  if (problem === "reserved") return t("system.quickOpen.error.reserved", { keys: shown });
  return t("system.quickOpen.error.unusable");
}

function osProblemText(problem: QuickOpenError | undefined, shown: string, t: TFunction): string {
  if (problem === "taken") return t("system.quickOpen.error.taken", { keys: shown });
  if (problem === "invalid") return t("system.quickOpen.error.invalid", { keys: shown });
  return t("system.quickOpen.error.failed");
}

/**
 * Click, press the keys (Esc gives up), and main registers them with the OS
 * before saving. Refused first here when a press would break typing in other
 * apps, is one every app uses, or already does something inside Falcon; then
 * by main when another app holds it, in which case the old one stays.
 */
function QuickOpenRow({ info, onInfo }: { info: SystemInfo; onInfo: (info: SystemInfo) => void }) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<Held>(NOTHING_HELD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = info.quickOpen.keys;
  const shown = keys ? formatKeys(keys, PLATFORM) : "";

  const stop = () => {
    setRecording(false);
    setHeld(NOTHING_HELD);
  };

  const save = useCallback(
    async (next: string | null) => {
      setBusy(true);
      try {
        const result = await window.meridian!.setQuickOpenShortcut(next);
        if (result.ok) {
          onInfo(result.value);
          setError(null);
          stop();
        } else {
          setError(osProblemText(result.problem, next ? formatKeys(next, PLATFORM) : "", t));
          setHeld(NOTHING_HELD);
        }
      } catch {
        setError(t("system.quickOpen.error.failed"));
      } finally {
        setBusy(false);
      }
    },
    [onInfo, t],
  );

  // While recording, every key goes here and nowhere else: the listener sits
  // on the window's capture phase, so Esc cancels instead of closing
  // Settings, and a panel's keys do not open the panel.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setError(null);
        stop();
        return;
      }
      if (isModifierOnly(e)) {
        setHeld({ mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey });
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        setError(t("system.quickOpen.error.unusable"));
        return;
      }
      const pressed = comboToString(combo);
      const check = checkGlobalShortcut(pressed);
      if (!check.ok) {
        setError(globalProblemText(check.problem, formatKeys(pressed, PLATFORM), t));
        setHeld(NOTHING_HELD);
        return;
      }
      // A global shortcut wins over the app's own keys even inside Falcon.
      const bindings = getBindings();
      const clash = (Object.keys(bindings) as ShortcutId[]).find((id) => bindings[id] === check.keys);
      if (clash) {
        setError(t("system.quickOpen.error.inApp", { keys: formatKeys(check.keys, PLATFORM), label: shortcutLabel(clash, t) }));
        setHeld(NOTHING_HELD);
        return;
      }
      if (check.keys === keys && info.quickOpen.registered) {
        setError(null);
        stop();
        return;
      }
      void save(check.keys);
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
  }, [recording, busy, keys, info.quickOpen.registered, save, t]);

  // Saved, but the OS gave it to another app at startup: say why it does nothing.
  const startupError =
    keys && info.quickOpen.error
      ? info.quickOpen.error === "taken"
        ? t("system.quickOpen.notRegistered", { keys: shown })
        : t("system.quickOpen.error.invalid", { keys: shown })
      : null;
  const forming = heldLabels(held);
  const label = t("system.quickOpen.label");

  return (
    <Row label={label} description={t("system.quickOpen.description")} error={error ?? startupError}>
      {recording || keys ? (
        <button
          type="button"
          onClick={() => {
            if (recording) {
              setError(null);
              stop();
            } else {
              setHeld(NOTHING_HELD);
              setRecording(true);
            }
          }}
          onBlur={recording ? () => stop() : undefined}
          aria-label={recording ? t("system.quickOpen.recording") : t("system.quickOpen.change", { keys: shown })}
          className={cn(
            "app-no-drag flex h-8 min-w-[92px] items-center justify-end rounded-lg px-1.5 transition-colors duration-150",
            recording ? "bg-white/80 ring-1 ring-black/[0.12]" : "hover:bg-black/[0.04]",
          )}
        >
          {recording ? (
            forming.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Keycaps labels={forming} />
                <span className="px-0.5 text-[12.5px] text-content-tertiary">…</span>
              </span>
            ) : (
              <span className="px-1 text-[12.5px] font-normal text-content-secondary">{t("system.quickOpen.pressKeys")}</span>
            )
          ) : (
            <Keycaps labels={comboLabels(keys!, PLATFORM)} />
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setHeld(NOTHING_HELD);
            setRecording(true);
          }}
          className={BUTTON}
        >
          {t("system.quickOpen.set")}
        </button>
      )}
      {keys && !recording ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(null)}
          aria-label={t("system.quickOpen.clearLabel")}
          title={t("system.quickOpen.clearLabel")}
          className="app-no-drag -ml-2 rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-black/[0.04] hover:text-content-primary disabled:pointer-events-none disabled:opacity-60"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Storage folder
// ---------------------------------------------------------------------------

const MOVE_PROBLEMS: Readonly<Record<DataMoveProblem, MessageKey>> = {
  "same-folder": "system.folder.error.sameFolder",
  "inside-current": "system.folder.error.insideCurrent",
  "not-empty": "system.folder.error.notEmpty",
  "not-writable": "system.folder.error.notWritable",
  "copy-failed": "system.folder.error.copyFailed",
  "verify-failed": "system.folder.error.verifyFailed",
  unavailable: "system.folder.error.unavailable",
};

function PathLink({ path, onOpen }: { path: string; onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("system.folder.open", { path })}
      className="app-no-drag inline max-w-full break-all text-left font-['Geist_Mono'] text-[11.5px] text-content-body underline decoration-black/[0.2] underline-offset-2 transition-colors hover:text-content-primary hover:decoration-black/[0.5]"
    >
      {path}
    </button>
  );
}

function FolderRow({
  info,
  storage,
  onInfo,
}: {
  info: SystemInfo;
  storage: SystemStorage | null;
  onInfo: (info: SystemInfo) => void;
}) {
  const { t, tNodes } = useI18n();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folder = info.dataFolder;

  const open = async () => {
    try {
      const result = await window.meridian!.showDataFolder();
      if (!result.ok) setError(result.error);
    } catch {
      setError(t("settings.pane.openFolderFailed"));
    }
  };

  const change = async () => {
    setMoving(true);
    setError(null);
    try {
      const result = await window.meridian!.changeDataFolder();
      if (result.ok) {
        if (result.moved) onInfo(result.info);
      } else {
        setError(t(MOVE_PROBLEMS[result.problem] ?? "system.folder.error.copyFailed"));
      }
    } catch {
      setError(t("system.folder.error.copyFailed"));
    } finally {
      setMoving(false);
    }
  };

  const envReason = capabilityReason(folder.change, t);

  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <div className="text-[13.5px] font-normal text-content-primary">{t("system.folder.label")}</div>
        <p data-selectable className="mt-1 select-text text-[12.5px] font-normal leading-snug text-content-secondary">
          {tNodes("system.folder.storedAt", { path: <PathLink path={folder.path} onOpen={() => void open()} /> })}
        </p>
        {folder.missing ? (
          <p className="mt-1 text-[12.5px] font-normal leading-snug text-tone-warning">
            {t("system.folder.missing", { path: folder.missing })}
          </p>
        ) : null}
        {envReason ? <p className="mt-1 text-[12.5px] font-normal leading-snug text-content-tertiary">{envReason}</p> : null}
        {folder.pending ? (
          <div className="mt-2 rounded-lg border border-black/[0.06] bg-white/40 px-3 py-2.5 text-[12.5px] font-normal leading-snug text-content-body">
            <p data-selectable className="select-text">
              {t("system.folder.moved", { path: folder.pending })}
            </p>
            <p className="mt-1 text-content-secondary">{t("system.folder.previous")}</p>
            <div className="mt-2">
              {info.restart.supported ? (
                <RestartButton info={info} label={t("settings.system.restart.now")} />
              ) : (
                <span className="text-content-tertiary">{t("system.folder.restartManually")}</span>
              )}
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-[12.5px] font-normal leading-snug text-tone-negative">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {storage ? (
          <span className="font-['Geist_Mono'] text-[12.5px] tabular-nums text-content-body">
            {formatBytes(storage.dataBytes, t)}
          </span>
        ) : null}
        <button
          type="button"
          disabled={moving || !folder.change.supported}
          title={envReason}
          onClick={() => void change()}
          className={cn(BUTTON, "inline-flex items-center gap-1.5")}
        >
          <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          {moving ? t("system.folder.copying") : t("system.folder.change")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Restart, offered inline where a change only applies to a fresh launch. */
function RestartButton({ info, label }: { info: SystemInfo; label?: string }) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "working" | "error">("idle");
  if (!info.restart.supported) return null;
  return (
    <div className="flex items-center gap-3">
      {phase === "error" ? <Note tone="error">{t("settings.system.restart.failed")}</Note> : null}
      <button
        type="button"
        disabled={phase === "working"}
        onClick={() => {
          setPhase("working");
          void window.meridian
            ?.restartApp()
            .then((r) => setPhase(r.ok ? "working" : "error"))
            .catch(() => setPhase("error"));
        }}
        className={BUTTON}
      >
        {phase === "working" ? t("settings.system.restarting") : (label ?? t("settings.system.restart.now"))}
      </button>
    </div>
  );
}

/**
 * Two presses, so a stray click cannot empty the cache: the first turns the
 * button into a confirmation, which goes back by itself after a few seconds.
 */
function ClearCache({ onCleared }: { onCleared: (storage: SystemStorage) => void }) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "done" | "error">("idle");
  useEffect(() => {
    if (phase !== "confirm" && phase !== "done" && phase !== "error") return;
    const timer = setTimeout(() => setPhase("idle"), phase === "confirm" ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "idle" || phase === "done" || phase === "error") {
    return (
      <div className="flex items-center gap-3">
        {phase === "done" ? <Note>{t("settings.system.cache.cleared")}</Note> : null}
        {phase === "error" ? <Note tone="error">{t("settings.system.cache.failed")}</Note> : null}
        <button type="button" onClick={() => setPhase("confirm")} className={BUTTON}>
          {t("settings.system.cache.clear")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => setPhase("idle")} disabled={phase === "working"} className={BUTTON}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        disabled={phase === "working"}
        onClick={() => {
          setPhase("working");
          window
            .meridian!.clearSystemCache()
            .then((r) => {
              if (r.ok) {
                onCleared(r.value);
                setPhase("done");
              } else {
                setPhase("error");
              }
            })
            .catch(() => setPhase("error"));
        }}
        className="app-no-drag rounded-lg bg-tone-negative-solid px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-tone-negative-solid/90 disabled:opacity-60"
      >
        {phase === "working" ? t("settings.pane.clearing") : t("settings.system.cache.clear")}
      </button>
    </div>
  );
}

type SwitchRow = "tray" | "awake" | "gpu";

export default function SystemPane() {
  const bridge = typeof window !== "undefined" ? window.meridian : undefined;
  const available = Boolean(bridge?.getSystemInfo);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [storage, setStorage] = useState<SystemStorage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ row: SwitchRow; text: string } | null>(null);
  const [busy, setBusy] = useState<SwitchRow | null>(null);
  const t = useT();
  const loadFailed = t("settings.system.loadFailed");

  const load = useCallback(async () => {
    if (!window.meridian?.getSystemInfo) return;
    try {
      const result = await window.meridian.getSystemInfo();
      if (result.ok) setInfo(result.value);
      else setLoadError(result.error);
    } catch {
      setLoadError(loadFailed);
    }
    try {
      const sizes = await window.meridian.getSystemStorage();
      if (sizes.ok) setStorage(sizes.value);
    } catch {
      /* sizes are a nicety; the rows still work without them */
    }
  }, [loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!rowError) return;
    const timer = setTimeout(() => setRowError(null), 4000);
    return () => clearTimeout(timer);
  }, [rowError]);

  if (!available) {
    return (
      <SettingsSection title={t("settings.section.system")}>
        <p className="py-4 text-[12.5px] font-normal text-content-secondary">{t("settings.pane.desktopOnly")}</p>
      </SettingsSection>
    );
  }
  if (!info) {
    return (
      <SettingsSection title={t("settings.section.system")}>
        <p className="py-4 text-[12.5px] font-normal text-content-secondary">{loadError ?? t("settings.pane.loading")}</p>
      </SettingsSection>
    );
  }

  /** One switch's round trip: main applies it, and the pane shows what main reports back. */
  const toggle = async (row: SwitchRow, write: () => Promise<{ ok: true; value: SystemInfo } | { ok: false; error: string }>) => {
    setBusy(row);
    try {
      const result = await write();
      if (result.ok) setInfo(result.value);
      else setRowError({ row, text: result.error });
    } catch {
      setRowError({ row, text: t("settings.account.saveFailed") });
    } finally {
      setBusy(null);
    }
  };

  const errorFor = (row: SwitchRow) => (rowError?.row === row ? <Note tone="error">{rowError.text}</Note> : null);
  const gpuPending = info.hardwareAcceleration.saved !== info.hardwareAcceleration.active;
  const mac = info.platform === "darwin";
  const trayLabel = t(mac ? "system.tray.labelMac" : "system.tray.label");

  return (
    <>
      <SettingsSection title={t("settings.section.system")}>
        <VersionRow
          info={info}
          onChecked={(outcome) => setInfo((cur) => (cur ? { ...cur, updates: { ...cur.updates, lastCheck: outcome } } : cur))}
        />

        <QuickOpenRow info={info} onInfo={setInfo} />

        <SettingsRow
          label={trayLabel}
          description={
            capabilityReason(info.tray, t) ?? t(mac ? "system.tray.descriptionMac" : "system.tray.description")
          }
        >
          <div className="flex items-center gap-3">
            {errorFor("tray")}
            <Switch
              label={trayLabel}
              checked={info.tray.enabled}
              disabled={!info.tray.supported || busy === "tray"}
              onChange={(next) => void toggle("tray", () => window.meridian!.setTrayEnabled(next))}
            />
          </div>
        </SettingsRow>

        <SettingsRow label={t("system.awake.label")} description={t("system.awake.description")}>
          <div className="flex items-center gap-3">
            {errorFor("awake")}
            <Switch
              label={t("system.awake.label")}
              checked={info.keepAwake.enabled}
              disabled={busy === "awake"}
              onChange={(next) => void toggle("awake", () => window.meridian!.setKeepAwake(next))}
            />
          </div>
        </SettingsRow>

        <FolderRow info={info} storage={storage} onInfo={setInfo} />
      </SettingsSection>

      <SettingsSection title={t("system.advanced")}>
        <SettingsRow
          label={t("settings.system.gpu.label")}
          description={
            gpuPending
              ? t(info.hardwareAcceleration.saved ? "settings.system.gpu.pendingOn" : "settings.system.gpu.pendingOff")
              : t("settings.system.gpu.description")
          }
        >
          <div className="flex items-center gap-3">
            {errorFor("gpu")}
            {gpuPending ? <RestartButton info={info} label={t("settings.system.restart.now")} /> : null}
            <Switch
              label={t("settings.system.gpu.label")}
              checked={info.hardwareAcceleration.saved}
              disabled={busy === "gpu"}
              onChange={(next) => void toggle("gpu", () => window.meridian!.setHardwareAcceleration(next))}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          label={t("settings.system.cache.label")}
          description={
            storage
              ? t("settings.system.cache.descriptionSized", { size: formatBytes(storage.cacheBytes, t) })
              : t("settings.system.cache.description")
          }
          className="border-b-0"
        >
          <ClearCache onCleared={setStorage} />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
