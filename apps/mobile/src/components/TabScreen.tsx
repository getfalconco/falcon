import { useState, type ReactNode } from "react";
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { tabBarClearance } from "@/components/TabBar";
import { GUTTER, colors } from "@/theme";

/**
 * A tab's scrolling page. On the iPhone the system tab bar and status bar set
 * the scroll insets (contentInsetAdjustmentBehavior); in the browser preview
 * the page pads itself for the drawn bar.
 */
export function TabScreen({
  children,
  onRefresh,
}: {
  children: ReactNode;
  /** Pull to refresh. */
  onRefresh?: () => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const ios = Platform.OS === "ios";
  const top = ios ? 0 : insets.top;
  const bottom = Platform.OS === "web" ? tabBarClearance(insets.bottom) : ios ? 32 : 24;

  const refresh = onRefresh
    ? async () => {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }
    : undefined;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingTop: top + 8, paddingBottom: bottom }]}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        refreshControl={
          refresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.muted} />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {/* Content fades out under the status bar instead of running into it. */}
      <Svg pointerEvents="none" width="100%" height={insets.top + 12} style={styles.scrim}>
        <Defs>
          <LinearGradient id="tab-scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.background} stopOpacity={1} />
            <Stop offset="0.7" stopColor={colors.background} stopOpacity={0.85} />
            <Stop offset="1" stopColor={colors.background} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#tab-scrim)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: GUTTER },
  scrim: { position: "absolute", left: 0, right: 0, top: 0 },
});
