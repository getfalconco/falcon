"use client";

import { LogOut, Settings } from "lucide-react";
import { isOwnAvatarPath } from "@/lib/account/avatar";
import { readProfile } from "@/lib/account/profile";
import { useAuthUser, useAvatarUrl } from "@/lib/account/profile-client";
import { Dropdown, ICON_BUTTON, SelectorLabel, selectorClass } from "./shell/ui";
import type { NavId } from "./Sidebar";
import { WorkspaceSwitcher, type WorkspaceSwitcherApi } from "./WorkspaceSwitcher";

export type TopLink = "workspace" | "dashboard" | "docs";

const LINKS: { id: TopLink; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "dashboard", label: "Dashboard" },
  { id: "docs", label: "Docs" },
];

/**
 * Desktop top bar on the gray page: mark, "Falcon" and the workspace
 * switcher on the left, text links, settings and the account circle on the right.
 */
export function TopBar({
  email,
  workspaces,
  activeLink,
  onNav,
  onLink,
  onSettings,
  onSignOut,
}: {
  email: string | null;
  workspaces: WorkspaceSwitcherApi;
  activeLink: TopLink;
  onNav: (id: NavId) => void;
  onLink: (id: TopLink) => void;
  onGuide: () => void;
  onSettings: () => void;
  onSignOut: (() => void) | null;
}) {
  const initial = (email?.trim()[0] ?? "P").toUpperCase();
  // The member's photo from Settings > Account, when they set one (never in the preview).
  const user = useAuthUser(onSignOut !== null);
  const avatarPath = user ? readProfile(user.user_metadata).avatarPath : null;
  const photo = useAvatarUrl(user && isOwnAvatarPath(user.id, avatarPath) ? avatarPath : null);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-6 px-4">
      <div className="flex min-w-0 items-center gap-1">
        <span className="mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-solid text-fs-12.5 font-medium text-solid-ink" aria-hidden>
          F
        </span>
        <Dropdown
          label="Falcon"
          kind="menu"
          width={220}
          groups={[{ label: "Falcon", items: [{ id: "site", label: "Open getfalcon.co", description: "The public site, in this tab" }] }]}
          onSelect={() => window.location.assign("/")}
          button={({ open, props }) => (
            <button {...props} className={selectorClass(open)}>
              <SelectorLabel>Falcon</SelectorLabel>
            </button>
          )}
        />
        <span className="px-0.5 text-fs-15 text-faint-3" aria-hidden>
          /
        </span>
        <WorkspaceSwitcher api={workspaces} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <nav aria-label="Main" className="mr-2 flex items-center gap-0.5">
          {LINKS.map((l) => {
            const on = l.id === activeLink;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onLink(l.id)}
                aria-current={on ? "page" : undefined}
                className={`inline-flex h-8 items-center rounded-lg px-2.5 text-fs-14 outline-none transition-colors hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20 ${
                  on ? "font-medium text-fore" : "text-quiet-2"
                }`}
              >
                {l.label}
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={onSettings}
          title={`Settings (${mac ? "⌘," : "Ctrl+,"})`}
          aria-label="Settings"
          data-settings-trigger
          className={ICON_BUTTON}
        >
          <Settings width={17} height={17} strokeWidth={1.75} aria-hidden />
        </button>
        <Dropdown
          label="Account"
          kind="menu"
          align="right"
          width={232}
          groups={[
            {
              label: "Account",
              items: onSignOut
                ? [{ id: "out", label: "Sign out", icon: LogOut, description: email ?? undefined }]
                : [{ id: "leave", label: "Leave preview", icon: LogOut, description: "Preview, no account" }],
            },
          ]}
          onSelect={(id) => (id === "out" && onSignOut ? onSignOut() : window.location.assign("/"))}
          button={({ open, props }) => (
            <button
              {...props}
              title={email ?? "Preview"}
              className={`ml-1 flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-avatar text-fs-13 font-medium text-fore-3 outline-none transition-colors hover:bg-avatar-hover focus-visible:ring-2 focus-visible:ring-line/25 ${
                open ? "bg-avatar-hover" : ""
              }`}
            >
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; next/image would proxy and cache it.
                <img src={photo} alt="" width={32} height={32} className="h-8 w-8 object-cover" />
              ) : (
                initial
              )}
            </button>
          )}
        />
      </div>
    </header>
  );
}
