import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isWaitlistUser, readWaitlistFlag, setWaitlistEmail, setWaitlistFlag } from "@/lib/auth";
import { displayNameFromUser } from "@/lib/greeting";
import { setActivePaperUser } from "@/lib/paper-account";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { needsOnboarding } from "@/lib/user-preferences";
import HomePage from "@/pages/HomePage";
import LoginPage, { type LoginPageMode } from "@/pages/LoginPage";

function resolveSession(nextSession: Session | null): {
  session: Session | null;
  showWaitlist: boolean;
} {
  // Hand the main process what it needs to act on this user's behalf: the
  // public anon key and the user's own token (null on sign-out). Runs on every
  // auth event, so token refreshes propagate too. Never a privileged key.
  void window.meridian?.setSession({
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? null,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? null,
    accessToken: nextSession?.access_token ?? null,
  });

  if (nextSession && isWaitlistUser(nextSession.user)) {
    setWaitlistFlag(true);
    if (nextSession.user.email) setWaitlistEmail(nextSession.user.email);
    void supabase?.auth.signOut();
    setActivePaperUser(null);
    return { session: null, showWaitlist: true };
  }

  if (nextSession) {
    setWaitlistFlag(false);
    // Scope paper-portfolio storage to this user BEFORE the workspace mounts,
    // so switching accounts never shows someone else's holdings.
    setActivePaperUser(nextSession.user.id);
    return { session: nextSession, showWaitlist: false };
  }

  setActivePaperUser(null);
  return { session: null, showWaitlist: readWaitlistFlag() };
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [showWaitlist, setShowWaitlist] = useState(readWaitlistFlag);
  const [ready, setReady] = useState(!isSupabaseConfigured);

  const handleSignOut = useCallback(async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setSession(null);
    setShowWaitlist(false);
    setWaitlistFlag(false);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      const resolved = resolveSession(data.session);
      setSession(resolved.session);
      setShowWaitlist(resolved.showWaitlist);
      setReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const resolved = resolveSession(nextSession);
      setSession(resolved.session);
      setShowWaitlist(resolved.showWaitlist);
    });

    return () => subscription.unsubscribe();
  }, []);

  function refreshSession() {
    void supabase?.auth.getSession().then(({ data }) => {
      const resolved = resolveSession(data.session);
      setSession(resolved.session);
      setShowWaitlist(resolved.showWaitlist);
    });
  }

  if (!ready) {
    return <div className="flex h-full items-center justify-center rounded-lg bg-background" />;
  }

  if (session && !showWaitlist && !needsOnboarding(session.user)) {
    const userName = displayNameFromUser(
      session.user.user_metadata,
      session.user.email ?? "",
    );

    return (
      <HomePage
        userName={userName}
        userEmail={session.user.email ?? undefined}
        skipGreeting
        onSignOut={handleSignOut}
      />
    );
  }

  let loginMode: LoginPageMode = "login";
  if (showWaitlist) {
    loginMode = "waitlist";
  } else if (session && needsOnboarding(session.user)) {
    loginMode = "onboarding";
  }

  function handleWaitlist() {
    setWaitlistFlag(true);
    setShowWaitlist(true);
    setSession(null);
  }

  return (
    <LoginPage
      mode={loginMode}
      user={session?.user ?? null}
      onSuccess={refreshSession}
      onWaitlist={handleWaitlist}
      onProfileComplete={refreshSession}
    />
  );
}
