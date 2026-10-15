import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "@supabase/supabase-js";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/libre-baskerville/400.css";
import "../globals.css";
import PlansModal from "../components/plans/PlansModal";
import { applyTheme, getStoredTheme, type Theme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";

/**
 * Scratch harness: "View All Plans" over a plain page, without signing in.
 *
 *   ?role=staff     an account with an internal role (staff | deputy | leader | talent_manager)
 *   ?theme=dark     force a theme (default: the stored one)
 *   ?lang=es-ES     show it in a language (default: the stored one)
 *
 * The bridge is stubbed: `window.__plans.opened` lists the plan keys a button
 * asked the main process to open, and the membership lookup answers #042.
 */

const params = new URLSearchParams(location.search);
const theme = params.get("theme");
applyTheme(theme === "dark" || theme === "light" ? (theme as Theme) : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();

const opened: string[] = [];

/**
 * `await __plans.measure()`: the panel's content height against the height it
 * has, monthly and annual (the panel must never scroll, so `over` must stay at
 * or below 0), with the feature rows that wrap and any text cut by `truncate`.
 */
async function measure() {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const read = () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const body = dialog.children[1] as HTMLElement;
    const content = body.firstElementChild as HTMLElement;
    const cs = getComputedStyle(body);
    const available = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const wrapped = [...dialog.querySelectorAll<HTMLElement>(".grid li")].filter((li) => li.offsetHeight > 20).map((li) => li.textContent);
    const cut = [...dialog.querySelectorAll<HTMLElement>(".truncate, header *")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => e.textContent);
    return { content: content.offsetHeight, available, over: content.offsetHeight - available, scrolls: body.scrollHeight > body.clientHeight, wrapped, cut };
  };
  const toggle = (i: number) => [...document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-pressed]')][i]?.click();
  await wait(900);
  const monthly = read();
  toggle(1);
  await wait(450);
  const annual = read();
  toggle(0);
  return { lang: document.documentElement.lang, width: innerWidth, height: innerHeight, monthly, annual };
}

(window as unknown as { __plans: unknown }).__plans = { opened, measure };
(window as unknown as { meridian: unknown }).meridian = {
  openPlanPage: async (key: string) => {
    opened.push(key);
  },
  openExternal: async () => undefined,
  getWaitlistMembership: async () => ({
    found: true,
    name: "Kuzey Kovalak",
    memberNumber: 42,
    grantedAt: "2026-08-14T00:00:00.000Z",
    approved: true,
  }),
};

const role = params.get("role");
const FAKE_USER = {
  id: "56b7a75c-ac79-4e42-8286-26596d02622d",
  email: "reader@example.com",
  app_metadata: { approved: true, ...(role ? { role } : {}) },
  aud: "authenticated",
  created_at: "2026-08-01T00:00:00.000Z",
  user_metadata: { full_name: "Kuzey Kovalak", preferred_name: "Kuzey", onboarding_complete: true },
} as unknown as User;

function Harness() {
  const [open, setOpen] = useState(true);
  const dark = document.documentElement.dataset.theme === "dark";
  return (
    <div className="h-screen w-screen p-10" style={{ background: dark ? "#050505" : "#f2f0ed" }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-white/60 bg-white/55 px-4 py-2 text-[13px] text-[#1d1b1b]"
      >
        View all plans
      </button>
      <PlansModal open={open} onClose={() => setOpen(false)} user={FAKE_USER} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
