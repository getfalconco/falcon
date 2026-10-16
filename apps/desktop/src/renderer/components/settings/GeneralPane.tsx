import { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import LanguageRow from "./LanguageRow";
import { RegionRow, TimeZoneRow } from "./RegionZoneRows";
import { NotificationsSection } from "./NotificationsSection";
import { useT, type MessageKey, type TFunction } from "@/lib/i18n";
import { Segmented, Switch, type SegmentOption } from "./controls";
import { briefingEnabled } from "@/lib/dashboard-config";
import { readBriefingAutoOpenPref, writeBriefingAutoOpenPref } from "@/lib/general-prefs";
import { readClockChoice, writeClockChoice, type ClockChoice } from "@/lib/clock";
import { readThemeChoice, writeThemeChoice, type ThemeChoice } from "@/lib/theme";
import { readMotionChoice, writeMotionChoice, type MotionChoice } from "@/lib/motion";
import { canScaleUi, readUiScale, writeUiScale, type UiScale } from "@/lib/ui-scale";
import type { SystemInfo } from "../../../shared/system-settings";
import { capabilityReason } from "./capability-reason";

/**
 * General: how the app looks and behaves, in four sections, the way a reader
 * meets them. Everything here is applied the moment it is picked.
 *
 *  - Appearance, kept on this machine:
 *     Theme (lib/theme): `data-theme` on <html>, which globals.css keys the
 *     dark palette on. Interface size (lib/ui-scale): Chromium's page zoom
 *     through the preload, so every pixel scales together. Motion
 *     (lib/motion): `data-motion` on <html> for CSS, and framer-motion's
 *     global skip switch for everything it animates.
 *  - Language and region: the app's language (LanguageRow), the region whose
 *     releases the calendar adds and the time zone it places every time in
 *     (RegionZoneRows: lib/region, lib/time-zone), and the clock every time
 *     of day is printed in (lib/clock withClock/clockLabel).
 *  - Startup: the OS login item (OpenAtLoginRow, through main/system: read
 *    from the OS when the pane opens, applied at once; installed app only)
 *    and `briefingAutoOpen()` in lib/dashboard-config, the gate every
 *    automatic showing of the handover briefing passes. The app always opens
 *    on the Dashboard.
 *  - Notifications (NotificationsSection), held by the main process.
 *
 * A font choice and a content width were considered and left out: type is
 * set in literal families across the components rather than one token, and
 * the dashboard's cards lay themselves out to the window, so neither setting
 * would reach the whole app.
 *
 * Rows carry a line under the label only when it says why a control is off
 * or what follows from it.
 */

/** Sections the rail can open this pane on, scrolled to. */
export type GeneralAnchor = "appearance" | "notifications";

/** The options' words, by i18n key; turned into labels in the reader's language at render. */
type KeyedOption<T extends string | number> = { value: T; labelKey: MessageKey; icon?: LucideIcon };

const THEMES: ReadonlyArray<KeyedOption<ThemeChoice>> = [
  { value: "system", labelKey: "settings.appearance.themeSystem", icon: Monitor },
  { value: "light", labelKey: "settings.appearance.themeLight", icon: Sun },
  { value: "dark", labelKey: "settings.appearance.themeDark", icon: Moon },
];

/** Every step lib/ui-scale offers, named rather than shown as a percentage. */
const SCALES: ReadonlyArray<KeyedOption<UiScale>> = [
  { value: 0.9, labelKey: "shell.settings.sizeSmall" },
  { value: 1, labelKey: "shell.settings.sizeMedium" },
  { value: 1.1, labelKey: "shell.settings.sizeLarge" },
  { value: 1.25, labelKey: "shell.settings.sizeExtraLarge" },
];

const MOTIONS: ReadonlyArray<KeyedOption<MotionChoice>> = [
  { value: "system", labelKey: "settings.appearance.motionSystem" },
  { value: "reduce", labelKey: "settings.appearance.motionReduce" },
  { value: "full", labelKey: "settings.appearance.motionFull" },
];

const CLOCKS: ReadonlyArray<KeyedOption<ClockChoice>> = [
  { value: "auto", labelKey: "settings.general.clockAuto" },
  { value: "12", labelKey: "settings.general.clock12" },
  { value: "24", labelKey: "settings.general.clock24" },
];

function labelled<T extends string | number>(options: ReadonlyArray<KeyedOption<T>>, t: TFunction): SegmentOption<T>[] {
  return options.map(({ value, labelKey, icon }) => ({ value, label: t(labelKey), icon }));
}

/**
 * "Open when the computer starts": the OS login item, as main/system reads it
 * from the OS, so the switch shows what is really in force. Flipped, main
 * applies it and the row shows what main reports back. A dev build or a
 * system without login items gets the switch off and the reason under it.
 */
function OpenAtLoginRow({ t }: { t: TFunction }) {
  const bridged = typeof window !== "undefined" && Boolean(window.meridian?.getSystemInfo);
  const [login, setLogin] = useState<SystemInfo["openAtLogin"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.meridian?.getSystemInfo) return;
    let live = true;
    window.meridian
      .getSystemInfo()
      .then((r) => {
        if (!live) return;
        if (r.ok) setLogin(r.value.openAtLogin);
        else setError(r.error);
      })
      .catch(() => {
        if (live) setError(t("settings.system.loadFailed"));
      });
    return () => {
      live = false;
    };
  }, [t]);

  useEffect(() => {
    if (!error || !login) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error, login]);

  const label = t("shell.settings.openAtLogin");
  const description = !bridged
    ? t("settings.pane.desktopOnly")
    : login
      ? capabilityReason(login, t)
      : undefined;

  return (
    <SettingsRow label={label} description={description}>
      <div className="flex items-center gap-3">
        {error ? (
          <span role="status" className="text-[12px] font-normal text-[#DC2626]">
            {error}
          </span>
        ) : null}
        <Switch
          label={label}
          checked={Boolean(login?.supported && login.enabled)}
          disabled={!login?.supported || busy}
          onChange={(next) => {
            setBusy(true);
            setError(null);
            window
              .meridian!.setOpenAtLogin(next)
              .then((r) => {
                if (r.ok) setLogin(r.value.openAtLogin);
                else setError(r.error);
              })
              .catch(() => setError(t("settings.account.saveFailed")))
              .finally(() => setBusy(false));
          }}
        />
      </div>
    </SettingsRow>
  );
}

export default function GeneralPane({ anchor }: { anchor?: GeneralAnchor }) {
  const [theme, setTheme] = useState<ThemeChoice>(readThemeChoice);
  const [scale, setScale] = useState<UiScale>(readUiScale);
  const [motion, setMotion] = useState<MotionChoice>(readMotionChoice);
  const [briefing, setBriefing] = useState<boolean>(readBriefingAutoOpenPref);
  const [clock, setClock] = useState<ClockChoice>(readClockChoice);
  const scalable = canScaleUi();
  const hasBriefing = briefingEnabled();
  const t = useT();

  // Opened on a section that used to be a pane of its own: bring it into view.
  // The margin keeps its title clear of the drag strip over the pane's top.
  // Notifications load from main, and until they do the pane may be too short
  // to scroll that far, so the scroll is taken again once they have arrived.
  const appearanceRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const notificationsSettled = useRef(false);
  const scrollPending = useRef(false);
  useEffect(() => {
    const target = anchor === "appearance" ? appearanceRef : anchor === "notifications" ? notificationsRef : null;
    target?.current?.scrollIntoView({ block: "start" });
    scrollPending.current = anchor === "notifications" && !notificationsSettled.current;
  }, [anchor]);
  const onNotificationsSettled = useCallback(() => {
    notificationsSettled.current = true;
    if (!scrollPending.current) return;
    scrollPending.current = false;
    notificationsRef.current?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <>
      <div ref={appearanceRef} className="scroll-mt-14">
        <SettingsSection title={t("settings.section.appearance")}>
          <SettingsRow label={t("settings.appearance.theme")}>
            <Segmented
              label={t("settings.appearance.theme")}
              value={theme}
              options={labelled(THEMES, t)}
              onChange={(next) => {
                setTheme(next);
                writeThemeChoice(next);
              }}
            />
          </SettingsRow>
          <SettingsRow
            label={t("settings.appearance.size")}
            description={scalable ? undefined : t("settings.appearance.sizeUnavailable")}
          >
            <Segmented
              label={t("settings.appearance.size")}
              value={scale}
              options={labelled(SCALES, t)}
              disabled={!scalable}
              onChange={(next) => {
                setScale(next);
                writeUiScale(next);
              }}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.appearance.motion")} className="border-b-0">
            <Segmented
              label={t("settings.appearance.motion")}
              value={motion}
              options={labelled(MOTIONS, t)}
              onChange={(next) => {
                setMotion(next);
                writeMotionChoice(next);
              }}
            />
          </SettingsRow>
        </SettingsSection>
      </div>

      <SettingsSection title={t("shell.settings.languageRegion")}>
        {/* The language comes first: a reader who cannot read the rest finds it here. */}
        <LanguageRow />
        <RegionRow />
        <TimeZoneRow />
        <SettingsRow label={t("settings.general.clock")} className="border-b-0">
          <Segmented
            label={t("settings.general.clock")}
            value={clock}
            options={labelled(CLOCKS, t)}
            onChange={(next) => {
              setClock(next);
              writeClockChoice(next);
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("shell.settings.startup")}>
        <OpenAtLoginRow t={t} />
        <SettingsRow
          label={t("settings.general.briefing")}
          description={hasBriefing ? undefined : t("settings.general.briefingUnavailable")}
          className="border-b-0"
        >
          <Switch
            label={t("settings.general.briefing")}
            checked={hasBriefing && briefing}
            disabled={!hasBriefing}
            onChange={(next) => {
              setBriefing(next);
              writeBriefingAutoOpenPref(next);
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <div ref={notificationsRef} className="scroll-mt-14">
        <NotificationsSection onSettled={onNotificationsSettled} />
      </div>
    </>
  );
}
