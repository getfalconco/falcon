import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "lucide-react-native";
import { SheetScreen, type CloseSheet } from "@/components/Sheet";
import { haptics } from "@/lib/haptics";
import { LANGUAGES, setLanguage, useLanguage } from "@/lib/language";
import { SHEET_DETENTS } from "@/lib/sheets";
import { colors, fonts } from "@/theme";

/** The landing's language picker. Picking one only remembers it for now. */
export default function LanguageSheet() {
  return <SheetScreen detent={SHEET_DETENTS.language[0]}>{(close) => <Languages close={close} />}</SheetScreen>;
}

function Languages({ close }: { close: CloseSheet }) {
  const insets = useSafeAreaInsets();
  const current = useLanguage();

  return (
    <View style={styles.body}>
      <Text style={styles.title} accessibilityRole="header">
        Select language
      </Text>
      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) }}
        showsVerticalScrollIndicator={false}
      >
        {LANGUAGES.map((language, i) => {
          const selected = language.code === current.code;
          return (
            <Pressable
              key={language.code}
              accessibilityRole="radio"
              accessibilityLabel={language.label}
              accessibilityState={{ selected }}
              onPress={() => {
                haptics.select();
                setLanguage(language.code);
                close();
              }}
              style={({ pressed }) => [styles.row, i > 0 ? styles.rowDivider : null, pressed ? styles.rowPressed : null]}
            >
              <Text style={styles.flag}>{language.flag}</Text>
              <Text style={[styles.label, selected ? styles.labelSelected : null]}>{language.label}</Text>
              {selected ? <Check size={18} strokeWidth={2} color={colors.ink} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  title: {
    marginTop: 6,
    marginBottom: 10,
    fontFamily: fonts.sansMedium,
    fontSize: 17,
    lineHeight: 22,
    color: colors.ink,
    textAlign: "center",
  },
  list: { flex: 1 },
  row: { height: 54, marginHorizontal: 24, flexDirection: "row", alignItems: "center", gap: 14 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  rowPressed: { opacity: 0.55 },
  flag: { width: 30, fontSize: 24, lineHeight: 30, textAlign: "center" },
  label: { flex: 1, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22, color: colors.body },
  labelSelected: { fontFamily: fonts.sansMedium, color: colors.ink },
});
