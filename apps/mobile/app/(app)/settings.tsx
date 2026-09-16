import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import type { User } from "@supabase/supabase-js";
import {
  EmptyState,
  ErrorState,
  Loading,
  MicroLabel,
  Panel,
  PrimaryPill,
  QuietButton,
  Screen,
  useNavClearance,
} from "@/components/product-ui";
import PressableScale from "@/components/PressableScale";
import {
  deleteAccount,
  requestEmailChange,
  signOut,
  updatePassword,
  verifyEmailOtp,
} from "@/lib/auth";
import { requireSupabase } from "@/lib/supabase";
import {
  EXPERIENCE_OPTIONS,
  FORMAT_OPTIONS,
  SECTOR_IDS,
  SECTOR_LABELS,
  readPreferences,
  savePreferences,
  type ExperienceLevel,
  type SectorId,
  type SignalFormat,
} from "@/lib/user-preferences";
import { CARD, PRODUCT, PTYPE, RADIUS } from "@/theme";

function passwordHint(password: string): string | null {
  if (password.length < 6) return "At least 6 characters.";
  if (!/[A-Z]/.test(password)) return "Include an uppercase letter.";
  if (!/[a-z]/.test(password)) return "Include a lowercase letter.";
  if (!/\d/.test(password)) return "Include a number.";
  return null;
}

export default function SettingsScreen() {
  const router = useRouter();
  const navClearance = useNavClearance();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [experience, setExperience] = useState<ExperienceLevel | null>(null);
  const [sectors, setSectors] = useState<SectorId[]>([]);
  const [signalFormat, setSignalFormat] = useState<SignalFormat | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [emailStep, setEmailStep] = useState<"idle" | "otp">("idle");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await requireSupabase().auth.getUser();
      const next = data.user;
      setUser(next);
      if (next) {
        const prefs = readPreferences(next);
        setFullName(prefs.fullName);
        setExperience(prefs.experience);
        setSectors(prefs.sectors);
        setSignalFormat(prefs.signalFormat);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleSector(id: SectorId) {
    setSectors((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id],
    );
    setSaved(false);
  }

  async function handleSave() {
    if (!experience || !signalFormat || sectors.length === 0 || !fullName.trim() || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await savePreferences({
        fullName: fullName.trim(),
        experience,
        sectors,
        signalFormat,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRequestEmailChange() {
    const trimmed = newEmail.trim();
    if (!trimmed || emailBusy) return;
    setEmailBusy(true);
    setError(null);
    setEmailMessage(null);
    try {
      await requestEmailChange(trimmed);
      setEmailStep("otp");
      setEmailMessage("Enter the code sent to your new email.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change email.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleVerifyEmailChange() {
    if (emailOtp.trim().length < 6 || emailBusy) return;
    setEmailBusy(true);
    setError(null);
    setEmailMessage(null);
    try {
      await verifyEmailOtp(newEmail.trim(), emailOtp.trim(), "email_change");
      const { data } = await requireSupabase().auth.getUser();
      setUser(data.user);
      setNewEmail("");
      setEmailOtp("");
      setEmailStep("idle");
      setEmailMessage("Email updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handlePassword() {
    const hint = passwordHint(password);
    if (hint) {
      setPasswordMessage(hint);
      return;
    }
    if (password !== passwordConfirm) {
      setPasswordMessage("Passwords don't match.");
      return;
    }
    if (passwordBusy) return;
    setPasswordBusy(true);
    setError(null);
    setPasswordMessage(null);
    try {
      await updatePassword(password);
      setPassword("");
      setPasswordConfirm("");
      setPasswordMessage("Password updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password.");
    } finally {
      setPasswordBusy(false);
    }
  }

  function handleDelete() {
    if (deleteConfirm.trim() !== "DELETE" || deleting) return;
    Alert.alert(
      "Delete account",
      "This permanently removes your Falcon account. You will be signed out.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setDeleting(true);
              setError(null);
              try {
                await deleteAccount();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not delete the account.");
                setDeleting(false);
              }
            })();
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (error && !user) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => void load()} />
      </Screen>
    );
  }

  if (!user) {
    return (
      <Screen>
        <EmptyState title="Sign in" body="Sign in to edit account settings." />
      </Screen>
    );
  }

  const canSave =
    Boolean(fullName.trim()) && Boolean(experience) && Boolean(signalFormat) && sectors.length > 0;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: navClearance }]}
        scrollIndicatorInsets={{ bottom: navClearance }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={PTYPE.greeting}>Settings</Text>
        <Text style={styles.caption}>How Falcon reads the market for you.</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          onPress={() => router.push("/brokers")}
          style={({ pressed }) => [styles.drill, pressed && styles.pressed]}
        >
          <View>
            <MicroLabel>Brokers</MicroLabel>
            <Text style={styles.drillBody}>Paper and live accounts</Text>
          </View>
          <Feather name="chevron-right" size={16} color={PRODUCT.fgFaint} />
        </Pressable>

        <Panel style={styles.panel}>
          <MicroLabel>Account</MicroLabel>
          <Text style={styles.email}>{user.email}</Text>

          {emailStep === "idle" ? (
            <>
              <TextInput
                value={newEmail}
                onChangeText={(v) => {
                  setNewEmail(v);
                  setEmailMessage(null);
                }}
                placeholder="New email address"
                placeholderTextColor={PRODUCT.fgSubtle}
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
              />
              <Pressable
                onPress={() => void handleRequestEmailChange()}
                disabled={!newEmail.trim() || emailBusy}
                style={({ pressed }) => [
                  styles.btnGhost,
                  (!newEmail.trim() || emailBusy) && styles.btnOff,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.btnGhostText}>
                  {emailBusy ? "Sending…" : "Change email"}
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.note}>Code sent to {newEmail.trim()}</Text>
              <TextInput
                value={emailOtp}
                onChangeText={(v) => setEmailOtp(v.replace(/\D/g, "").slice(0, 8))}
                placeholder="00000000"
                placeholderTextColor={PRODUCT.fgSubtle}
                keyboardType="number-pad"
                maxLength={8}
                style={styles.input}
              />
              <View style={styles.row}>
                <PressableScale
                  onPress={() => void handleVerifyEmailChange()}
                  disabled={emailOtp.trim().length < 8 || emailBusy}
                  style={[
                    styles.btnFill,
                    styles.rowBtn,
                    (emailOtp.trim().length < 8 || emailBusy) && styles.btnOff,
                  ]}
                  pressedStyle={styles.pressed}
                >
                  <Text style={styles.btnFillText}>{emailBusy ? "…" : "Verify"}</Text>
                </PressableScale>
                <Pressable
                  onPress={() => {
                    setEmailStep("idle");
                    setEmailOtp("");
                    setEmailMessage(null);
                  }}
                  style={styles.btnGhost}
                >
                  <Text style={styles.btnGhostText}>Cancel</Text>
                </Pressable>
              </View>
            </>
          )}
          {emailMessage ? <Text style={styles.note}>{emailMessage}</Text> : null}
        </Panel>

        <Panel style={styles.panel}>
          <MicroLabel>Password</MicroLabel>
          <TextInput
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              setPasswordMessage(null);
            }}
            placeholder="New password"
            placeholderTextColor={PRODUCT.fgSubtle}
            secureTextEntry
            style={styles.input}
          />
          <TextInput
            value={passwordConfirm}
            onChangeText={(v) => {
              setPasswordConfirm(v);
              setPasswordMessage(null);
            }}
            placeholder="Confirm password"
            placeholderTextColor={PRODUCT.fgSubtle}
            secureTextEntry
            style={styles.input}
          />
          <Pressable
            onPress={() => void handlePassword()}
            disabled={passwordBusy || !password}
            style={({ pressed }) => [
              styles.btnGhost,
              (passwordBusy || !password) && styles.btnOff,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.btnGhostText}>
              {passwordBusy ? "Saving…" : "Change password"}
            </Text>
          </Pressable>
          {passwordMessage ? <Text style={styles.note}>{passwordMessage}</Text> : null}
        </Panel>

        <Panel style={styles.panel}>
          <MicroLabel>Name</MicroLabel>
          <TextInput
            value={fullName}
            onChangeText={(v) => {
              setFullName(v);
              setSaved(false);
            }}
            placeholder="Your name"
            placeholderTextColor={PRODUCT.fgSubtle}
            style={styles.input}
          />
        </Panel>

        <Panel style={styles.panel}>
          <MicroLabel>Experience</MicroLabel>
          <View style={styles.choices}>
            {EXPERIENCE_OPTIONS.map((option) => {
              const active = experience === option.id;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => {
                    setExperience(option.id);
                    setSaved(false);
                  }}
                  style={[styles.choice, active && styles.choiceOn]}
                >
                  <Text style={[styles.choiceText, active && styles.choiceTextOn]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Panel>

        <Panel style={styles.panel}>
          <MicroLabel>Sectors</MicroLabel>
          <View style={styles.chips}>
            {SECTOR_IDS.map((id) => {
              const active = sectors.includes(id);
              return (
                <Pressable
                  key={id}
                  onPress={() => toggleSector(id)}
                  style={[styles.chip, active && styles.chipOn]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextOn]}>
                    {SECTOR_LABELS[id]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Panel>

        <Panel style={styles.panel}>
          <MicroLabel>Signal format</MicroLabel>
          <View style={styles.choices}>
            {FORMAT_OPTIONS.map((option) => {
              const active = signalFormat === option.id;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => {
                    setSignalFormat(option.id);
                    setSaved(false);
                  }}
                  style={[styles.choice, active && styles.choiceOn]}
                >
                  <Text style={[styles.choiceText, active && styles.choiceTextOn]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Panel>

        {saved ? <Text style={styles.note}>Saved.</Text> : null}

        <PrimaryPill
          label={saving ? "Saving…" : "Save preferences"}
          onPress={() => void handleSave()}
          disabled={!canSave || saving}
        />

        <QuietButton label="Sign out" onPress={() => void signOut()} />

        <Panel style={[styles.panel, styles.deletePanel]}>
          <MicroLabel>Delete account</MicroLabel>
          <Text style={styles.body}>
            Permanently removes this Falcon account. Type DELETE to confirm.
          </Text>
          <TextInput
            value={deleteConfirm}
            onChangeText={setDeleteConfirm}
            placeholder="DELETE"
            placeholderTextColor={PRODUCT.fgSubtle}
            autoCapitalize="characters"
            style={styles.input}
          />
          <Pressable
            onPress={handleDelete}
            disabled={deleteConfirm.trim() !== "DELETE" || deleting}
            style={({ pressed }) => [
              styles.btnDanger,
              (deleteConfirm.trim() !== "DELETE" || deleting) && styles.btnOff,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.btnDangerText}>{deleting ? "Deleting…" : "Delete account"}</Text>
          </Pressable>
        </Panel>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 20, paddingTop: 12, gap: 14 },
  caption: { ...PTYPE.small, marginTop: -4 },
  drill: {
    ...CARD,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  drillBody: { ...PTYPE.body, marginTop: 4 },
  panel: { gap: 10 },
  email: { ...PTYPE.body, marginTop: 4 },
  body: { ...PTYPE.small },
  note: { ...PTYPE.small },
  error: { ...PTYPE.small, color: PRODUCT.loss },
  input: {
    fontFamily: PTYPE.body.fontFamily,
    fontSize: 15,
    color: PRODUCT.fg,
    backgroundColor: PRODUCT.card,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  deletePanel: { marginTop: 24 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  rowBtn: { flex: 1 },
  choices: { gap: 8 },
  choice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  choiceOn: {
    backgroundColor: PRODUCT.pill,
    borderColor: PRODUCT.pill,
  },
  choiceText: { ...PTYPE.body, color: PRODUCT.fgMuted },
  choiceTextOn: { color: PRODUCT.pillFg },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipOn: {
    backgroundColor: PRODUCT.pill,
    borderColor: PRODUCT.pill,
  },
  chipText: { ...PTYPE.tag, color: PRODUCT.fgMuted },
  chipTextOn: { color: PRODUCT.pillFg },
  btnFill: {
    height: 48,
    borderRadius: 12,
    backgroundColor: PRODUCT.ctaBg,
    alignItems: "center",
    justifyContent: "center",
  },
  btnFillText: {
    fontFamily: PTYPE.ticker.fontFamily,
    fontSize: 14,
    color: PRODUCT.ctaFg,
  },
  btnGhost: {
    height: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  btnGhostText: {
    fontFamily: PTYPE.ticker.fontFamily,
    fontSize: 14,
    color: PRODUCT.fg,
  },
  btnDanger: {
    height: 44,
    borderRadius: 12,
    backgroundColor: PRODUCT.loss,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDangerText: {
    fontFamily: PTYPE.ticker.fontFamily,
    fontSize: 14,
    color: "#fff",
  },
  btnOff: { opacity: 0.4 },
  pressed: { opacity: 0.85 },
});
