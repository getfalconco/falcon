import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "@supabase/supabase-js";
import "../globals.css";
import SettingsModal, { type SettingsSection } from "../components/settings/SettingsModal";
import type { AccountActions } from "../components/settings/AccountPane";
import { applyTheme, getStoredTheme } from "../lib/theme";
import LanguageModal from "../components/settings/LanguageModal";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import type { SystemInfo } from "../../shared/system-settings";

/**
 * Scratch harness: the settings panel over a plain page, so the rail can be
 * looked at and driven without signing into the desktop app.
 *
 *   ?section=account   open on the Account pane (default: the panel's own first row)
 *   ?section=shortcuts open on the Shortcuts pane
 *   ?section=notifications  open on General, scrolled to Notifications (also: appearance)
 *   ?fail=1            the Account pane's writes fail, to see the error lines
 *   ?lang=tr-TR        show the app in that language (kept, as a pick would be)
 *   ?theme=dark        draw in that theme for this load only
 *   ?picker=1          open "Choose your language" over the panel
 *   ?section=billing   open on Billing; the membership lookup answers #042 (Aug 2026)
 *   ?role=leader       the user holds an internal role (staff | deputy | leader | talent_manager)
 *   ?section=privacy   open on Privacy; the bridge answers with a made-up data folder,
 *                      and the tabs its rows open are listed in `window.__settings.tabs`
 *   ?section=general   open on General; ?section=system on System. On both the bridge
 *                      answers the System calls as an installed Windows app would, and
 *                      ?login=dev answers as a dev build (no login item)
 *
 * The Account pane gets a made-up signed-in user and writes that only touch
 * it, so nothing here reaches Supabase. `window.__settings.writes` lists what
 * the pane asked to save.
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const pickerOnLoad = params.get("picker") === "1";
const fail = params.get("fail") === "1";
const SECTIONS = ["account", "shortcuts", "billing", "notifications", "appearance", "privacy", "general", "system"] as const;
const section = SECTIONS.find((s) => s === params.get("section"));

const writes: unknown[] = [];
const role = params.get("role");

// Billing reads the member date from the site's membership lookup; on that
// pane alone the bridge answers it, so no other pane sees a stubbed bridge.
if (section === "billing") {
  (window as unknown as { meridian: unknown }).meridian = {
    ...((window as unknown as { meridian?: object }).meridian ?? {}),
    openExternal: async (url: string) => {
      writes.push({ openExternal: url });
    },
    getWaitlistMembership: async () => ({
      found: true,
      name: "Kuzey Kovalak",
      memberNumber: 42,
      grantedAt: "2026-08-14T00:00:00.000Z",
      approved: true,
    }),
  };
}
// Privacy reads the data folder through the bridge; on that pane alone it
// answers with a made-up folder, so the pane's pages can be looked at.
const tabs: string[] = [];
if (section === "privacy") {
  const pause = () => new Promise((r) => setTimeout(r, 250));
  const kb = 1024;
  (window as unknown as { meridian: unknown }).meridian = {
    ...((window as unknown as { meridian?: object }).meridian ?? {}),
    openExternal: async (url: string) => {
      writes.push({ openExternal: url });
    },
    getPrivacySummary: async () => {
      await pause();
      return {
        ok: true,
        summary: {
          root: "C:\\Users\\reader\\AppData\\Roaming\\Falcon\\data",
          categories: [
            { key: "engines", label: "Engine state", description: "", kind: "engine", files: 42, bytes: 3_400 * kb },
            { key: "profile", label: "Profile photo", description: "", kind: "personal", files: 1, bytes: 88 * kb },
            { key: "research", label: "Company graphs", description: "", kind: "cache", files: 318, bytes: 61_200 * kb },
            { key: "news", label: "News events", description: "", kind: "cache", files: 27, bytes: 1_900 * kb },
            { key: "briefings", label: "Saved briefings", description: "", kind: "personal", files: 6, bytes: 240 * kb },
          ],
          clearable: { files: 6, bytes: 240 * kb },
          routes: { modelHost: "api.anthropic.com", newsHost: "finnhub.io", engineHost: "engine.getfalcon.co", viaWorker: false },
        },
      };
    },
    exportMyData: async () => {
      await pause();
      return { ok: true, path: "C:\\Users\\reader\\Downloads\\falcon-export-2026-10-15.json", bytes: 182 * kb };
    },
    clearLocalHistory: async () => {
      await pause();
      return { ok: true, removed: 6, bytes: 240 * kb };
    },
    revealDataFolder: async () => {
      tabs.push("data-folder");
      return { ok: true };
    },
  };
}
// General's "Open when the computer starts" and the System pane read the
// install through the bridge; on those panes it answers as an installed app
// (or, with ?login=dev, as a dev build), and switches flip in memory.
if (section === "general" || section === "system") {
  const dev = params.get("login") === "dev";
  const info: SystemInfo = {
    version: "0.9.0",
    packaged: !dev,
    platform: "win32",
    openAtLogin: dev
      ? { supported: false, code: "installed-only", reason: "Available in the installed app.", enabled: false }
      : { supported: true, enabled: true },
    hardwareAcceleration: { saved: true, active: true },
    quickOpen: { keys: null, registered: false, error: null },
    tray: { supported: true, enabled: true },
    keepAwake: { enabled: false, active: false },
    restart: dev ? { supported: false, code: "installed-only", reason: "Available in the installed app." } : { supported: true },
    updates: { supported: true, status: { kind: "idle" }, lastCheck: null },
    dataRoot: "C:\\Users\\reader\\AppData\\Roaming\\Falcon\\data",
    dataFolder: {
      path: "C:\\Users\\reader\\AppData\\Roaming\\Falcon\\data",
      source: "default",
      pending: null,
      previous: null,
      missing: null,
      change: { supported: true },
    },
  };
  const answer = async (change: (i: SystemInfo) => void) => {
    await new Promise((r) => setTimeout(r, 200));
    change(info);
    writes.push({ system: { openAtLogin: info.openAtLogin.enabled, tray: info.tray.enabled } });
    return { ok: true as const, value: structuredClone(info) };
  };
  (window as unknown as { meridian: unknown }).meridian = {
    ...((window as unknown as { meridian?: object }).meridian ?? {}),
    getSystemInfo: async () => ({ ok: true, value: structuredClone(info) }),
    getSystemStorage: async () => ({ ok: true, value: { dataBytes: 66_000_000, cacheBytes: 12_400_000 } }),
    setOpenAtLogin: (on: boolean) =>
      answer((i) => {
        i.openAtLogin = { ...i.openAtLogin, enabled: on };
      }),
    setTrayEnabled: (on: boolean) =>
      answer((i) => {
        i.tray = { ...i.tray, enabled: on };
      }),
    setKeepAwake: (on: boolean) =>
      answer((i) => {
        i.keepAwake = { enabled: on, active: on };
      }),
    setHardwareAcceleration: (on: boolean) =>
      answer((i) => {
        i.hardwareAcceleration = { ...i.hardwareAcceleration, saved: on };
      }),
  };
}
(window as unknown as { __settings: unknown }).__settings = { writes, signOuts: 0, tabs };

const FAKE_USER = {
  id: "56b7a75c-ac79-4e42-8286-26596d02622d",
  email: "reader@example.com",
  app_metadata: role ? { approved: true, role } : {},
  aud: "authenticated",
  created_at: "2026-08-01T00:00:00.000Z",
  user_metadata: { full_name: "Kuzey Kovalak", preferred_name: "Kuzey", onboarding_complete: true },
} as unknown as User;

function Harness() {
  const [open, setOpen] = useState(true);
  // The row in force; kept here so a pane's own jump (Privacy to Account) moves it.
  const [current, setCurrent] = useState<SettingsSection | undefined>(section);
  const [picker, setPicker] = useState(pickerOnLoad);
  const [user, setUser] = useState<User>(FAKE_USER);
  const actions: AccountActions = {
    save: async (fields) => {
      writes.push(fields);
      await new Promise((r) => setTimeout(r, 300));
      if (fail) throw new Error("preview: write refused");
      setUser((u) => ({ ...u, user_metadata: { ...u.user_metadata, ...fields } }) as User);
    },
    signOutEverywhere: async () => {
      (window as unknown as { __settings: { signOuts: number } }).__settings.signOuts += 1;
      await new Promise((r) => setTimeout(r, 300));
      if (fail) throw new Error("preview: sign-out refused");
    },
  };
  return (
    <div
      className="h-screen w-screen p-10"
      style={themeParam === "dark" ? { background: "#000" } : { background: "#f2f0ed", colorScheme: "light" }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-white/60 bg-white/55 px-4 py-2 text-[13px] text-content-primary"
      >
        Open settings
      </button>
      <SettingsModal
        open={open}
        onClose={() => setOpen(false)}
        section={current}
        onSection={setCurrent}
        user={user}
        accountActions={actions}
        onOpenTab={(tab) => {
          tabs.push(tab);
          setOpen(false);
        }}
      />
      <LanguageModal open={picker} onClose={() => setPicker(false)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
