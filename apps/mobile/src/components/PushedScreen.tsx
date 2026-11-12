import type { ReactNode, Ref } from "react";
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { BackButton } from "@/components/Buttons";
import { haptics } from "@/lib/haptics";
import { HOME_ROUTE } from "@/lib/home";
import { GUTTER, colors } from "@/theme";

const HEADER_H = 56;
const FADE_H = 14;

/**
 * A screen pushed over the tabs (a Sighting, a ticker): the round back
 * button, then the page scrolling under a soft fade instead of a hard edge.
 */
export function PushedScreen({
  children,
  right,
  scrollRef,
}: {
  children: ReactNode;
  /** Something on the header's right, across from the back button. */
  right?: ReactNode;
  scrollRef?: Ref<ScrollViewInstance>;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const back = () => {
    haptics.select();
    if (router.canGoBack()) router.back();
    else router.replace(HOME_ROUTE);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <BackButton onPress={back} />
        {right}
      </View>
      <View style={styles.screen}>
        <ScrollView
          ref={scrollRef}
          style={styles.screen}
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 32 }]}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
        <Svg pointerEvents="none" width="100%" height={FADE_H} style={styles.fade}>
          <Defs>
            <LinearGradient id="pushed-fade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.background} stopOpacity={1} />
              <Stop offset="1" stopColor={colors.background} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#pushed-fade)" />
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    height: HEADER_H,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: GUTTER - 4,
    backgroundColor: colors.background,
  },
  content: { paddingHorizontal: GUTTER, paddingTop: FADE_H },
  fade: { position: "absolute", left: 0, right: 0, top: 0 },
});
