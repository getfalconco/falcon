import { useState } from "react";
import { Loader2 } from "lucide-react";
import { isWaitlistUser, setWaitlistFlag, updatePassword } from "@/lib/auth";
import { requireSupabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

const inputClass =
  "app-no-drag w-full border border-white/10 bg-transparent px-4 py-3 text-sm text-white outline-none transition placeholder:text-[#666666] focus:border-white/20";

type Props = {
  onSuccess: () => void;
  onWaitlist: () => void;
};

function authMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

export default function SetPasswordForm({ onSuccess, onWaitlist }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = password.length >= 8 && password === confirm;

  async function handleSubmit() {
    if (!canSubmit || loading) return;
    setError(null);
    setLoading(true);
    try {
      const client = requireSupabase();
      await updatePassword(client, password);
      const { data } = await client.auth.getUser();
      if (isWaitlistUser(data.user)) {
        await client.auth.signOut();
        setWaitlistFlag(true);
        onWaitlist();
        return;
      }
      setWaitlistFlag(false);
      onSuccess();
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">
          <header className="text-center">
            <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
              Set a new password
            </h1>
            <p className="mt-3 text-sm text-[#888888]">Choose a password with at least 8 characters.</p>
          </header>

          <form
            className="mt-8 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <input
              id="new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="New password"
              aria-label="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            <input
              id="confirm-password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm password"
              aria-label="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
            />

            {error ? <p className="text-center text-xs text-red-400">{error}</p> : null}
            {password && confirm && password !== confirm ? (
              <p className="text-center text-xs text-red-400">Passwords do not match.</p>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit || loading}
              className={cn(
                "app-no-drag flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                canSubmit && !loading
                  ? "border-white/10 bg-white text-black"
                  : "cursor-not-allowed border-white/[0.06] bg-[#2a2a2a] text-[#666666]",
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Save password
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
