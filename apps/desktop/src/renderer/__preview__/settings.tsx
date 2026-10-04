import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "@supabase/supabase-js";
import "../globals.css";
import SettingsModal from "../components/settings/SettingsModal";
import type { AccountActions } from "../components/settings/AccountPane";
import { applyTheme, getStoredTheme } from "../lib/theme";

/**
 * Scratch harness: the settings panel over a plain page, so the rail can be
 * looked at and driven without signing into the desktop app.
 *
 *   ?section=account   open on the Account pane (default: the panel's own first row)
 *   ?fail=1            the Account pane's writes fail, to see the error lines
 *
 * The Account pane gets a made-up signed-in user and writes that only touch
 * it, so nothing here reaches Supabase. `window.__settings.writes` lists what
 * the pane asked to save.
 */

applyTheme(getStoredTheme());

const params = new URLSearchParams(location.search);
const fail = params.get("fail") === "1";
const section = params.get("section") === "account" ? "account" : undefined;

const writes: unknown[] = [];
(window as unknown as { __settings: unknown }).__settings = { writes, signOuts: 0 };

const FAKE_USER = {
  id: "56b7a75c-ac79-4e42-8286-26596d02622d",
  email: "reader@example.com",
  app_metadata: {},
  aud: "authenticated",
  created_at: "2026-08-01T00:00:00.000Z",
  user_metadata: { full_name: "Kuzey Kovalak", preferred_name: "Kuzey", onboarding_complete: true },
} as unknown as User;

function Harness() {
  const [open, setOpen] = useState(true);
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
    <div className="h-screen w-screen p-10" style={{ background: "#f2f0ed", colorScheme: "light" }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-white/60 bg-white/55 px-4 py-2 text-[13px] text-[#1d1b1b]"
      >
        Open settings
      </button>
      <SettingsModal
        open={open}
        onClose={() => setOpen(false)}
        section={section}
        user={user}
        accountActions={actions}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
