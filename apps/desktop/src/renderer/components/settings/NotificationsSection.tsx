import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  SWITCHABLE_NOTIFICATION_CATEGORIES,
  applyNotificationPatch,
  isClockTime,
  type NotificationCategory,
  type NotificationSettingsPatch,
  type NotificationsState,
  type TestNotificationResult,
} from "../../../shared/notification-settings";
import { useI18n, useT, type MessageKey } from "@/lib/i18n";
import { Switch } from "./controls";
import { SettingsRow, SettingsSection } from "./SettingsRow";

/**
 * Notifications, the last section of the General pane: which desktop
 * notifications Falcon sends, and when not to. It had a pane of its own; it is
 * one section now, so its rows run on without sub-headings, and a row carries
 * a line under its label only when that line says why it is off or what
 * follows from it.
 *
 * The settings live in the main process (main/notifications), because that is
 * what fires a notification; every source goes through one gate there that
 * reads them, so a switch here is the switch in force. Each category also
 * reports whether it can fire on this install at all: one that cannot (the
 * engine does not send market events to the app yet, a dev build has no
 * updater) says so instead of offering a switch that would do nothing.
 */

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-60";

const FIELD =
  "app-no-drag h-9 rounded-xl border border-white/60 bg-white/55 px-3 font-['Geist_Mono'] text-[12.5px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors focus:bg-white/75 disabled:opacity-50";

/**
 * One row per category, in the shared list's order; a new category fails to
 * compile until it has its name here. A category's note, when it cannot
 * fire, comes from main already in the reader's language (main/i18n).
 */
const CATEGORY_LABEL: Record<NotificationCategory, MessageKey> = {
  secondOrderSignals: "settings.notifications.cat.secondOrder",
  marketEvents: "settings.notifications.cat.marketEvents",
  appUpdates: "settings.notifications.cat.appUpdates",
  agents: "settings.notifications.cat.agents",
};

function Note({ tone = "muted", children }: { tone?: "muted" | "error"; children: React.ReactNode }) {
  return (
    <span role="status" className={cn("text-[12px] font-normal", tone === "error" ? "text-[#DC2626]" : "text-[#9CA3AF]")}>
      {children}
    </span>
  );
}

function Unavailable() {
  const t = useT();
  return <span className="text-[12.5px] font-normal text-[#9CA3AF]">{t("settings.notifications.unavailable")}</span>;
}

/** A time of day; saved as soon as it is a whole time, reverted if left half-typed. */
function TimeField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="time"
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        if (isClockTime(e.target.value) && e.target.value !== value) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (!isClockTime(draft)) setDraft(value);
      }}
      className={cn(FIELD, "w-[112px]")}
    />
  );
}

function TestRow({ disabled, canOpenSettings }: { disabled: boolean; canOpenSettings: boolean }) {
  const [phase, setPhase] = useState<"idle" | "sending">("idle");
  const [result, setResult] = useState<TestNotificationResult | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 8000);
    return () => clearTimeout(timer);
  }, [result]);

  const send = async () => {
    setPhase("sending");
    setResult(null);
    try {
      setResult(await window.meridian!.sendTestNotification());
    } catch {
      setResult({ ok: false, error: t("settings.notifications.test.failed") });
    } finally {
      setPhase("idle");
    }
  };

  const openSettings = async () => {
    setOpenError(null);
    try {
      const r = await window.meridian!.openSystemNotificationSettings();
      if (!r.ok) setOpenError(r.error);
    } catch {
      setOpenError(t("settings.notifications.system.failed"));
    }
  };

  let status: React.ReactNode = null;
  if (result?.ok && result.shown) status = <Note>{t("settings.notifications.test.sent")}</Note>;
  else if (result?.ok) status = <Note>{t("settings.notifications.test.unconfirmed")}</Note>;
  else if (result) status = <Note tone="error">{result.error}</Note>;

  return (
    <>
      <SettingsRow
        label={t("settings.notifications.test.label")}
        description={t("settings.notifications.test.description")}
        className={canOpenSettings ? undefined : "border-b-0"}
      >
        <div className="flex items-center gap-3">
          {status}
          <button type="button" disabled={disabled || phase === "sending"} onClick={() => void send()} className={BUTTON}>
            {phase === "sending" ? t("settings.notifications.test.sending") : t("settings.notifications.test.send")}
          </button>
        </div>
      </SettingsRow>
      {canOpenSettings ? (
        <SettingsRow
          label={t("settings.notifications.system.label")}
          description={t("settings.notifications.system.description")}
          className="border-b-0"
        >
          <div className="flex items-center gap-3">
            {openError ? <Note tone="error">{openError}</Note> : null}
            <button type="button" onClick={() => void openSettings()} className={BUTTON}>
              {t("settings.pane.open")}
            </button>
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}

export function NotificationsSection({
  onSettled,
}: {
  /** Called once, after the first render that shows the rows (or why there are none). */
  onSettled?: () => void;
} = {}) {
  const available = typeof window !== "undefined" && Boolean(window.meridian?.getNotificationsState);
  const [state, setState] = useState<NotificationsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Writes are chained, so two quick switches land in the order they were flipped.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const { t, tNodes } = useI18n();
  const loadFailed = t("settings.notifications.loadFailed");

  useEffect(() => {
    if (!window.meridian?.getNotificationsState) return;
    let cancelled = false;
    window.meridian
      .getNotificationsState()
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setState(r.state);
        else setLoadError(r.error);
      })
      .catch(() => {
        if (!cancelled) setLoadError(loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [loadFailed]);

  // The section is short while it loads; whoever scrolls to it waits for this.
  const settled = !available || state !== null || loadError !== null;
  const settledOnce = useRef(false);
  useEffect(() => {
    if (!settled || settledOnce.current) return;
    settledOnce.current = true;
    onSettled?.();
  }, [settled, onSettled]);

  useEffect(() => {
    if (!saveError) return;
    const timer = setTimeout(() => setSaveError(null), 4000);
    return () => clearTimeout(timer);
  }, [saveError]);

  if (!available) {
    return (
      <SettingsSection title={t("settings.section.notifications")}>
        <p className="py-4 text-[12.5px] font-normal text-[#6b7280]">{t("settings.pane.desktopOnly")}</p>
      </SettingsSection>
    );
  }
  if (!state) {
    return (
      <SettingsSection title={t("settings.section.notifications")}>
        <p className="py-4 text-[12.5px] font-normal text-[#6b7280]">{loadError ?? t("settings.pane.loading")}</p>
      </SettingsSection>
    );
  }

  /** Shows the change at once, writes it, and goes back to what main holds if the write fails. */
  const update = (patch: NotificationSettingsPatch) => {
    const before = state;
    setState({ ...state, settings: applyNotificationPatch(state.settings, patch) });
    queue.current = queue.current.then(async () => {
      try {
        const r = await window.meridian!.updateNotificationSettings(patch);
        if (r.ok) {
          setState(r.state);
        } else {
          setState(before);
          setSaveError(r.error);
        }
      } catch {
        setState(before);
        setSaveError(t("settings.account.saveFailed"));
      }
    });
  };

  const { settings, supported, sources } = state;
  const off = !supported || !settings.enabled;
  const quiet = settings.quietHours;

  return (
    <SettingsSection title={t("settings.section.notifications")}>
      {!supported ? (
        <p className="border-b border-black/[0.06] py-4 text-[12.5px] font-normal text-[#DC2626]">
          {t("settings.notifications.unsupported")}
        </p>
      ) : null}
      <SettingsRow label={t("settings.notifications.allow")}>
        <div className="flex items-center gap-3">
          {saveError ? <Note tone="error">{saveError}</Note> : null}
          <Switch
            label={t("settings.notifications.allow")}
            checked={settings.enabled}
            disabled={!supported}
            onChange={(next) => update({ enabled: next })}
          />
        </div>
      </SettingsRow>
      <SettingsRow label={t("settings.notifications.sound")}>
        <Switch
          label={t("settings.notifications.sound")}
          checked={settings.sound}
          disabled={off}
          onChange={(next) => update({ sound: next })}
        />
      </SettingsRow>
      {SWITCHABLE_NOTIFICATION_CATEGORIES.map((key) => {
        const label = t(CATEGORY_LABEL[key]);
        const source = sources[key] ?? { available: false, note: null };
        return (
          <SettingsRow key={key} label={label} description={source.available ? undefined : source.note ?? undefined}>
            {source.available ? (
              <Switch
                label={label}
                checked={settings.categories[key]}
                disabled={off}
                onChange={(next) => update({ categories: { [key]: next } })}
              />
            ) : (
              <Unavailable />
            )}
          </SettingsRow>
        );
      })}
      {/* The hours sit beside their own switch. The line under the label shows
          only while quiet hours are on: the time zone they are read in, or that
          equal ends make no hour quiet. */}
      <SettingsRow
        label={t("settings.notifications.quiet")}
        description={
          !quiet.enabled
            ? undefined
            : quiet.start === quiet.end
              ? t("settings.notifications.hoursSame")
              : t("settings.notifications.hoursZone")
        }
      >
        <div className="flex items-center gap-4">
          {/* The joining word and its place are the language's: "22:00 to 07:00", "22:00 から 07:00 まで". */}
          <div className="flex items-center gap-2 text-[12.5px] text-[#9CA3AF]">
            {tNodes("settings.notifications.range", {
              start: (
                <TimeField
                  label={t("settings.notifications.quietStart")}
                  value={quiet.start}
                  disabled={off || !quiet.enabled}
                  onCommit={(start) => update({ quietHours: { start } })}
                />
              ),
              end: (
                <TimeField
                  label={t("settings.notifications.quietEnd")}
                  value={quiet.end}
                  disabled={off || !quiet.enabled}
                  onCommit={(end) => update({ quietHours: { end } })}
                />
              ),
            })}
          </div>
          <Switch
            label={t("settings.notifications.quiet")}
            checked={quiet.enabled}
            disabled={off}
            onChange={(next) => update({ quietHours: { enabled: next } })}
          />
        </div>
      </SettingsRow>
      <TestRow disabled={!supported} canOpenSettings={state.canOpenSystemSettings} />
    </SettingsSection>
  );
}
