import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import LanguageModal from "./LanguageModal";
import { SettingsRow } from "./SettingsRow";

/**
 * Settings, General: the language the app is shown in, by its own name, and
 * the button that opens the same picker the account pill's Language row does.
 * Kept in its own file so the General pane only has to place it.
 */

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75";

export default function LanguageRow() {
  const { info, t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingsRow label={t("settings.general.language")}>
        <div className="flex items-center gap-3">
          <span lang={info.code} className="text-[13px] font-normal text-[#6b7280]">
            {info.nativeName}
          </span>
          <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className={BUTTON}>
            {t("settings.general.languageChange")}
          </button>
        </div>
      </SettingsRow>
      <LanguageModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
