import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { RADIUS } from "@/theme";

/**
 * Frosted glass card shell — a port of the desktop dashboard card, which every
 * card there shares verbatim (PortfolioCard, InsightCard, OpportunitiesPanel,
 * InsightDetailModal, DashboardSearchBar):
 *
 *   rounded-3xl border border-white/60 bg-white/40 p-5
 *   shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]
 *   backdrop-blur-xl backdrop-saturate-150
 *
 * Mapping, utility by utility:
 *   rounded-3xl      -> RADIUS.panel (both 24)
 *   border-white/60  -> 1px borderColor rgba(255,255,255,0.6)
 *   bg-white/40      -> the `wash` overlay
 *   p-5              -> PAD (both 20)
 *   shadow-[inset…]  -> the inset boxShadow on `glass`
 *   ring-1 ring-black/[0.04] -> the 1px-spread boxShadow on `ring`
 *   backdrop-blur-xl -> <BlurView>
 *
 * Two deliberate divergences: `backdrop-saturate-150` has no expo-blur
 * equivalent (iOS's light blur effect saturates a little on its own), and
 * BlurView's 0-100 intensity is not in px, so it cannot be set to the 24px
 * `blur-xl` radius — 40 reads closest on device.
 *
 * The ring lives on an outer view because the glass view clips (`overflow:
 * hidden`) for the blur, and a clipping view would swallow its own outer
 * shadow. Android blur is weak; fall back to a brighter translucent fill.
 */
export default function GlassPanel({
  children,
  style,
  padded = true,
  fill = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  /** Let the content stretch to a height the caller sets on `style`. */
  fill?: boolean;
}) {
  const android = Platform.OS === "android";

  return (
    <View style={[styles.ring, style]}>
      <View style={[styles.glass, fill && styles.fill]}>
        {!android ? (
          <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
        ) : null}
        <View
          pointerEvents="none"
          style={[styles.wash, android && styles.washAndroid]}
        />
        <View style={[padded && styles.pad, fill && styles.fill]}>{children}</View>
      </View>
    </View>
  );
}

/** Tailwind `p-5`. */
const PAD = 20;

const styles = StyleSheet.create({
  ring: {
    borderRadius: RADIUS.panel,
    borderCurve: "continuous",
    boxShadow: [
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1, color: "rgba(0,0,0,0.04)" },
    ],
  },
  glass: {
    borderRadius: RADIUS.panel,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
    overflow: "hidden",
    backgroundColor: "transparent",
    boxShadow: [
      { offsetX: 0, offsetY: 1, blurRadius: 0, color: "rgba(255,255,255,0.7)", inset: true },
    ],
  },
  wash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(255,255,255,0.4)",
  },
  washAndroid: {
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  pad: {
    padding: PAD,
  },
  /**
   * Grow into the height the caller asked for — never shrink to it.
   *
   * `flex: 1` is flexGrow 1 with a flexBasis of **0**, which tells Yoga this
   * view's own content is worth no height at all. The panel then resolves to
   * exactly the `minHeight` on the ring, and everything the card actually
   * draws spills out the bottom of it — over whatever module comes next.
   * Growing from an `auto` basis keeps the content as the floor and uses the
   * caller's height only when there is room to spare.
   */
  fill: {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: "auto",
  },
});
