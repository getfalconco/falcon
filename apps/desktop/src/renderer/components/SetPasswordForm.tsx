import { useState } from "react";
import { Loader2 } from "lucide-react";
import { isWaitlistUser, setWaitlistFlag, updatePassword } from "@/lib/auth";
import { requireSupabase } from "@/lib/supabase";
import { primeWaitlistMembership } from "@/lib/waitlist-api";
import { authErrorKey } from "@/lib/auth-errors";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { authCtaClass } from "@/components/auth-cta";

const inputClass =
  "app-no-drag w-full border border-white/10 bg-transparent px-4 py-3 text-sm text-white outline-none transition placeholder:text-[#666666] focus:border-white/20";

type Props = {
  onSuccess: () => void;
  onWaitlist: () => void;
};

export default function SetPasswordForm({ onSuccess, onWaitlist }: Props) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

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
        await primeWaitlistMembership();
        await client.auth.signOut();
        setWaitlistFlag(true);
        onWaitlist();
        return;
      }
      setWaitlistFlag(false);
      onSuccess();
    } catch (err) {
      setError(authErrorKey(err));
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
              {t("auth.setPassword.title")}
            </h1>
            <p className="mt-3 text-balance text-sm text-[#888888] [word-break:auto-phrase]">{t("auth.setPassword.subtitle")}</p>
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
              placeholder={t("auth.setPassword.new")}
              aria-label={t("auth.setPassword.new")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            <input
              id="confirm-password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              placeholder={t("auth.setPassword.confirm")}
              aria-label={t("auth.setPassword.confirm")}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
            />

            {error ? (
              <p role="alert" className="text-center text-xs text-red-400">
                {t(error)}
              </p>
            ) : null}
            {password && confirm && password !== confirm ? (
              <p className="text-center text-xs text-red-400">{t("auth.setPassword.mismatch")}</p>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit || loading}
              aria-busy={loading || undefined}
              className={cn(
                "app-no-drag flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                authCtaClass(canSubmit && !loading),
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t("auth.setPassword.save")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
