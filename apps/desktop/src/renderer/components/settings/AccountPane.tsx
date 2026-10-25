import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Camera, Check, Copy } from "lucide-react";
import { Avatar } from "@/components/dashboard/ProfilePill";
import { cn } from "@/lib/utils";
import { displayNameFromUser } from "@/lib/greeting";
import {
  PROFILE_PHOTO_INPUT_ACCEPT,
  ProfilePhotoError,
  type ProfilePhotoProblem,
  clearProfilePhoto,
  prepareProfilePhoto,
  saveProfilePhoto,
  useProfilePhoto,
} from "@/lib/profile-photo";
import {
  INSTRUCTIONS_MAX,
  readCallName,
  readInstructions,
  deleteAccount,
  saveAccountFields,
  signOutEverywhere,
  type AccountFields,
} from "@/lib/user-preferences";
import { useT, type MessageKey } from "@/lib/i18n";
import { PROFILE_PHOTO_SOURCE_MAX_BYTES } from "../../../shared/profile-photo";
import { SettingsRow, SettingsSection } from "./SettingsRow";

/**
 * Account — who the reader is to Falcon, and the account behind it. Laid out
 * after Claude's own account page, which Kuzey sent: the profile (avatar,
 * name, what to be called, standing instructions), then the account (sign
 * out everywhere, deletion, the account's id). Claude's "what best describes
 * your work" question is left out on his word.
 *
 * Every field saves itself when the reader leaves it, into the user's
 * metadata, the way onboarding writes the name; the auth listener in App
 * picks the change up and the greeting and the account pill follow. The
 * photo is the exception: it is kept on this machine (lib/profile-photo),
 * since metadata rides inside every access token, and saves as soon as one
 * is picked.
 */

export type AccountActions = {
  save: (fields: AccountFields) => Promise<void>;
  signOutEverywhere: () => Promise<void>;
  /** Optional so previews that stub the pane keep compiling; the app passes the real one. */
  deleteAccount?: () => Promise<void>;
};

const DEFAULT_ACTIONS: AccountActions = { save: saveAccountFields, signOutEverywhere, deleteAccount };

const FIELD =
  "app-no-drag rounded-xl border border-white/60 bg-white/55 px-3 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-content-tertiary focus:bg-white/75 disabled:opacity-60";

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none";

type SaveState = "idle" | "saving" | "saved" | "error" | "invalid";

const STATUS_TEXT: Record<Exclude<SaveState, "idle">, MessageKey> = {
  saving: "settings.account.saving",
  saved: "settings.account.saved",
  error: "settings.account.saveFailed",
  invalid: "settings.account.nameRequired",
};

/**
 * One saved field: a draft the reader types into, written out when they leave
 * it (blur, or Enter in a one-line field) and only when it changed. While the
 * reader is not editing, the draft follows the stored value, so a change that
 * arrives from elsewhere (another device, the auth refresh) shows up.
 */
function useSavedField(stored: string, commit: (value: string) => Promise<void>, required = false) {
  const [draft, setDraft] = useState(stored);
  const [state, setState] = useState<SaveState>("idle");
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editing.current) setDraft(stored);
  }, [stored]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const settle = (next: SaveState) => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    if (next === "saved" || next === "invalid") timer.current = setTimeout(() => setState("idle"), 2200);
  };

  const onFocus = () => {
    editing.current = true;
  };
  const onBlur = async () => {
    editing.current = false;
    const value = draft.trim();
    if (value === stored.trim()) {
      setDraft(stored);
      return;
    }
    // A name cannot be emptied: an account without one is sent back through
    // onboarding on the next launch.
    if (required && !value) {
      setDraft(stored);
      settle("invalid");
      return;
    }
    settle("saving");
    try {
      await commit(value);
      settle("saved");
    } catch {
      settle("error");
    }
  };
  return { draft, setDraft, state, onFocus, onBlur };
}

function Status({ state }: { state: SaveState }) {
  const t = useT();
  if (state === "idle") return null;
  return (
    <span
      role="status"
      className={cn("text-[12px] font-normal", state === "error" || state === "invalid" ? "text-tone-negative" : "text-content-tertiary")}
    >
      {t(STATUS_TEXT[state])}
    </span>
  );
}

/** Enter leaves a one-line field, which is what saves it. */
function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") e.currentTarget.blur();
}

function AccountId({ id }: { id: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      title={t("common.copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => setCopied(true), () => undefined);
      }}
      className="app-no-drag group flex items-center gap-2 rounded-lg bg-black/[0.04] px-2.5 py-1 font-['Geist_Mono'] text-[12px] text-content-body transition-colors hover:bg-black/[0.06]"
    >
      <span data-selectable className="select-text">{id}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-tone-positive" strokeWidth={2} aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5 text-content-tertiary group-hover:text-content-body" strokeWidth={1.75} aria-hidden />
      )}
      <span className="sr-only">{copied ? t("common.copied") : t("settings.account.copyId")}</span>
    </button>
  );
}

const PHOTO_STATUS: Record<"saving" | "saved" | "removed", MessageKey> = {
  saving: "settings.account.saving",
  saved: "settings.account.saved",
  removed: "settings.account.photoRemoved",
};

/** Why a picked file was refused, as the pane words it. */
const PHOTO_PROBLEM: Record<ProfilePhotoProblem, MessageKey> = {
  type: "settings.account.photoWrongType",
  size: "settings.account.photoTooBig",
  unreadable: "settings.account.photoUnreadable",
  empty: "settings.account.photoEmpty",
  "too-large": "settings.account.photoTooLarge",
};

/**
 * The avatar, and the photo that can stand in for the generated mark. Clicking
 * the avatar or Upload opens the picker; the picked image is cropped to a
 * centred square and scaled down before it is stored, and the avatar shows
 * the result at once, here and in the account pill.
 */
function AvatarControl({ userId, name }: { userId: string | null; name: string }) {
  const t = useT();
  const photo = useProfilePhoto(userId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "removed" } | { kind: "error"; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (!status || status.kind === "saving") return;
    const t = setTimeout(() => setStatus(null), status.kind === "error" ? 4000 : 2200);
    return () => clearTimeout(t);
  }, [status]);

  const pick = () => {
    if (userId && !busy) input.current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared at once, so picking the same file again still fires a change.
    e.target.value = "";
    if (!file || !userId) return;
    setBusy(true);
    setStatus({ kind: "saving" });
    try {
      await saveProfilePhoto(userId, await prepareProfilePhoto(file));
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({
        kind: "error",
        text:
          err instanceof ProfilePhotoError
            ? t(PHOTO_PROBLEM[err.reason], { size: Math.round(PROFILE_PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)) })
            : t("settings.account.photoSaveFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      await clearProfilePhoto(userId);
      setStatus({ kind: "removed" });
    } catch {
      setStatus({ kind: "error", text: t("settings.account.photoRemoveFailed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {status ? (
        <span
          role="status"
          className={cn("text-[12px] font-normal", status.kind === "error" ? "text-tone-negative" : "text-content-tertiary")}
        >
          {status.kind === "error" ? status.text : t(PHOTO_STATUS[status.kind])}
        </span>
      ) : null}
      {photo ? (
        <button type="button" onClick={() => void remove()} disabled={busy} className={cn(BUTTON, "disabled:opacity-60")}>
          {t("settings.account.photoRemove")}
        </button>
      ) : null}
      <button type="button" onClick={pick} disabled={!userId || busy} className={cn(BUTTON, "disabled:opacity-60")}>
        {photo ? t("settings.account.photoReplace") : t("settings.account.photoUpload")}
      </button>
      <button
        type="button"
        onClick={pick}
        disabled={!userId || busy}
        title={photo ? t("settings.account.photoReplaceLabel") : t("settings.account.photoUpload")}
        className="app-no-drag group relative shrink-0 rounded-full disabled:pointer-events-none"
      >
        <Avatar name={name} size={40} photo={photo} />
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Camera className="h-4 w-4 text-white" strokeWidth={1.75} />
        </span>
        <span className="sr-only">
          {photo ? t("settings.account.photoReplaceLabel") : t("settings.account.photoUpload")}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept={PROFILE_PHOTO_INPUT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void onFile(e)}
      />
    </div>
  );
}

/**
 * Two presses, so a stray click cannot end every session the reader has: the
 * first turns the button into a confirmation, and it goes back by itself if
 * the reader looks away.
 */
function SignOutEverywhere({ run }: { run: () => Promise<void> }) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "error">("idle");
  useEffect(() => {
    if (phase !== "confirm" && phase !== "error") return;
    const t = setTimeout(() => setPhase("idle"), 6000);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "idle") {
    return (
      <button type="button" onClick={() => setPhase("confirm")} className={BUTTON}>
        {t("settings.account.logOut")}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {phase === "error" ? <span className="text-[12px] text-tone-negative">{t("settings.account.logOutFailed")}</span> : null}
      <button type="button" onClick={() => setPhase("idle")} disabled={phase === "working"} className={BUTTON}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        disabled={phase === "working"}
        onClick={() => {
          setPhase("working");
          run().catch(() => setPhase("error"));
        }}
        className="app-no-drag rounded-lg bg-tone-negative-solid px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-tone-negative-solid/90 disabled:opacity-60"
      >
        {phase === "working" ? t("settings.account.loggingOut") : t("settings.account.logOutEverywhere")}
      </button>
    </div>
  );
}

/**
 * Deleting is the one thing here that cannot be taken back, so it asks the
 * way signing out everywhere does (a second press), and the confirming press
 * names what it does. It does not time out while working: the site is
 * deleting the user, and a button that reset mid-way would invite a retry.
 */
function DeleteAccount({ run }: { run: () => Promise<void> }) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (phase !== "confirm") return;
    const timer = setTimeout(() => setPhase("idle"), 8000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "idle") {
    return (
      <button type="button" onClick={() => setPhase("confirm")} className={cn(BUTTON, "text-tone-negative")}>
        {t("settings.account.delete")}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {phase === "error" ? (
        <span className="max-w-[220px] truncate text-[12px] text-tone-negative" title={error ?? undefined}>
          {error ?? t("settings.account.deleteFailed")}
        </span>
      ) : null}
      <button type="button" onClick={() => setPhase("idle")} disabled={phase === "working"} className={BUTTON}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        disabled={phase === "working"}
        onClick={() => {
          setPhase("working");
          setError(null);
          run().catch((err: unknown) => {
            setError(err instanceof Error && err.message ? err.message : null);
            setPhase("error");
          });
        }}
        className="app-no-drag rounded-lg bg-tone-negative-solid px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-tone-negative-solid/90 disabled:opacity-60"
      >
        {phase === "working" ? t("settings.account.deleting") : t("settings.account.deleteConfirm")}
      </button>
    </div>
  );
}

export default function AccountPane({ user, actions = DEFAULT_ACTIONS }: { user: User | null; actions?: AccountActions }) {
  const t = useT();
  const email = user?.email ?? "";
  const fullName = displayNameFromUser(user?.user_metadata, email);
  const storedFullName = typeof user?.user_metadata?.full_name === "string" ? (user.user_metadata.full_name as string) : "";
  const callName = readCallName(user);
  const instructions = readInstructions(user);
  const signedIn = user !== null;

  const nameField = useSavedField(storedFullName, (v) => actions.save({ full_name: v }), true);
  const callField = useSavedField(callName, (v) => actions.save({ preferred_name: v }));
  const notesField = useSavedField(instructions, (v) => actions.save({ falcon_instructions: v.slice(0, INSTRUCTIONS_MAX) }));
  const firstWord = (nameField.draft.trim() || fullName).split(/\s+/)[0] ?? "";

  return (
    <>
      <SettingsSection title={t("settings.account.profile")}>
        {/* Said before a photo is picked too: where it is kept is worth knowing first. */}
        <SettingsRow label={t("settings.account.avatar")} description={t("settings.account.avatarPhoto")}>
          <AvatarControl userId={user?.id ?? null} name={nameField.draft.trim() || fullName} />
        </SettingsRow>

        <SettingsRow label={t("settings.account.fullName")}>
          <div className="flex items-center gap-3">
            <Status state={nameField.state} />
            <input
              type="text"
              aria-label={t("settings.account.fullName")}
              value={nameField.draft}
              disabled={!signedIn}
              onChange={(e) => nameField.setDraft(e.target.value)}
              onFocus={nameField.onFocus}
              onBlur={() => void nameField.onBlur()}
              onKeyDown={blurOnEnter}
              className={cn(FIELD, "h-9 w-56")}
            />
          </div>
        </SettingsRow>

        <SettingsRow label={t("settings.account.callName")}>
          <div className="flex items-center gap-3">
            <Status state={callField.state} />
            <input
              type="text"
              aria-label={t("settings.account.callName")}
              value={callField.draft}
              placeholder={firstWord}
              disabled={!signedIn}
              onChange={(e) => callField.setDraft(e.target.value)}
              onFocus={callField.onFocus}
              onBlur={() => void callField.onBlur()}
              onKeyDown={blurOnEnter}
              className={cn(FIELD, "h-9 w-56")}
            />
          </div>
        </SettingsRow>

        {/* A stacked row: the note needs the pane's width, not a control's. */}
        <div className="border-b border-black/[0.06] py-4">
          <div className="text-[13.5px] font-normal text-content-primary">{t("settings.account.instructions")}</div>
          <textarea
            aria-label={t("settings.account.instructions")}
            value={notesField.draft}
            maxLength={INSTRUCTIONS_MAX}
            rows={4}
            disabled={!signedIn}
            placeholder={t("settings.account.instructionsPlaceholder")}
            onChange={(e) => notesField.setDraft(e.target.value)}
            onFocus={notesField.onFocus}
            onBlur={() => void notesField.onBlur()}
            className={cn(FIELD, "mt-3 block w-full resize-none py-2.5 leading-relaxed")}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <Status state={notesField.state} />
            <span className="ml-auto font-['Geist_Mono'] text-[11px] text-content-tertiary">
              {notesField.draft.length}/{INSTRUCTIONS_MAX}
            </span>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.account.section")}>
        <SettingsRow label={t("settings.account.logOutAll")} description={t("settings.account.logOutAllDescription")}>
          <SignOutEverywhere run={actions.signOutEverywhere} />
        </SettingsRow>

        <SettingsRow label={t("settings.account.delete")} description={t("settings.account.deleteDescription")}>
          {signedIn ? (
            <DeleteAccount run={actions.deleteAccount ?? deleteAccount} />
          ) : (
            <button type="button" disabled className={cn(BUTTON, "text-content-tertiary opacity-70")}>
              {t("settings.account.delete")}
            </button>
          )}
        </SettingsRow>

        <SettingsRow label={t("settings.account.id")} className="border-b-0">
          {user ? <AccountId id={user.id} /> : <span className="text-[12.5px] text-content-tertiary">{t("settings.account.notSignedIn")}</span>}
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
