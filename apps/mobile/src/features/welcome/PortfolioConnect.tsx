import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as WebBrowser from "expo-web-browser";
import { FileSpreadsheet, ImageUp, Landmark, X, type LucideIcon } from "lucide-react-native";
import { apiUrl } from "@/lib/env";
import { readParams } from "@/lib/oauth";
import { haptics } from "@/lib/haptics";
import { TICKER_PATTERN, tickerNames, type PickedStock } from "@/lib/onboarding";
import { cleanTicker, parseHoldingsCsv } from "@/lib/portfolio";
import { accessToken } from "@/lib/supabase";
import { NO_FOCUS_RING, colors, fonts } from "@/theme";
import { MonoLabel } from "./Steps";

/**
 * "Connect your portfolio": a screenshot (read by the website's
 * /api/portfolio/screenshot), a broker CSV (read on the phone) or a SnapTrade
 * broker link (the website's /api/portfolio/broker routes). Whatever comes
 * back is listed to check, edit or trim before it feeds the rest of the flow.
 */

type Sources = { screenshot: boolean; broker: boolean };
type Busy = "screenshot" | "csv" | "broker" | null;

/** The app scheme (app.json); the website's broker done route redirects here. */
const BROKER_RETURN = "falcon://broker";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Long edge of the image we send: plenty for reading a holdings list. */
const MAX_IMAGE_EDGE = 2400;

async function readJson(res: Response): Promise<{ holdings?: PickedStock[]; error?: string; url?: string }> {
  try {
    return (await res.json()) as { holdings?: PickedStock[]; error?: string; url?: string };
  } catch {
    return {};
  }
}

function formatShares(n: number | undefined) {
  return n === undefined ? "" : String(Math.round(n * 10000) / 10000);
}

/** A JPEG no larger than MAX_IMAGE_EDGE on its long side (also turns HEIC into JPEG). */
async function prepareImage(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(asset.width || 1, asset.height || 1));
  const context = ImageManipulator.manipulate(asset.uri);
  if (scale < 1) context.resize({ width: Math.round(asset.width * scale) });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
  return saved.uri;
}

async function readText(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  if (Platform.OS === "web" && asset.file) return asset.file.text();
  return new File(asset.uri).text();
}

/**
 * SnapTrade's consent page, then the website's done route hands back a sealed
 * ticket: on the phone as a falcon://broker redirect that ends the auth
 * session, in the browser preview as a message from the pop-up. Null when the
 * member closed it first; no ticket when SnapTrade or the member said no.
 */
async function authorizeBroker(url: string): Promise<{ ticket?: string } | null> {
  if (Platform.OS !== "web") {
    const result = await WebBrowser.openAuthSessionAsync(url, BROKER_RETURN);
    if (result.type !== "success") return null;
    return { ticket: readParams(result.url).get("ticket") ?? undefined };
  }
  const popup = window.open(url, "falcon-broker", "width=520,height=760");
  if (!popup) throw new Error("Allow pop-ups for this site to connect your broker.");
  return new Promise((resolve) => {
    const finish = (value: { ticket?: string } | null) => {
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; ok?: unknown; ticket?: unknown } | null;
      if (event.source !== popup || data?.type !== "falcon:broker") return;
      finish({ ticket: data.ok === true && typeof data.ticket === "string" ? data.ticket : undefined });
    };
    const watch = setInterval(() => {
      if (popup.closed) finish(null);
    }, 500);
    window.addEventListener("message", onMessage);
  });
}

export function PortfolioConnect({
  value,
  onChange,
}: {
  value: PickedStock[];
  onChange: (stocks: PickedStock[]) => void;
}) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let live = true;
    fetch(apiUrl("/api/portfolio/status"))
      .then((r) => (r.ok ? (r.json() as Promise<Sources>) : { screenshot: false, broker: false }))
      .catch(() => ({ screenshot: false, broker: false }))
      .then((s) => {
        if (live) setSources(s);
      });
    return () => {
      live = false;
    };
  }, []);

  const authHeaders = useCallback(async (): Promise<Record<string, string> | null> => {
    const token = await accessToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
  }, []);

  const found = useCallback(
    (holdings: PickedStock[] | undefined, empty: string) => {
      if (!holdings || holdings.length === 0) {
        haptics.error();
        setError(empty);
        return;
      }
      haptics.success();
      setError(null);
      onChange(holdings);
    },
    [onChange],
  );

  const uploadScreenshot = useCallback(async () => {
    if (!sources?.screenshot) return;
    setError(null);
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    if (asset.fileSize && asset.fileSize > MAX_UPLOAD_BYTES) {
      setError("That image is over 10 MB.");
      return;
    }
    setBusy("screenshot");
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("Sign in again to upload a screenshot.");
      const uri = await prepareImage(asset);
      const form = new FormData();
      if (Platform.OS === "web") {
        form.append("image", await (await fetch(uri)).blob(), "portfolio.jpg");
      } else {
        // React Native's FormData takes a file reference.
        form.append("image", { uri, name: "portfolio.jpg", type: "image/jpeg" } as unknown as Blob);
      }
      const res = await fetch(apiUrl("/api/portfolio/screenshot"), { method: "POST", headers, body: form });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error ?? "We couldn't read that screenshot. Try a CSV instead.");
      found(body.holdings, "We couldn't find any tickers in that screenshot.");
    } catch (err) {
      haptics.error();
      setError(err instanceof Error ? err.message : "We couldn't read that screenshot.");
    } finally {
      setBusy(null);
    }
  }, [authHeaders, found, sources?.screenshot]);

  const uploadCsv = useCallback(async () => {
    setError(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["text/csv", "text/comma-separated-values", "text/plain", "application/vnd.ms-excel"],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    if (asset.size && asset.size > MAX_UPLOAD_BYTES) {
      setError("That file is over 10 MB.");
      return;
    }
    setBusy("csv");
    try {
      const parsed = parseHoldingsCsv(await readText(asset));
      if (!parsed.ok) throw new Error(parsed.error);
      // Company names from the SEC list where it knows the ticker.
      const names = await tickerNames(parsed.holdings.map((h) => h.ticker));
      found(
        parsed.holdings.map((h) => ({ ...h, name: names[h.ticker] ?? h.name })),
        "We couldn't find any stock holdings in that file.",
      );
    } catch (err) {
      haptics.error();
      setError(err instanceof Error ? err.message : "We couldn't read that file.");
    } finally {
      setBusy(null);
    }
  }, [found]);

  const connectBroker = useCallback(async () => {
    if (!sources?.broker) return;
    setBusy("broker");
    setError(null);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("Sign in again to connect a broker.");
      const res = await fetch(apiUrl("/api/portfolio/broker/start"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo: Platform.OS === "web" ? window.location.origin : "app" }),
      });
      const body = await readJson(res);
      if (!res.ok || !body.url) throw new Error(body.error ?? "We couldn't reach the broker service.");

      const result = await authorizeBroker(body.url);
      if (!result) return; // Closed before finishing.
      if (!result.ticket) throw new Error("The broker connection didn't go through. Try again or use a CSV.");

      // The route reads the holdings with the ticket, then revokes the SnapTrade grant.
      const holdingsRes = await fetch(apiUrl("/api/portfolio/broker/holdings"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: result.ticket }),
      });
      const holdingsBody = await readJson(holdingsRes);
      if (!holdingsRes.ok) throw new Error(holdingsBody.error ?? "We couldn't read your broker holdings.");
      found(holdingsBody.holdings, "No holdings came back from your broker. Try again or use a CSV.");
    } catch (err) {
      haptics.error();
      setError(err instanceof Error ? err.message : "We couldn't connect your broker.");
    } finally {
      setBusy(null);
    }
  }, [authHeaders, found, sources?.broker]);

  /* ---------------- Review: the holdings found ---------------- */

  const update = (index: number, patch: Partial<PickedStock>) => {
    onChange(valueRef.current.map((h, i) => (i === index ? { ...h, ...patch } : h)));
  };

  async function commitTicker(index: number, raw: string) {
    const current = valueRef.current[index];
    const ticker = cleanTicker(raw) ?? raw.trim().toUpperCase();
    if (!current || ticker === current.ticker) return;
    update(index, { ticker, name: "" });
    if (!TICKER_PATTERN.test(ticker)) return;
    const name = (await tickerNames([ticker]))[ticker];
    if (name && valueRef.current[index]?.ticker === ticker) update(index, { name });
  }

  if (value.length > 0) {
    return (
      <View>
        <View style={styles.reviewHead}>
          <MonoLabel>
            {value.length} {value.length === 1 ? "holding" : "holdings"}
          </MonoLabel>
          <Pressable accessibilityRole="button" onPress={() => onChange([])} hitSlop={10}>
            <Text style={styles.quiet}>Start over</Text>
          </Pressable>
        </View>
        <View style={styles.list}>
          {value.map((h, i) => {
            const valid = TICKER_PATTERN.test(h.ticker);
            return (
              <View key={`${i}-${h.ticker}`} style={[styles.row, i > 0 ? styles.divider : null]}>
                <TextInput
                  defaultValue={h.ticker}
                  onEndEditing={(e) => void commitTicker(i, e.nativeEvent.text)}
                  onBlur={(e) => {
                    // Web has no onEndEditing.
                    if (Platform.OS === "web") void commitTicker(i, (e.target as unknown as { value: string }).value);
                  }}
                  accessibilityLabel="Ticker"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType="done"
                  style={[styles.tickerInput, NO_FOCUS_RING, valid ? null : styles.invalid]}
                />
                <Text style={styles.name} numberOfLines={1}>
                  {h.name}
                </Text>
                <TextInput
                  defaultValue={formatShares(h.shares)}
                  onEndEditing={(e) => {
                    const n = Number.parseFloat(e.nativeEvent.text.replace(/,/g, ""));
                    update(i, { shares: Number.isFinite(n) && n > 0 ? n : undefined });
                  }}
                  keyboardType="decimal-pad"
                  placeholder="Shares"
                  placeholderTextColor="#b4b4b0"
                  accessibilityLabel={`Shares of ${h.ticker}`}
                  returnKeyType="done"
                  style={[styles.sharesInput, NO_FOCUS_RING]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${h.ticker}`}
                  onPress={() => {
                    haptics.select();
                    onChange(valueRef.current.filter((_, j) => j !== i));
                  }}
                  hitSlop={8}
                  style={({ pressed }) => [styles.remove, pressed ? styles.removePressed : null]}
                >
                  <X size={14} strokeWidth={2} color={colors.faint} />
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>
    );
  }

  /* ---------------- Choose: three ways in ---------------- */

  const options: {
    id: Exclude<Busy, null>;
    icon: LucideIcon;
    title: string;
    enabled: boolean;
    onPress: () => void;
  }[] = [
    {
      id: "screenshot",
      icon: ImageUp,
      title: "Upload a screenshot",
      enabled: sources?.screenshot === true,
      onPress: () => void uploadScreenshot(),
    },
    {
      id: "csv",
      icon: FileSpreadsheet,
      title: "Upload a CSV",
      enabled: true,
      onPress: () => void uploadCsv(),
    },
    {
      id: "broker",
      icon: Landmark,
      title: "Connect your broker",
      enabled: sources?.broker === true,
      onPress: () => void connectBroker(),
    },
  ];

  return (
    <View>
      <View style={styles.options}>
        {options.map((option) => {
          const Icon = option.icon;
          const isBusy = busy === option.id;
          const disabled = !option.enabled || (busy !== null && !isBusy);
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ disabled: disabled || isBusy, busy: isBusy }}
              onPress={() => {
                haptics.select();
                option.onPress();
              }}
              disabled={disabled || isBusy}
              style={({ pressed }) => [
                styles.option,
                !option.enabled ? styles.optionOff : null,
                pressed ? styles.optionPressed : null,
              ]}
            >
              <Icon size={20} strokeWidth={1.5} color={colors.ink} />
              <Text style={[styles.optionTitle, styles.optionText]}>{option.title}</Text>
              {isBusy ? (
                <ActivityIndicator size="small" color={colors.faint} />
              ) : sources && !option.enabled ? (
                <Text style={styles.soon}>Coming soon</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  options: { gap: 10 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.optionBorder,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  optionOff: { borderColor: "rgba(0, 0, 0, 0.07)", opacity: 0.6 },
  optionPressed: { backgroundColor: "rgba(0, 0, 0, 0.025)" },
  optionText: { flex: 1, minWidth: 0 },
  optionTitle: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 21, color: colors.ink },
  soon: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.8, textTransform: "uppercase", color: colors.placeholder },
  error: { marginTop: 12, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.error },
  reviewHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  quiet: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: colors.placeholder },
  list: { marginTop: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.divider },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  tickerInput: {
    width: 76,
    height: 36,
    marginLeft: -8,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "transparent",
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.ink,
  },
  invalid: { borderColor: "#f87171" },
  name: { flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: 13, color: colors.muted },
  sharesInput: {
    width: 80,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 6,
    textAlign: "right",
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink,
  },
  remove: { width: 30, height: 30, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  removePressed: { backgroundColor: "rgba(0, 0, 0, 0.05)" },
});
