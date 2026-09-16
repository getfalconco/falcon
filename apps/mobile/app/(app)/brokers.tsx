/**
 * Brokers drill-in from Settings.
 *
 * Falcon paper and SnapTrade live accounts share desktop's Supabase rows.
 * Connecting a live broker opens SnapTrade's portal in the system browser
 * (same as desktop's shell.openExternal). Returning to the app refreshes
 * status. A dedicated SnapTrade redirect allow-list for `falcon://` is the
 * remaining OAuth gap if the portal does not bounce back automatically.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import * as ExpoLinking from "expo-linking";
import { Feather } from "@expo/vector-icons";
import {
  EmptyState,
  Loading,
  MicroLabel,
  Panel,
  Screen,
  Tag,
  useNavClearance,
} from "@/components/product-ui";
import PressableScale from "@/components/PressableScale";
import {
  createPaperAccount,
  isComputeEnabled,
  liveCatalogEmptyCopy,
  liveEngineHint,
  loadBrokerCatalog,
  loadBrokers,
  removeLiveBrokerage,
  startLiveConnect,
  syncLiveBrokerages,
  type BrokerageCatalogItem,
  type BrokerageNetWorth,
  type PaperAccount,
} from "@/lib/brokers";
import { errorFromUnknown } from "@/lib/api";
import type { FalconError } from "@/lib/errors";
import { reportClientFalconError } from "@/lib/report-error";
import { PRODUCT, PTYPE } from "@/theme";

const PAPER_PRESETS = [1000, 10000, 100000];

function fmtUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type Step = "home" | "add" | "paper";

export default function BrokersScreen() {
  const router = useRouter();
  const navClearance = useNavClearance();
  const [step, setStep] = useState<Step>("home");
  const [paper, setPaper] = useState<PaperAccount | null>(null);
  const [live, setLive] = useState<BrokerageNetWorth>({
    connected: false,
    total: 0,
    accounts: [],
  });
  const [catalog, setCatalog] = useState<BrokerageCatalogItem[] | null>(null);
  /** true/false only after the worker responds; null means unknown / fetch failed. */
  const [catalogConfigured, setCatalogConfigured] = useState<boolean | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  /** Catalog fetch failure — quiet live-row hint only, never a page banner. */
  const [catalogError, setCatalogError] = useState<FalconError | null>(null);
  const catalogFetchedRef = useRef(false);
  const catalogInFlightRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const stepRef = useRef(step);
  stepRef.current = step;

  const load = useCallback(async (refreshLive = false) => {
    // Don't paint Connect with home/sync errors, and don't revive a dismissed
    // tap error when the app resumes.
    if (stepRef.current !== "add") {
      setError(null);
      setErrorCode(null);
    }
    try {
      const bundle = await loadBrokers();
      setPaper(bundle.paper);
      let nextLive = bundle.live;
      if (refreshLive && isComputeEnabled()) {
        nextLive = await syncLiveBrokerages();
      }
      setLive(nextLive);
    } catch (err) {
      const falcon = errorFromUnknown(err);
      reportClientFalconError(falcon);
      if (stepRef.current === "add") return;
      setError(falcon.message);
      setErrorCode(falcon.code);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCatalog = useCallback(async (force = false) => {
    if (force) catalogFetchedRef.current = false;
    if (!force && catalogFetchedRef.current) return;
    if (catalogInFlightRef.current) return;
    catalogFetchedRef.current = true;
    catalogInFlightRef.current = true;
    setCatalogLoading(true);
    try {
      const res = await loadBrokerCatalog();
      setCatalogConfigured(res.configured);
      setCatalog(res.brokerages);
      if (res.error && res.brokerages.length === 0) {
        reportClientFalconError(res.error);
        setCatalogError(res.error);
        catalogFetchedRef.current = false;
      } else {
        setCatalogError(null);
      }
    } catch (err) {
      const falcon = errorFromUnknown(err);
      reportClientFalconError(falcon);
      catalogFetchedRef.current = false;
      setCatalog(null);
      setCatalogConfigured(null);
      setCatalogError(falcon);
    } finally {
      catalogInFlightRef.current = false;
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    void fetchCatalog();
  }, [load, fetchCatalog]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void load(true);
    });
    return () => sub.remove();
  }, [load]);

  // SnapTrade (and any falcon:// / exp:// return) should refresh live status.
  useEffect(() => {
    const onUrl = (url: string) => {
      if (
        url.includes("brokers") ||
        url.includes("snaptrade") ||
        url.includes("authorization")
      ) {
        setNote("Refreshing linked accounts…");
        void load(true).then(() => setNote("Accounts updated."));
      }
    };
    void Linking.getInitialURL().then((url) => {
      if (url) onUrl(url);
    });
    const sub = Linking.addEventListener("url", (e) => onUrl(e.url));
    return () => sub.remove();
  }, [load]);

  function goHome() {
    setStep("home");
    setError(null);
    setErrorCode(null);
  }

  function openAdd() {
    setNote(null);
    setError(null);
    setErrorCode(null);
    setStep("add");
    void fetchCatalog(Boolean(catalogError) || catalog == null);
  }

  async function handleCreatePaper() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const account = await createPaperAccount(Math.round(value));
      setPaper(account);
      setAmount("");
      setStep("home");
      setNote("Falcon paper account ready.");
    } catch (err) {
      const falcon = errorFromUnknown(err);
      reportClientFalconError(falcon);
      setError(falcon.message);
      setErrorCode(falcon.code);
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(broker?: BrokerageCatalogItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const redirectUrl = ExpoLinking.createURL("/brokers");
      const url = await startLiveConnect(broker?.slug, redirectUrl);
      await Linking.openURL(url);
      setStep("home");
      setNote("Finish linking in the browser, then come back here.");
    } catch (err) {
      const falcon = errorFromUnknown(err);
      reportClientFalconError(falcon);
      setError(falcon.message);
      setErrorCode(falcon.code);
    } finally {
      setBusy(false);
    }
  }

  function confirmDisconnect(authorizationId: string, label: string) {
    Alert.alert("Disconnect?", `${label} will stop syncing holdings.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              const next = await removeLiveBrokerage(authorizationId);
              setLive(next);
            } catch (err) {
              const falcon = errorFromUnknown(err);
              reportClientFalconError(falcon);
              setError(falcon.message);
              setErrorCode(falcon.code);
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  if (loading) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  const amountValue = Number(amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0;
  const hasAnything = Boolean(paper) || live.accounts.length > 0;

  return (
    <Screen>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => (step === "home" ? router.back() : goHome())}
          hitSlop={12}
          style={styles.back}
        >
          <Feather name="chevron-left" size={20} color={PRODUCT.fgMuted} />
        </Pressable>
        {step === "home" ? (
          <Pressable onPress={() => void openAdd()} hitSlop={12} style={styles.backEnd}>
            <Feather name="plus" size={20} color={PRODUCT.fg} />
          </Pressable>
        ) : (
          <View style={styles.back} />
        )}
      </View>

      {error && step !== "add" ? (
        <View style={styles.notice}>
          <Text style={styles.error}>
            {error}
            {errorCode ? `  Ref ${errorCode}` : ""}
          </Text>
          <View style={styles.noticeActions}>
            {step === "home" ? (
              <Pressable onPress={() => void load(true)} hitSlop={8}>
                <Text style={styles.noticeAction}>Try again</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                setError(null);
                setErrorCode(null);
              }}
              hitSlop={8}
            >
              <Text style={styles.noticeAction}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {step === "paper" ? (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: navClearance }]}
          scrollIndicatorInsets={{ bottom: navClearance }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={PTYPE.greeting}>Starting balance</Text>
          <Text style={styles.caption}>
            Your Falcon paper-trading account starts with this cash.
          </Text>
          <View style={styles.amountRow}>
            <Text style={styles.dollar}>$</Text>
            <TextInput
              value={amount}
              onChangeText={(v) => setAmount(v.replace(/[^0-9]/g, ""))}
              placeholder="0"
              placeholderTextColor={PRODUCT.fgSubtle}
              keyboardType="number-pad"
              style={styles.amountInput}
            />
          </View>
          <View style={styles.presets}>
            {PAPER_PRESETS.map((preset) => (
              <Pressable
                key={preset}
                onPress={() => setAmount(String(preset))}
                style={styles.preset}
              >
                <Text style={styles.presetText}>${preset.toLocaleString("en-US")}</Text>
              </Pressable>
            ))}
          </View>
          <PressableScale
            onPress={() => void handleCreatePaper()}
            disabled={!amountValid || busy}
            style={[styles.btnFill, (!amountValid || busy) && styles.btnOff]}
            pressedStyle={styles.pressed}
          >
            <Text style={styles.btnFillText}>{busy ? "Creating…" : "Create account"}</Text>
          </PressableScale>
        </ScrollView>
      ) : step === "add" ? (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: navClearance }]}
          scrollIndicatorInsets={{ bottom: navClearance }}
        >
          <Text style={PTYPE.greeting}>Connect</Text>
          <Text style={styles.caption}>
            {paper
              ? "Add another paper account or link a live brokerage."
              : "Add a paper account or link a live brokerage."}
          </Text>

          {error ? (
            <View style={styles.inlineNotice}>
              <Text style={styles.inlineError}>{error}</Text>
              <Pressable
                onPress={() => {
                  setError(null);
                  setErrorCode(null);
                }}
                hitSlop={8}
              >
                <Text style={styles.noticeAction}>Dismiss</Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable
            onPress={() => {
              setError(null);
              setErrorCode(null);
              if (paper) {
                Alert.alert(
                  "Add another paper account?",
                  "This replaces your Falcon paper cash and positions.",
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Continue", onPress: () => setStep("paper") },
                  ],
                );
              } else {
                setStep("paper");
              }
            }}
            style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
          >
            <View style={styles.choiceBody}>
              <Text style={styles.choiceTitle}>Falcon</Text>
              <Text style={styles.choiceSub}>
                {paper ? "Add paper account" : "Paper"}
              </Text>
            </View>
            <Feather
              name={paper ? "plus" : "chevron-right"}
              size={16}
              color={PRODUCT.fgFaint}
            />
          </Pressable>

          {(catalog ?? []).map((broker) => (
            <Pressable
              key={broker.id}
              onPress={() => void handleConnect(broker)}
              disabled={busy}
              style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
            >
              <View style={styles.choiceLeft}>
                {broker.logoUrl ? (
                  <Image source={{ uri: broker.logoUrl }} style={styles.logo} />
                ) : (
                  <View style={styles.monogram}>
                    <Text style={styles.monogramText}>{broker.name.charAt(0)}</Text>
                  </View>
                )}
                <View style={styles.choiceBody}>
                  <Text style={styles.choiceTitle}>{broker.name}</Text>
                  <Text style={styles.choiceSub}>Live</Text>
                </View>
              </View>
              <Feather name="chevron-right" size={16} color={PRODUCT.fgFaint} />
            </Pressable>
          ))}

          {catalogLoading && !(catalog && catalog.length > 0) ? (
            <Text style={styles.caption}>Loading brokerages…</Text>
          ) : null}

          {!(catalog && catalog.length > 0) ? (
            <Pressable
              onPress={() => void handleConnect()}
              disabled={busy}
              style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
            >
              <View style={styles.choiceBody}>
                <Text style={styles.choiceTitle}>Live brokerage</Text>
                <Text style={styles.choiceSub}>
                  {busy
                    ? "Connecting…"
                    : catalogError
                      ? liveEngineHint(catalogError)
                      : "Connect in the browser"}
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={PRODUCT.fgFaint} />
            </Pressable>
          ) : null}

          {!catalogError && catalog && catalog.length === 0 && catalogConfigured !== null ? (
            <Text style={styles.caption}>{liveCatalogEmptyCopy(catalogConfigured)}</Text>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: navClearance }]}
          scrollIndicatorInsets={{ bottom: navClearance }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load(true).finally(() => setRefreshing(false));
              }}
              tintColor={PRODUCT.fgSubtle}
            />
          }
        >
          <Text style={PTYPE.greeting}>Brokers</Text>
          <Text style={styles.caption}>Paper and live accounts, shared with desktop.</Text>
          {note ? <Text style={styles.note}>{note}</Text> : null}

          {!hasAnything ? (
            <EmptyState
              title="No accounts yet"
              body="Create a Falcon paper account or link a live brokerage."
            />
          ) : null}

          {paper ? (
            <Panel style={styles.panel}>
              <View style={styles.rowTop}>
                <Text style={styles.choiceTitle}>Falcon</Text>
                <Tag label="Paper" />
              </View>
              <Text style={PTYPE.metric}>{fmtUsd(paper.cash)}</Text>
              <Text style={styles.choiceSub}>Paper cash</Text>
            </Panel>
          ) : null}

          {live.accounts.map((account) => (
            <Panel key={account.id || account.name} style={styles.panel}>
              <View style={styles.rowTop}>
                <Text style={styles.choiceTitle}>
                  {account.institution || account.name}
                </Text>
                <Tag label="Live" />
              </View>
              <Text style={styles.choiceSub}>{account.name}</Text>
              <Text style={PTYPE.metric}>
                {account.totalValue == null ? "—" : fmtUsd(account.totalValue)}
              </Text>
              {account.authorizationId ? (
                <Pressable
                  onPress={() =>
                    confirmDisconnect(
                      account.authorizationId!,
                      account.institution || account.name,
                    )
                  }
                  disabled={busy}
                  style={styles.btnGhost}
                >
                  <Text style={styles.btnGhostText}>Disconnect</Text>
                </Pressable>
              ) : null}
            </Panel>
          ))}

          <PressableScale
            onPress={() => void openAdd()}
            style={styles.btnFill}
            pressedStyle={styles.pressed}
          >
            <Text style={styles.btnFillText}>Add account</Text>
          </PressableScale>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  back: { width: 28, alignItems: "flex-start" },
  backEnd: { width: 28, alignItems: "flex-end" },
  scroll: { paddingHorizontal: 20, gap: 12 },
  caption: { ...PTYPE.small, marginTop: -4 },
  note: { ...PTYPE.small, color: PRODUCT.fgMuted },
  notice: { paddingHorizontal: 20, gap: 6, paddingBottom: 4 },
  inlineNotice: { gap: 6 },
  error: { ...PTYPE.small, color: PRODUCT.loss },
  inlineError: { ...PTYPE.small, color: PRODUCT.loss },
  noticeActions: { flexDirection: "row", gap: 16 },
  noticeAction: { ...PTYPE.tag, color: PRODUCT.fg },
  panel: { gap: 8 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: PRODUCT.card,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  choiceLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  choiceBody: { flex: 1, gap: 2 },
  choiceTitle: { ...PTYPE.ticker },
  choiceSub: { ...PTYPE.small },
  logo: { width: 36, height: 36, borderRadius: 10 },
  monogram: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: PRODUCT.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  monogramText: { ...PTYPE.ticker, color: PRODUCT.fgMuted },
  amountRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  dollar: { ...PTYPE.heroMetric, color: PRODUCT.fgFaint },
  amountInput: {
    ...PTYPE.heroMetric,
    minWidth: 120,
    textAlign: "center",
    paddingVertical: 8,
  },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  preset: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  presetText: { ...PTYPE.tag, color: PRODUCT.fgMuted },
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
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  btnGhostText: {
    fontFamily: PTYPE.ticker.fontFamily,
    fontSize: 13,
    color: PRODUCT.fg,
  },
  btnOff: { opacity: 0.4 },
  pressed: { opacity: 0.85 },
});
