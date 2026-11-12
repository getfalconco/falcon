import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, Platform, StyleSheet, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { Group, GroupLabel, Row } from "@/components/List";
import { Reveal } from "@/components/Reveal";
import { TabScreen } from "@/components/TabScreen";
import { disableMorningAlert, enableMorningAlert, useMorningAlert } from "@/lib/alerts";
import { haptics } from "@/lib/haptics";
import { clearHoldings } from "@/lib/holdings";
import { useLanguage } from "@/lib/language";
import { MORNING_HOUR, alertPermission, type AlertPermission } from "@/lib/notifications";
import { getSupabase } from "@/lib/supabase";
import { openLink } from "@/features/sightings/Evidence";
import { ScreenTitle } from "@/features/sightings/parts";
import { colors, fonts } from "@/theme";

const PRIVACY_URL = "https://getfalcon.co/privacy";
const TERMS_URL = "https://getfalcon.co/terms";

/** "8:00 AM" on the phone's clock style. */
function morningTime(): string {
  const d = new Date();
  d.setHours(MORNING_HOUR, 0, 0, 0);
  try {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return `${MORNING_HOUR}:00`;
  }
}

function versionLine(): string {
  const version = Constants.expoConfig?.version ?? "1.0.0";
  const build = Platform.OS === "ios" ? Constants.expoConfig?.ios?.buildNumber : undefined;
  return build ? `Version ${version} (${build})` : `Version ${version}`;
}

/** Asks before signing out: the system alert on the phone, the browser's confirm in the preview. */
function confirmSignOut(): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(typeof window === "undefined" || window.confirm("Sign out of Falcon?"));
  }
  return new Promise((resolve) => {
    Alert.alert("Sign out of Falcon?", undefined, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Sign out", style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}

function useSessionEmail(): { email: string | null; ready: boolean } {
  const [state, setState] = useState<{ email: string | null; ready: boolean }>({ email: null, ready: false });
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setState({ email: null, ready: true });
      return;
    }
    let live = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (live) setState({ email: data.session?.user.email ?? null, ready: true });
      })
      .catch(() => {
        if (live) setState({ email: null, ready: true });
      });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live) setState({ email: session?.user.email ?? null, ready: true });
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);
  return state;
}

/** The notification permission, read again whenever the app comes back (from Settings). */
function usePermission(): [AlertPermission | null, () => Promise<void>] {
  const [permission, setPermission] = useState<AlertPermission | null>(null);
  const read = useCallback(async () => setPermission(await alertPermission()), []);
  useEffect(() => {
    void read();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void read();
    });
    return () => sub.remove();
  }, [read]);
  return [permission, read];
}

/** You: the account, language, the morning alert, the legal pages and signing out. */
export default function You() {
  const router = useRouter();
  const language = useLanguage();
  const session = useSessionEmail();
  const morning = useMorningAlert();
  const [permission, readPermission] = usePermission();
  const [busy, setBusy] = useState(false);

  const blocked = permission?.status === "denied" && !permission.canAsk;
  const unsupported = permission?.status === "unsupported";
  const alertOn = morning === true && permission?.status === "granted";

  const toggleAlert = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    haptics.select();
    try {
      if (next) {
        if (!(await enableMorningAlert())) haptics.error();
      } else {
        await disableMorningAlert();
      }
      await readPermission();
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    haptics.select();
    if (!(await confirmSignOut())) return;
    try {
      await getSupabase()?.auth.signOut({ scope: "local" });
    } catch {
      // The local session is dropped either way.
    }
    clearHoldings();
    await disableMorningAlert();
    router.replace("/");
  };

  return (
    <TabScreen>
      <Reveal order={0}>
        <ScreenTitle title="You" />
      </Reveal>

      <Reveal order={1} style={styles.section}>
        <GroupLabel>Account</GroupLabel>
        <Group>
          {session.email ? (
            <Row title="Email" value={session.email} />
          ) : (
            <Row
              title={session.ready ? "Sign in" : "Email"}
              onPress={session.ready ? () => router.push("/sign-in") : undefined}
            />
          )}
        </Group>
      </Reveal>

      <Reveal order={2} style={styles.section}>
        <GroupLabel>Preferences</GroupLabel>
        <Group>
          <Row
            title="Language"
            value={language.label}
            onPress={() => {
              haptics.select();
              router.push("/language");
            }}
          />
          {blocked ? (
            <Row
              title="Morning alert"
              value="Off in Settings"
              onPress={Platform.OS === "web" ? undefined : () => void Linking.openSettings().catch(() => {})}
            />
          ) : (
            <Row
              title="Morning alert"
              value={alertOn ? morningTime() : undefined}
              accessory={
                <Switch
                  value={alertOn}
                  disabled={busy || unsupported || permission === null || morning === undefined}
                  onValueChange={(next) => void toggleAlert(next)}
                  trackColor={{ false: "#e4e3e0", true: colors.primary }}
                  thumbColor="#ffffff"
                  ios_backgroundColor="#e4e3e0"
                  accessibilityLabel="Morning alert"
                />
              }
            />
          )}
        </Group>
      </Reveal>

      <Reveal order={3} style={styles.section}>
        <GroupLabel>Legal</GroupLabel>
        <Group>
          <Row title="Privacy Policy" onPress={() => openLink(PRIVACY_URL)} />
          <Row title="Terms of Service" onPress={() => openLink(TERMS_URL)} />
        </Group>
      </Reveal>

      {session.email ? (
        <Reveal order={4} style={styles.section}>
          <Group>
            <Row title="Sign out" tone="destructive" chevron={false} onPress={() => void signOut()} />
          </Group>
        </Reveal>
      ) : null}

      <Reveal order={5}>
        <Text style={styles.version}>{versionLine()}</Text>
      </Reveal>
      <View style={styles.bottom} />
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 30 },
  version: {
    marginTop: 36,
    textAlign: "center",
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.placeholder,
  },
  bottom: { height: 8 },
});
