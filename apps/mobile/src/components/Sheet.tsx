import { useCallback, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { GRABBER_SPACE, type CloseSheet } from "./sheetShared";

export type { CloseSheet } from "./sheetShared";

/**
 * Native: the route is a real iOS form sheet (presentation "formSheet" in
 * app/_layout.tsx), so the system draws the grabber, corners, dimming and
 * the slide. This only lays out the content. The web build uses Sheet.web.tsx.
 */
export function SheetScreen({ children }: { detent: number; children: (close: CloseSheet) => ReactNode }) {
  const router = useRouter();
  const close = useCallback<CloseSheet>(
    (then) => {
      if (router.canGoBack()) router.back();
      then?.();
    },
    [router],
  );
  return <View style={styles.sheet}>{children(close)}</View>;
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingTop: GRABBER_SPACE },
});
