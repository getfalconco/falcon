import type { ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { SafeAreaFrameContext, SafeAreaInsetsContext } from "react-native-safe-area-context";

// iPhone 15/16 Pro logical size and its portrait safe-area insets.
const SCREEN = { width: 393, height: 852 };
const INSETS = { top: 59, bottom: 34, left: 0, right: 0 };
const BEZEL = 12;
const RADIUS = 55;
const MARGIN = 24;

const FRAME = { x: 0, y: 0, ...SCREEN };

/**
 * Web only (testing on the PC): renders the app inside an iPhone-sized screen,
 * scaled down to fit short windows, with the Dynamic Island and home indicator
 * drawn on top and the safe-area insets reported as on the device.
 */
export default function PhoneFrame({ children }: { children: ReactNode }) {
  const win = useWindowDimensions();
  const outerW = SCREEN.width + BEZEL * 2;
  const outerH = SCREEN.height + BEZEL * 2;
  const scale = Math.min(1, (win.width - MARGIN * 2) / outerW, (win.height - MARGIN * 2) / outerH);

  return (
    <View style={styles.page}>
      <View style={[styles.bezel, { width: outerW, height: outerH, transform: [{ scale: Math.max(scale, 0.3) }] }]}>
        <View style={styles.screen}>
          <SafeAreaFrameContext.Provider value={FRAME}>
            <SafeAreaInsetsContext.Provider value={INSETS}>{children}</SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
          <View pointerEvents="none" style={styles.island} />
          <View pointerEvents="none" style={styles.homeIndicator} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f5f5f4",
    overflow: "hidden",
  },
  bezel: {
    padding: BEZEL,
    borderRadius: RADIUS + BEZEL,
    backgroundColor: "#1c1917",
    boxShadow: "0 24px 60px rgba(0, 0, 0, 0.18)",
  },
  screen: {
    width: SCREEN.width,
    height: SCREEN.height,
    borderRadius: RADIUS,
    overflow: "hidden",
    backgroundColor: "#ffffff",
  },
  island: {
    position: "absolute",
    top: 11,
    left: (SCREEN.width - 126) / 2,
    width: 126,
    height: 37,
    borderRadius: 19,
    backgroundColor: "#000000",
  },
  homeIndicator: {
    position: "absolute",
    bottom: 8,
    left: (SCREEN.width - 134) / 2,
    width: 134,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#000000",
  },
});
