import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { isRegionCode, systemRegion, useRegionChoice, writeRegionChoice } from "@/lib/region";
import { systemTimeZone, useTimeZoneChoice, writeTimeZoneChoice, zoneCity, zoneOptions, utcOffsetLabel } from "@/lib/time-zone";
import { REGION_CHOICES } from "../../../shared/economic-calendar";
import { countryName } from "@/components/calendar/econ-lines";
import PickerModal, { type PickerOption } from "./PickerModal";
import { SettingsRow } from "./SettingsRow";

/**
 * Settings, General: the reader's region (whose releases the calendar adds to
 * the major economies') and time zone (the one the calendar places every time
 * and every day in). Each shows what is in force beside a Change button that
 * opens a searchable list. "Automatic" and "System" follow this machine.
 */

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75";

const AUTO = "auto";
const SYSTEM = "system";

export function RegionRow() {
  const { t, locale } = useI18n();
  const choice = useRegionChoice();
  const [open, setOpen] = useState(false);
  const euro = t("calendar.econ.euroArea");
  const detected = systemRegion();
  const autoLabel = detected ? t("settings.general.regionAuto", { region: countryName(detected, locale, euro) }) : t("settings.general.regionAutoNone");
  const shown = choice === "auto" ? autoLabel : countryName(choice, locale, euro);

  const options = useMemo<PickerOption[]>(() => {
    const countries = REGION_CHOICES.map((code) => ({ id: code, title: countryName(code, locale, euro), subtitle: undefined, search: `${countryName(code, locale, euro)} ${countryName(code, "en-US", euro)} ${code}` })).sort(
      (a, b) => a.title.localeCompare(b.title, locale),
    );
    return [{ id: AUTO, title: autoLabel, search: autoLabel }, ...countries];
  }, [locale, euro, autoLabel]);

  return (
    <>
      <SettingsRow label={t("settings.general.region")} description={t("settings.general.regionNote")}>
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-normal text-content-secondary">{shown}</span>
          <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className={BUTTON}>
            {t("settings.general.languageChange")}
          </button>
        </div>
      </SettingsRow>
      <PickerModal
        open={open}
        title={t("settings.general.regionTitle")}
        searchLabel={t("settings.general.regionSearch")}
        options={options}
        current={choice}
        onPick={(id) => writeRegionChoice(isRegionCode(id) ? id : "auto")}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function TimeZoneRow({ className }: { className?: string }) {
  const { t, locale } = useI18n();
  const choice = useTimeZoneChoice();
  const [open, setOpen] = useState(false);
  const system = systemTimeZone();
  const systemLabel = t("settings.general.timeZoneSystem", { zone: `${zoneCity(system)}, ${utcOffsetLabel(system)}` });
  const shown = choice === SYSTEM ? systemLabel : `${zoneCity(choice)}, ${utcOffsetLabel(choice)}`;

  // Built when the list opens: several hundred zones, each asked for its offset and name.
  const options = useMemo<PickerOption[]>(() => {
    if (!open) return [];
    const zones = zoneOptions(locale).map((o) => ({
      id: o.zone,
      title: `${o.city} (${o.offset})`,
      subtitle: o.name ? `${o.name} · ${o.zone}` : o.zone,
      search: [o.zone, o.city, o.offset, o.name ?? ""].join(" "),
    }));
    return [{ id: SYSTEM, title: systemLabel, subtitle: system, search: `${systemLabel} ${system}` }, ...zones];
  }, [open, locale, systemLabel, system]);

  return (
    <>
      <SettingsRow label={t("settings.general.timeZone")} description={t("settings.general.timeZoneNote")} className={className}>
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-normal text-content-secondary">{shown}</span>
          <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className={BUTTON}>
            {t("settings.general.languageChange")}
          </button>
        </div>
      </SettingsRow>
      <PickerModal
        open={open}
        title={t("settings.general.timeZoneTitle")}
        searchLabel={t("settings.general.timeZoneSearch")}
        options={options}
        current={choice}
        onPick={(id) => writeTimeZoneChoice(id)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

