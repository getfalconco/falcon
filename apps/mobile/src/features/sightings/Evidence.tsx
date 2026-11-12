import { Pressable, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { ArrowUpRight as LinkArrow } from "lucide-react-native";
import type { LinkEvidence } from "@falcon/ripple";
import { haptics } from "@/lib/haptics";
import { colors, fonts } from "@/theme";
import { shortDate } from "./format";

/** Opens a source (a filing, a release) in the in-app browser sheet. */
export function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  haptics.select();
  void WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET }).catch(
    () => {},
  );
}

/** A filing quote that proves a link, with its form and date; tap opens the filing. */
export function Quote({ evidence, lines }: { evidence: LinkEvidence; lines?: number }) {
  const filed = shortDate(evidence.filedAt);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${evidence.form} filing${filed ? `, filed ${filed}` : ""}`}
      onPress={() => openLink(evidence.url)}
    >
      {({ pressed }) => (
        <View style={[styles.quote, pressed ? styles.pressed : null]}>
          <Text style={styles.quoteText} numberOfLines={lines}>{`“${evidence.quote.trim()}”`}</Text>
          <View style={styles.quoteSource}>
            <Text style={styles.quoteForm}>{evidence.form}</Text>
            {filed ? <Text style={styles.quoteMeta}>Filed {filed}</Text> : null}
            <LinkArrow size={13} strokeWidth={1.8} color={colors.faint} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  quote: { borderLeftWidth: 2, borderLeftColor: "rgba(0, 0, 0, 0.12)", paddingLeft: 14, paddingVertical: 2 },
  quoteText: { fontFamily: fonts.serif, fontSize: 14.5, lineHeight: 23, color: colors.body },
  quoteSource: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  quoteForm: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.6, color: colors.ink },
  quoteMeta: { fontFamily: fonts.sans, fontSize: 12.5, color: colors.faint },
});
