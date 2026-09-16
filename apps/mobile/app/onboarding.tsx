import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type { User } from "@supabase/supabase-js";
import PrimaryButton from "@/components/PrimaryButton";
import { supabase } from "@/lib/supabase";
import { isApproved } from "@/lib/auth";
import { COUNTRIES } from "@/lib/countries";
import { submitOnboardingSurvey } from "@/lib/onboarding";
import {
  EXPERIENCE_OPTIONS,
  INVESTOR_ROLE_OPTIONS,
  RESEARCH_FOCUS_OPTIONS,
  SECTOR_LABELS,
  SECTOR_PREVIEWS,
} from "@/lib/onboarding-copy";
import type { InvestorRole, ResearchFocus } from "@/lib/onboarding-survey";
import {
  SECTOR_IDS,
  hasFullName,
  needsOnboarding,
  readPreferences,
  saveFullName,
  saveOnboardingProfile,
  type ExperienceLevel,
  type SectorId,
} from "@/lib/user-preferences";
import { COLORS, FONTS, SPACING, TYPE } from "@/theme";

type LinearStep = "intro" | "country" | "role" | "tenure" | "focus" | "sectors" | "heard_about";
const LINEAR_STEPS: LinearStep[] = [
  "intro",
  "country",
  "role",
  "tenure",
  "focus",
  "sectors",
  "heard_about",
];
const QUESTION_STEPS: LinearStep[] = LINEAR_STEPS.filter((s) => s !== "intro");
type Step = "checking" | "name" | LinearStep | "beat";

const SECTOR_BEAT_MS = 4800;

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

export default function OnboardingScreen() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [step, setStep] = useState<Step>("checking");
  const [fullName, setFullName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [investorRole, setInvestorRole] = useState<InvestorRole | null>(null);
  const [investorRoleOther, setInvestorRoleOther] = useState("");
  const [experience, setExperience] = useState<ExperienceLevel | null>(null);
  const [focus, setFocus] = useState<ResearchFocus | null>(null);
  const [sectors, setSectors] = useState<SectorId[]>([]);
  const [previewSector, setPreviewSector] = useState<SectorId | null>(null);
  const [country, setCountry] = useState("");
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");
  const [heardAbout, setHeardAbout] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q,
    );
  }, [countryQuery]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
      const next = data.session?.user ?? null;
      if (cancelled) return;
      setUser(next);
      if (!next || !isApproved(next) || !needsOnboarding(next)) {
        setStep("intro");
        return;
      }
      const prefs = readPreferences(next);
      setFullName(prefs.fullName);
      setNameInput(prefs.fullName);
      setExperience(prefs.experience);
      setSectors(prefs.sectors);
      setPreviewSector(prefs.sectors[0] ?? null);
      setStep(hasFullName(next) ? "intro" : "name");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step !== "beat") return;
    const timer = setTimeout(() => {
      void finishAfterBeat();
    }, SECTOR_BEAT_MS);
    return () => clearTimeout(timer);
    // finish once when the beat mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (step === "checking") {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <ActivityIndicator color={COLORS.faint} />
      </SafeAreaView>
    );
  }

  if (!user || !isApproved(user)) return <Redirect href="/status" />;
  if (!needsOnboarding(user) && step !== "beat") return <Redirect href="/dashboard" />;

  function goNext() {
    setError(null);
    setStep((s) => {
      const idx = LINEAR_STEPS.indexOf(s as LinearStep);
      if (idx === -1) return s;
      return idx + 1 < LINEAR_STEPS.length ? LINEAR_STEPS[idx + 1]! : "beat";
    });
  }

  function goBack() {
    if (step === "name" || loading) return;
    setError(null);
    if (step === "intro") {
      setStep("name");
      return;
    }
    if (step === "beat") {
      setStep(LINEAR_STEPS[LINEAR_STEPS.length - 1]!);
      return;
    }
    const idx = LINEAR_STEPS.indexOf(step as LinearStep);
    if (idx > 0) setStep(LINEAR_STEPS[idx - 1]!);
  }

  async function handleNameContinue() {
    const trimmed = nameInput.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      await saveFullName(trimmed);
      setFullName(trimmed);
      setStep("intro");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your name.");
    } finally {
      setLoading(false);
    }
  }

  function toggleSector(id: SectorId) {
    setSectors((current) => {
      if (current.includes(id)) {
        const next = current.filter((s) => s !== id);
        setPreviewSector((prev) => (prev === id ? next[next.length - 1] ?? null : prev));
        return next;
      }
      setPreviewSector(id);
      return [...current, id];
    });
  }

  async function finishAfterBeat() {
    if (!experience || sectors.length === 0 || !fullName.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      await saveOnboardingProfile({
        fullName: fullName.trim(),
        experience,
        sectors,
      });
      void submitOnboardingSurvey({
        fullName: fullName.trim(),
        investorRole,
        investorRoleOther: investorRole === "other" ? investorRoleOther.trim() || null : null,
        investingTenure: experience,
        researchFocus: focus,
        sectors,
        country: country.trim() || null,
        heardAbout: heardAbout.trim() || null,
      });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your preferences.");
      setStep(LINEAR_STEPS[LINEAR_STEPS.length - 1]!);
    } finally {
      setLoading(false);
    }
  }

  const experienceAck = EXPERIENCE_OPTIONS.find((o) => o.id === experience)?.acknowledgment;
  const beatCopy = previewSector ? SECTOR_PREVIEWS[previewSector] : null;
  const showChrome = step !== "name" && step !== "beat";
  const questionIndex = QUESTION_STEPS.indexOf(step as LinearStep) + 1;
  const selectedCountry = COUNTRIES.find((c) => c.name === country) ?? null;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {showChrome ? (
          <View style={styles.chrome}>
            <Pressable onPress={goBack} hitSlop={12} disabled={loading} accessibilityLabel="Back">
              <Text style={styles.back}>←</Text>
            </Pressable>
            {questionIndex > 0 ? (
              <Text style={styles.progress}>
                {questionIndex} / {QUESTION_STEPS.length}
              </Text>
            ) : (
              <View />
            )}
          </View>
        ) : (
          <View style={styles.chromeSpacer} />
        )}

        {step === "name" ? (
          <View style={styles.body}>
            <View style={styles.questionCenter}>
              <Text style={styles.title}>
                How should we{"\n"}call you?
              </Text>
              <TextInput
                autoFocus
                autoComplete="name"
                placeholder="Your name"
                placeholderTextColor={COLORS.faint}
                value={nameInput}
                onChangeText={setNameInput}
                onSubmitEditing={() => void handleNameContinue()}
                style={styles.underline}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
            <View style={styles.cta}>
              <PrimaryButton
                label={loading ? "Saving…" : "Continue"}
                onPress={() => void handleNameContinue()}
                disabled={!nameInput.trim() || loading}
              />
            </View>
          </View>
        ) : null}

        {step === "intro" ? (
          <View style={styles.body}>
            <View style={styles.questionCenter}>
              <Image
                source={require("../assets/falcon-mark.png")}
                style={styles.mark}
                accessibilityLabel="Falcon"
              />
              <Text style={styles.hero}>{firstName(fullName)}.</Text>
              <Text style={styles.blurb}>
                A few quick questions, then Falcon reads the market for you.
              </Text>
            </View>
            <View style={styles.cta}>
              <PrimaryButton label="Continue" onPress={goNext} />
            </View>
          </View>
        ) : null}

        {step === "country" ? (
          <View style={styles.body}>
            <View style={styles.questionCenter}>
              <Text style={styles.title}>
                Where are you{"\n"}based?
              </Text>
              <Pressable onPress={() => setCountryOpen(true)} style={styles.countryField}>
                <Text style={[styles.countryValue, !selectedCountry && styles.placeholder]}>
                  {selectedCountry
                    ? `${selectedCountry.flag}  ${selectedCountry.name}`
                    : "Select your country"}
                </Text>
                <Feather name="chevron-down" size={16} color={COLORS.faint} />
              </Pressable>
            </View>
            <View style={styles.cta}>
              <PrimaryButton label="Continue" onPress={goNext} disabled={!country} />
              {!country ? (
                <Pressable onPress={goNext} hitSlop={8}>
                  <Text style={styles.skip}>Skip for now</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {step === "role" ? (
          <View style={styles.body}>
            <Text style={styles.title}>
              How would you{"\n"}describe yourself?
            </Text>
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            >
              {INVESTOR_ROLE_OPTIONS.map((option) => (
                <OptionCard
                  key={option.id}
                  selected={investorRole === option.id}
                  title={option.label}
                  subtitle={option.subtitle}
                  onPress={() => setInvestorRole(option.id)}
                />
              ))}
              {investorRole === "other" ? (
                <TextInput
                  autoFocus
                  placeholder="Tell us in a few words"
                  placeholderTextColor={COLORS.faint}
                  value={investorRoleOther}
                  onChangeText={setInvestorRoleOther}
                  style={[styles.underline, { marginTop: 8 }]}
                />
              ) : null}
            </ScrollView>
            <View style={styles.cta}>
              <PrimaryButton
                label="Continue"
                onPress={goNext}
                disabled={!investorRole || (investorRole === "other" && !investorRoleOther.trim())}
              />
            </View>
          </View>
        ) : null}

        {step === "tenure" ? (
          <View style={styles.body}>
            <Text style={styles.title}>
              How long have you{"\n"}been investing?
            </Text>
            <Text style={styles.blurb}>This sets how much we explain, and how much we skip.</Text>
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            >
              {EXPERIENCE_OPTIONS.map((option) => (
                <OptionCard
                  key={option.id}
                  selected={experience === option.id}
                  title={option.label}
                  onPress={() => setExperience(option.id)}
                />
              ))}
              {experienceAck ? <Text style={styles.ack}>{experienceAck}</Text> : null}
            </ScrollView>
            <View style={styles.cta}>
              <PrimaryButton label="Continue" onPress={goNext} disabled={!experience} />
            </View>
          </View>
        ) : null}

        {step === "focus" ? (
          <View style={styles.body}>
            <Text style={styles.title}>What&apos;s your primary focus?</Text>
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            >
              {RESEARCH_FOCUS_OPTIONS.map((option) => (
                <OptionCard
                  key={option.id}
                  selected={focus === option.id}
                  title={option.label}
                  onPress={() => setFocus(option.id)}
                />
              ))}
            </ScrollView>
            <View style={styles.cta}>
              <PrimaryButton label="Continue" onPress={goNext} disabled={!focus} />
            </View>
          </View>
        ) : null}

        {step === "sectors" ? (
          <View style={styles.body}>
            <Text style={styles.title}>What do you follow?</Text>
            <Text style={styles.blurb}>Pick a few. This shapes what Falcon surfaces first.</Text>
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.chips}
              showsVerticalScrollIndicator={false}
            >
              {SECTOR_IDS.map((id) => {
                const selected = sectors.includes(id);
                return (
                  <Pressable
                    key={id}
                    onPress={() => toggleSector(id)}
                    style={[styles.chip, selected && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextOn]}>
                      {SECTOR_LABELS[id]}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.cta}>
              <PrimaryButton
                label="Continue"
                onPress={goNext}
                disabled={sectors.length === 0 || loading}
              />
            </View>
          </View>
        ) : null}

        {step === "heard_about" ? (
          <View style={styles.body}>
            <View style={styles.questionCenter}>
              <Text style={styles.title}>
                How did you hear{"\n"}about Falcon?
              </Text>
              <TextInput
                autoFocus
                placeholder="Twitter, a friend, a newsletter…"
                placeholderTextColor={COLORS.faint}
                value={heardAbout}
                onChangeText={setHeardAbout}
                onSubmitEditing={goNext}
                style={styles.underline}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
            <View style={styles.cta}>
              <PrimaryButton label="Finish" onPress={goNext} disabled={loading} />
              {!heardAbout.trim() ? (
                <Pressable onPress={goNext} hitSlop={8}>
                  <Text style={styles.skip}>Skip for now</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {step === "beat" ? (
          <Pressable
            style={styles.beat}
            onPress={() => void finishAfterBeat()}
            accessibilityRole="button"
            accessibilityLabel="Continue to dashboard"
          >
            <Animated.View entering={FadeIn.duration(400)} exiting={FadeOut}>
              <Text style={styles.beatCopy}>
                {beatCopy ?? "This is the kind of move Falcon traces for you."}
              </Text>
              <Text style={styles.beatHint}>Preparing your dashboard…</Text>
              {loading ? <ActivityIndicator color={COLORS.faint} style={{ marginTop: 24 }} /> : null}
            </Animated.View>
          </Pressable>
        ) : null}
      </KeyboardAvoidingView>

      <Modal visible={countryOpen} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Select your country</Text>
            <Pressable
              onPress={() => {
                setCountryOpen(false);
                setCountryQuery("");
              }}
              hitSlop={10}
            >
              <Text style={styles.skip}>Close</Text>
            </Pressable>
          </View>
          <TextInput
            autoFocus
            placeholder="Search…"
            placeholderTextColor={COLORS.faint}
            value={countryQuery}
            onChangeText={setCountryQuery}
            style={[styles.underline, { marginHorizontal: SPACING.lg }]}
          />
          <FlatList
            data={filteredCountries}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingVertical: SPACING.md }}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  setCountry(item.name);
                  setCountryOpen(false);
                  setCountryQuery("");
                }}
                style={styles.countryRow}
              >
                <Text style={styles.countryRowText}>
                  {item.flag}  {item.name}
                </Text>
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function OptionCard({
  selected,
  title,
  subtitle,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.option, selected && styles.optionOn]}>
      <Text style={[styles.optionTitle, selected && styles.optionTitleOn]}>{title}</Text>
      {subtitle ? <Text style={styles.optionSub}>{subtitle}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  chrome: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    minHeight: 36,
  },
  chromeSpacer: { minHeight: 36 },
  back: { fontFamily: FONTS.sans, fontSize: 22, color: COLORS.faint },
  progress: {
    fontFamily: FONTS.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    color: COLORS.faint,
    textTransform: "uppercase",
  },
  body: {
    flex: 1,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
  },
  questionCenter: { flex: 1, justifyContent: "center" },
  mark: {
    width: 40,
    height: 40,
    alignSelf: "center",
    marginBottom: SPACING.lg,
  },
  title: { ...TYPE.title, textAlign: "center" },
  hero: { ...TYPE.hero, textAlign: "center" },
  blurb: { ...TYPE.bodySmall, textAlign: "center", marginTop: SPACING.md },
  underline: {
    marginTop: SPACING.xl,
    fontFamily: FONTS.sans,
    fontSize: 16,
    color: COLORS.ink,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  countryField: {
    marginTop: SPACING.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingVertical: 12,
  },
  countryValue: { fontFamily: FONTS.sans, fontSize: 16, color: COLORS.ink, flex: 1 },
  placeholder: { color: COLORS.faint },
  list: { flex: 1, marginTop: SPACING.lg },
  listContent: { marginTop: SPACING.lg, gap: 8, paddingBottom: SPACING.md },
  option: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#fff",
  },
  optionOn: {
    borderColor: COLORS.ink,
    borderWidth: 1.5,
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  optionTitle: { fontFamily: FONTS.sansMedium, fontSize: 15, color: COLORS.ink },
  optionTitleOn: { color: COLORS.ink },
  optionSub: { fontFamily: FONTS.sans, fontSize: 12, color: COLORS.muted, marginTop: 2 },
  ack: {
    ...TYPE.bodySmall,
    textAlign: "center",
    marginTop: SPACING.md,
    minHeight: 42,
  },
  ackSlot: { minHeight: 42, marginTop: SPACING.md },
  chips: {
    marginTop: SPACING.xl,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipOn: { borderColor: COLORS.borderStrong, backgroundColor: "rgba(0,0,0,0.04)" },
  chipText: { fontFamily: FONTS.sans, fontSize: 14, color: COLORS.muted },
  chipTextOn: { color: COLORS.ink },
  cta: { paddingBottom: SPACING.md, gap: SPACING.sm },
  skip: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: COLORS.faint,
    textAlign: "center",
    paddingVertical: 8,
  },
  error: { fontFamily: FONTS.sans, fontSize: 13, color: COLORS.error, textAlign: "center", marginTop: 12 },
  beat: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
  },
  beatCopy: { ...TYPE.sectionTitle, textAlign: "center" },
  beatHint: { ...TYPE.bodySmall, textAlign: "center", marginTop: SPACING.md },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  modalTitle: { ...TYPE.sectionTitle },
  countryRow: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  countryRowText: { fontFamily: FONTS.sans, fontSize: 16, color: COLORS.ink },
});
