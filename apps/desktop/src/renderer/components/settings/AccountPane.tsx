import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Check, Copy } from "lucide-react";
import { Avatar } from "@/components/dashboard/ProfilePill";
import { cn } from "@/lib/utils";
import { displayNameFromUser } from "@/lib/greeting";
import {
  INSTRUCTIONS_MAX,
  readCallName,
  readInstructions,
  saveAccountFields,
  signOutEverywhere,
  type AccountFields,
} from "@/lib/user-preferences";
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
 * picks the change up and the greeting and the account pill follow.
 */

export type AccountActions = {
  save: (fields: AccountFields) => Promise<void>;
  signOutEverywhere: () => Promise<void>;
};

const DEFAULT_ACTIONS: AccountActions = { save: saveAccountFields, signOutEverywhere };

const FIELD =
  "app-no-drag rounded-xl border border-white/60 bg-white/55 px-3 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-[#9CA3AF] focus:bg-white/75 disabled:opacity-60";

const BUTTON =
  "app-no-drag rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none";

type SaveState = "idle" | "saving" | "saved" | "error" | "invalid";

const STATUS_TEXT: Record<Exclude<SaveState, "idle">, string> = {
  saving: "Saving",
  saved: "Saved",
  error: "Could not save",
  invalid: "A name is needed",
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
  if (state === "idle") return null;
  return (
    <span
      role="status"
      className={cn("text-[12px] font-normal", state === "error" || state === "invalid" ? "text-[#DC2626]" : "text-[#9CA3AF]")}
    >
      {STATUS_TEXT[state]}
    </span>
  );
}

/** Enter leaves a one-line field, which is what saves it. */
function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") e.currentTarget.blur();
}

function AccountId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => setCopied(true), () => undefined);
      }}
      className="app-no-drag group flex items-center gap-2 rounded-lg bg-black/[0.04] px-2.5 py-1 font-['Geist_Mono'] text-[12px] text-[#4b5563] transition-colors hover:bg-black/[0.06]"
    >
      <span data-selectable className="select-text">{id}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[#16A34A]" strokeWidth={2} aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5 text-[#9CA3AF] group-hover:text-[#4b5563]" strokeWidth={1.75} aria-hidden />
      )}
      <span className="sr-only">{copied ? "Copied" : "Copy account ID"}</span>
    </button>
  );
}

/**
 * Two presses, so a stray click cannot end every session the reader has: the
 * first turns the button into a confirmation, and it goes back by itself if
 * the reader looks away.
 */
function SignOutEverywhere({ run }: { run: () => Promise<void> }) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "error">("idle");
  useEffect(() => {
    if (phase !== "confirm" && phase !== "error") return;
    const t = setTimeout(() => setPhase("idle"), 6000);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "idle") {
    return (
      <button type="button" onClick={() => setPhase("confirm")} className={BUTTON}>
        Log out
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {phase === "error" ? <span className="text-[12px] text-[#DC2626]">Could not log out</span> : null}
      <button type="button" onClick={() => setPhase("idle")} disabled={phase === "working"} className={BUTTON}>
        Cancel
      </button>
      <button
        type="button"
        disabled={phase === "working"}
        onClick={() => {
          setPhase("working");
          run().catch(() => setPhase("error"));
        }}
        className="app-no-drag rounded-lg bg-[#DC2626] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#B91C1C] disabled:opacity-60"
      >
        {phase === "working" ? "Logging out" : "Log out everywhere"}
      </button>
    </div>
  );
}

export default function AccountPane({ user, actions = DEFAULT_ACTIONS }: { user: User | null; actions?: AccountActions }) {
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
      <SettingsSection title="Profile">
        <SettingsRow label="Avatar" description="Drawn from your name.">
          <Avatar name={nameField.draft.trim() || fullName} size={36} />
        </SettingsRow>

        <SettingsRow label="Full name">
          <div className="flex items-center gap-3">
            <Status state={nameField.state} />
            <input
              type="text"
              aria-label="Full name"
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

        <SettingsRow label="What should Falcon call you?">
          <div className="flex items-center gap-3">
            <Status state={callField.state} />
            <input
              type="text"
              aria-label="What should Falcon call you?"
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
          <div className="text-[13.5px] font-normal text-[#1d1b1b]">Instructions for Falcon</div>
          <p className="mt-1 text-[12.5px] font-normal leading-snug text-[#6b7280]">
            How you like Falcon to write for you: length, tone, what to flag first.
          </p>
          <textarea
            aria-label="Instructions for Falcon"
            value={notesField.draft}
            maxLength={INSTRUCTIONS_MAX}
            rows={4}
            disabled={!signedIn}
            placeholder="e.g. keep summaries short, flag earnings a week ahead"
            onChange={(e) => notesField.setDraft(e.target.value)}
            onFocus={notesField.onFocus}
            onBlur={() => void notesField.onBlur()}
            className={cn(FIELD, "mt-3 block w-full resize-none py-2.5 leading-relaxed")}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <Status state={notesField.state} />
            <span className="ml-auto font-['Geist_Mono'] text-[11px] text-[#9CA3AF]">
              {notesField.draft.length}/{INSTRUCTIONS_MAX}
            </span>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Account">
        <SettingsRow label="Log out of all devices" description="Ends every session this account has, this one included.">
          <SignOutEverywhere run={actions.signOutEverywhere} />
        </SettingsRow>

        <SettingsRow label="Deleting an account is not available in the app yet.">
          <button type="button" disabled className={cn(BUTTON, "text-[#9CA3AF] opacity-70")}>
            Delete account
          </button>
        </SettingsRow>

        <SettingsRow label="Account ID" className="border-b-0">
          {user ? <AccountId id={user.id} /> : <span className="text-[12.5px] text-[#9CA3AF]">Not signed in</span>}
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
