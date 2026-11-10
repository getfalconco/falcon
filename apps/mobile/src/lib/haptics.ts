import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

/** Haptic feedback on the phone; nothing in the browser preview. */
const native = Platform.OS === "ios" || Platform.OS === "android";

export const haptics = {
  /** Picking an option. */
  select() {
    if (native) void Haptics.selectionAsync().catch(() => {});
  },
  /** A button press that moves the flow on. */
  tap() {
    if (native) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  success() {
    if (native) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
  error() {
    if (native) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
  },
};
