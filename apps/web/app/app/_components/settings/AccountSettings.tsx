"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from "react";
import type { User } from "@supabase/supabase-js";
import { Check, ChevronDown, Copy, Loader2 } from "lucide-react";
import { requireSupabase } from "@/lib/supabase";
import { AVATAR_ACCEPT, AVATAR_BUCKET, AVATAR_EXTS, avatarPath, checkAvatar, isOwnAvatarPath, monogram } from "@/lib/account/avatar";
import { NAME_MAX, WORK_ROLES, cleanName, readProfile, type WorkRoleId } from "@/lib/account/profile";
import { invalidateAvatar, useAuthUser, useAvatarUrl } from "@/lib/account/profile-client";
import type { SessionView, SessionsResponse } from "@/lib/account/sessions";
import { deviceLabel } from "@/lib/account/user-agent";
import { firstName } from "@/lib/workspace/greeting";
import { useWorkspace } from "../context";
import { MONO } from "../parts";
import { Dropdown } from "../shell/ui";
import { SectionHeading, SettingRow } from "./controls";

/**
 * Settings > Account: the profile (photo, names, work, account id) and the
 * devices signed in. Names and work live in auth user_metadata
 * (lib/account/profile.ts); the photo in the private `avatars` bucket; the
 * device list comes from GET /api/account/sessions. In the preview (no
 * account) everything shows disabled with placeholders.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/25";
const INPUT = `h-[26px] w-[205px] rounded-[7px] bg-line/[0.06] px-[11px] text-fs-14 text-fore placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;
const QUIET_BUTTON = `h-[26px] rounded-[7px] px-[9px] text-fs-14 text-quiet transition-colors hover:bg-line/[0.06] hover:text-fore disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`;
const FILLED_BUTTON = `h-[26px] shrink-0 rounded-[7px] bg-line/[0.08] px-[9px] text-fs-14 text-fore transition-colors hover:bg-line/[0.12] disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`;
const DANGER = `h-[26px] shrink-0 rounded-[7px] bg-down/[0.1] px-[9px] text-fs-14 text-down transition-colors hover:bg-down/[0.16] disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`;

type Save = (data: Record<string, unknown>) => Promise<boolean>;

export function AccountSettings({ headingId }: { headingId: string }) {
  const { getToken } = useWorkspace();
  // The preview has no account: getToken answers null there, even when a session exists in this browser.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getToken().then((t) => live && setSignedIn(Boolean(t)));
    return () => {
      live = false;
    };
  }, [getToken]);
  const user = useAuthUser(signedIn === true);
  const account = signedIn && user ? user : null;
  const preview = signedIn === false;

  const save: Save = useCallback(async (data) => {
    const { error } = await requireSupabase().auth.updateUser({ data });
    if (error) console.error("[settings/account] save", error.code ?? error.status ?? "error");
    return !error;
  }, []);

  return (
    <>
      <section aria-labelledby={headingId}>
        <SectionHeading id={headingId}>Profile</SectionHeading>
        {preview ? <p className="mt-1 text-fs-14 leading-fs-22 text-quiet">Preview, no account. Nothing here is saved.</p> : null}
        <div className="mt-3">
          <PhotoRow user={account} save={save} getToken={getToken} />
          <NameRow
            key={`full:${account?.id ?? "none"}`}
            title="Full name"
            field="full_name"
            initial={account ? readProfile(account.user_metadata).fullName : ""}
            placeholder={account ? "Your name" : "—"}
            disabled={!account}
            save={save}
          />
          <NameRow
            key={`pref:${account?.id ?? "none"}`}
            title="What should Falcon call you?"
            field="preferred_name"
            initial={account ? readProfile(account.user_metadata).preferredName : ""}
            placeholder={account ? firstName(readProfile(account.user_metadata).fullName) ?? "First name" : "—"}
            disabled={!account}
            save={save}
          />
          <WorkRow value={account ? readProfile(account.user_metadata).workRole : null} disabled={!account} save={save} />
          <SettingRow title="Account ID">
            {account ? <AccountId id={account.id} /> : <span className="text-fs-14 text-quiet">{preview ? "Preview, no account" : "—"}</span>}
          </SettingRow>
        </div>
      </section>
      <SessionsBlock headingId={`${headingId}-sessions`} signedIn={signedIn} getToken={getToken} />
    </>
  );
}

/** A small text status after a save: "Saved" fades on its own, errors stay until the next try. */
function useSaveStatus() {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = useCallback(async (work: () => Promise<boolean>) => {
    clearTimeout(timer.current);
    setStatus("saving");
    const ok = await work().catch(() => false);
    setStatus(ok ? "saved" : "error");
    if (ok) timer.current = setTimeout(() => setStatus("idle"), 1600);
    return ok;
  }, []);
  return { status, run };
}

function SaveNote({ status }: { status: "idle" | "saving" | "saved" | "error" }) {
  return (
    <span aria-live="polite" className="mr-3 inline-flex min-w-[52px] items-center justify-end text-fs-13 text-quiet">
      {status === "saving" ? <Loader2 width={13} height={13} strokeWidth={2} className="animate-spin text-faint" aria-label="Saving" /> : null}
      {status === "saved" ? (
        <span className="inline-flex items-center gap-1 text-quiet">
          <Check width={13} height={13} strokeWidth={2} aria-hidden />
          Saved
        </span>
      ) : null}
      {status === "error" ? <span className="text-down">Not saved</span> : null}
    </span>
  );
}

function NameRow({
  title,
  field,
  initial,
  placeholder,
  disabled,
  save,
}: {
  title: string;
  field: "full_name" | "preferred_name";
  initial: string;
  placeholder: string;
  disabled: boolean;
  save: Save;
}) {
  const [value, setValue] = useState(initial);
  const saved = useRef(initial);
  const { status, run } = useSaveStatus();
  const labelId = `account-${field}`;

  const commit = () => {
    const next = cleanName(value);
    setValue(next);
    if (next === saved.current) return;
    void run(async () => {
      const ok = await save({ [field]: next || null });
      if (ok) saved.current = next;
      return ok;
    });
  };

  return (
    <SettingRow id={labelId} title={title}>
      <SaveNote status={status} />
      <input
        value={value}
        maxLength={NAME_MAX}
        disabled={disabled}
        placeholder={placeholder}
        aria-labelledby={labelId}
        autoComplete={field === "full_name" ? "name" : "nickname"}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && value !== saved.current) {
            // Escape undoes the edit first; a second Escape closes Settings.
            e.stopPropagation();
            setValue(saved.current);
          }
        }}
        className={INPUT}
      />
    </SettingRow>
  );
}

function WorkRow({ value, disabled, save }: { value: WorkRoleId | null; disabled: boolean; save: Save }) {
  const [current, setCurrent] = useState<WorkRoleId | null>(value);
  useEffect(() => setCurrent(value), [value]);
  const { status, run } = useSaveStatus();
  const label = WORK_ROLES.find((r) => r.id === current)?.label;

  const pick = (id: string) => {
    const role = WORK_ROLES.find((r) => r.id === id)?.id ?? null;
    if (!role || role === current) return;
    const before = current;
    setCurrent(role);
    void run(async () => {
      const ok = await save({ work_role: role });
      if (!ok) setCurrent(before);
      return ok;
    });
  };

  const trigger = (open: boolean, props?: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) => (
    <button
      {...props}
      type="button"
      disabled={disabled}
      className={`flex h-[26px] w-[205px] items-center justify-between rounded-[7px] bg-line/[0.06] pl-[11px] pr-2.5 text-left text-fs-14 transition-colors hover:bg-line/[0.08] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS} ${open ? "bg-line/[0.08]" : ""}`}
    >
      <span className={`truncate ${label ? "text-fore" : "text-faint"}`}>{label ?? "Select"}</span>
      <ChevronDown width={14} height={14} strokeWidth={1.5} className="shrink-0 text-fore-3" aria-hidden />
    </button>
  );

  return (
    <SettingRow title="What best describes your work?">
      <SaveNote status={status} />
      {disabled ? (
        trigger(false, { "aria-label": "What best describes your work?" })
      ) : (
        <Dropdown
          label="What best describes your work?"
          kind="select"
          align="right"
          width={220}
          groups={[{ items: WORK_ROLES.map((r) => ({ id: r.id, label: r.label, selected: r.id === current })) }]}
          onSelect={pick}
          button={({ open, props }) => trigger(open, props)}
        />
      )}
    </SettingRow>
  );
}

function AccountId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };
  return (
    <span className="flex items-center gap-1.5">
      <span className="select-all truncate text-fs-13 text-quiet" style={{ fontFamily: MONO }}>
        {id}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Account ID copied" : "Copy account ID"}
        title={copied ? "Copied" : "Copy"}
        className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-fore-3 transition-colors hover:bg-line/[0.06] hover:text-fore ${FOCUS}`}
      >
        {copied ? <Check width={14} height={14} strokeWidth={1.75} aria-hidden /> : <Copy width={14} height={14} strokeWidth={1.5} aria-hidden />}
      </button>
    </span>
  );
}

/* ---------------------------------------------------------------- photo */

function Avatar({ name, seed, fallback, url, size = 40 }: { name: string; seed: string; fallback?: string | null; url: string | null; size?: number }) {
  const m = monogram(name, seed, fallback);
  const style = { width: size, height: size, "--mono-h": String(m.hue) } as CSSProperties;
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; next/image would proxy and cache it.
    return <img src={url} alt="" width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden
      style={style}
      className="flex items-center justify-center rounded-full text-fs-14 font-medium [background-color:hsl(var(--mono-h)_55%_90%)] [color:hsl(var(--mono-h)_35%_32%)] dark:[background-color:hsl(var(--mono-h)_22%_24%)] dark:[color:hsl(var(--mono-h)_45%_80%)]"
    >
      {m.letters}
    </span>
  );
}

function PhotoRow({ user, save, getToken }: { user: User | null; save: Save; getToken: () => Promise<string | null> }) {
  const profile = readProfile(user?.user_metadata);
  const path = user && isOwnAvatarPath(user.id, profile.avatarPath) ? profile.avatarPath : null;
  const url = useAvatarUrl(path);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    let live = true;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const res = await fetch("/api/account/avatar", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { available?: boolean } | null) : null;
      if (live) setAvailable(body?.available === true);
    })();
    return () => {
      live = false;
    };
  }, [user, getToken]);

  const upload = async (file: File) => {
    if (!user) return;
    setError(null);
    const check = checkAvatar(file);
    if (!check.ok) return setError(check.error);
    setBusy(true);
    try {
      const storage = requireSupabase().storage.from(AVATAR_BUCKET);
      const next = avatarPath(user.id, check.ext);
      const { error: upErr } = await storage.upload(next, file, { upsert: true, contentType: check.type, cacheControl: "3600" });
      if (upErr) {
        console.error("[settings/account] upload", (upErr as { statusCode?: string }).statusCode ?? upErr.name);
        return setError("Could not upload that photo. Try again.");
      }
      // A photo saved under another extension earlier would otherwise linger.
      const stale = AVATAR_EXTS.filter((e) => e !== check.ext).map((e) => avatarPath(user.id, e));
      void storage.remove(stale).catch(() => undefined);
      if (!(await save({ avatar_path: next }))) return setError("Uploaded, but it could not be saved to your profile.");
      invalidateAvatar();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!user || !path) return;
    setError(null);
    setBusy(true);
    try {
      if (!(await save({ avatar_path: null }))) return setError("Could not remove the photo. Try again.");
      void requireSupabase().storage.from(AVATAR_BUCKET).remove([path]).catch(() => undefined);
      invalidateAvatar();
    } finally {
      setBusy(false);
    }
  };

  const can = Boolean(user) && available === true && !busy;
  const avatar = (
    <span className="relative">
      <Avatar name={profile.fullName} seed={user?.id ?? "preview"} fallback={user?.email ?? "P"} url={url} />
      {busy ? (
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
          <Loader2 width={16} height={16} strokeWidth={2} className="animate-spin text-white" aria-label="Uploading" />
        </span>
      ) : null}
    </span>
  );

  const ring = `rounded-full transition-opacity hover:opacity-90 ${FOCUS}`;
  let hint: ReactNode = "PNG, JPEG, or WebP, up to 10MB.";
  if (error) hint = <span className="text-down">{error}</span>;
  else if (user && available === false) hint = "PNG, JPEG, or WebP, up to 10MB. Photo upload isn't available yet.";

  return (
    <SettingRow title="Profile photo" description={hint}>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
      {can && path ? (
        <Dropdown
          label="Profile photo"
          kind="menu"
          align="right"
          width={180}
          groups={[
            {
              items: [
                { id: "change", label: "Upload new photo" },
                { id: "remove", label: "Remove photo", danger: true },
              ],
            },
          ]}
          onSelect={(id) => (id === "remove" ? void remove() : inputRef.current?.click())}
          button={({ props }) => (
            <button {...props} className={ring}>
              {avatar}
            </button>
          )}
        />
      ) : can ? (
        <button type="button" aria-label="Upload profile photo" title="Upload photo" onClick={() => inputRef.current?.click()} className={ring}>
          {avatar}
        </button>
      ) : (
        avatar
      )}
    </SettingRow>
  );
}

/* ------------------------------------------------------------- sessions */

const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function when(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE.format(t) : "—";
}

function ago(iso: string | null, current: boolean): string {
  if (current) return "Now";
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (min < 2) return "Now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "Yesterday" : `${d} days ago`;
  return DATE.format(t);
}

type SessionsState = { state: "loading" } | { state: "preview"; rows: SessionView[] } | { state: "ready"; listed: boolean; rows: SessionView[] } | { state: "error" };

const COLS = "grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)] items-center gap-4";

function SessionsBlock({ headingId, signedIn, getToken }: { headingId: string; signedIn: boolean | null; getToken: () => Promise<string | null> }) {
  const [data, setData] = useState<SessionsState>({ state: "loading" });
  const [confirmAll, setConfirmAll] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (signedIn === null) return;
    if (!signedIn) {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setData({ state: "preview", rows: [{ id: "preview", device: deviceLabel(ua), location: null, signedInAt: null, lastActiveAt: null, current: true }] });
      return;
    }
    let live = true;
    void (async () => {
      const token = await getToken();
      if (!token) return live && setData({ state: "error" });
      const res = await fetch("/api/account/sessions", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as SessionsResponse | null) : null;
      if (!live) return;
      if (!body) return setData({ state: "error" });
      if (body.listed) setData({ state: "ready", listed: true, rows: body.sessions });
      else setData({ state: "ready", listed: false, rows: body.current ? [body.current] : [] });
    })();
    return () => {
      live = false;
    };
  }, [signedIn, getToken]);

  const end = async (id: string) => {
    setNote(null);
    setEnding(id);
    try {
      const token = await getToken();
      const res = token
        ? await fetch("/api/account/sessions", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          }).catch(() => null)
        : null;
      if (res?.ok || res?.status === 404) {
        setData((d) => (d.state === "ready" ? { ...d, rows: d.rows.filter((r) => r.id !== id) } : d));
      } else {
        setNote("Could not log that device out. Try again.");
      }
    } finally {
      setEnding(null);
    }
  };

  const signOutEverywhere = async () => {
    setLeaving(true);
    const { error } = await requireSupabase()
      .auth.signOut({ scope: "global" })
      .catch(() => ({ error: new Error("signout") }));
    if (error) {
      setLeaving(false);
      setConfirmAll(false);
      setNote("Could not log out everywhere. Try again.");
      return;
    }
    window.location.assign("/login");
  };

  const rows = data.state === "ready" || data.state === "preview" ? data.rows : [];

  return (
    <section aria-labelledby={headingId} className="mt-[35px]">
      <div className="flex min-h-[26px] items-center justify-between gap-4">
        <SectionHeading id={headingId}>Where you&apos;re logged in</SectionHeading>
        {confirmAll ? (
          <span className="flex items-center gap-1.5">
            <button type="button" className={QUIET_BUTTON} onClick={() => setConfirmAll(false)} disabled={leaving}>
              Cancel
            </button>
            <button type="button" className={DANGER} onClick={() => void signOutEverywhere()} disabled={leaving}>
              {leaving ? "Logging out…" : "Log out everywhere"}
            </button>
          </span>
        ) : (
          <button type="button" className={FILLED_BUTTON} onClick={() => setConfirmAll(true)} disabled={!signedIn}>
            Log out of all devices
          </button>
        )}
      </div>
      {confirmAll ? <p className="mt-1 text-fs-14 leading-fs-22 text-quiet">This signs out every device, including this one.</p> : null}

      <div role="table" aria-label="Signed-in devices" className="mt-3">
        <div role="row" className={`${COLS} h-[34px] border-b border-line/[0.08] text-fs-13 text-quiet`}>
          <span role="columnheader">Device</span>
          <span role="columnheader">Location</span>
          <span role="columnheader">Signed in</span>
          <span role="columnheader">Last active</span>
        </div>
        {data.state === "loading" ? (
          <div className="flex h-[46px] items-center text-fs-14 text-quiet">
            <Loader2 width={14} height={14} strokeWidth={2} className="mr-2 animate-spin text-faint" aria-hidden />
            Loading devices
          </div>
        ) : data.state === "error" ? (
          <div className="flex h-[46px] items-center text-fs-14 text-quiet">Could not load your devices.</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} role="row" className={`${COLS} group min-h-[46px] border-b border-line/[0.08] py-2 text-fs-14 last:border-b-0`}>
              <span role="cell" className="flex min-w-0 items-center gap-2 text-fore">
                <span className="truncate">{r.device}</span>
                {r.current ? <span className="shrink-0 rounded-full bg-line/[0.07] px-2 py-px text-fs-12 leading-fs-18 text-fore-3">Current</span> : null}
              </span>
              <span role="cell" className="truncate text-quiet">
                {r.location ?? "—"}
              </span>
              <span role="cell" className="truncate text-quiet">
                {when(r.signedInAt)}
              </span>
              <span role="cell" className="flex min-w-0 items-center justify-between gap-2 text-quiet">
                <span className="truncate">{data.state === "preview" ? "—" : ago(r.lastActiveAt, r.current)}</span>
                {!r.current && data.state === "ready" ? (
                  <button
                    type="button"
                    onClick={() => void end(r.id)}
                    disabled={ending === r.id}
                    className={`${QUIET_BUTTON} -my-1 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 ${ending === r.id ? "opacity-100" : ""}`}
                  >
                    {ending === r.id ? "Logging out…" : "Log out"}
                  </button>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>
      {data.state === "ready" && !data.listed ? (
        <p className="mt-2 text-fs-13 leading-fs-20 text-quiet">Only this device is shown for now. Log out of all devices still signs out everywhere.</p>
      ) : null}
      {note ? <p className="mt-2 text-fs-13 leading-fs-20 text-down">{note}</p> : null}
    </section>
  );
}
