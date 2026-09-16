import { ActionSheetIOS, Platform, Pressable } from "react-native";

/**
 * A dashboard module, with a long press that offers to throw it away.
 *
 * This used to mount the card inside `@expo/ui`'s SwiftUI `ContextMenu` — a
 * real `UIContextMenu`, the lift and all. It cannot stay: the SwiftUI host
 * reports its own frame to Yoga, and these cards grow after mount as their
 * data lands, so the host stayed short and the module below was laid out over
 * the top of it. `matchContents`, a measured `minHeight` and an explicit
 * measured height all failed the same way (verified on device, 2026-08-27).
 *
 * `ActionSheetIOS` is still Apple's own sheet, with its own destructive red,
 * and it is drawn over the app rather than in it — so the card keeps plain
 * React Native layout and nothing can push it around. Wrapping the card in a
 * lifted context menu again needs a library that wraps the RN view in a
 * `UIContextMenuInteraction` instead of re-hosting it (react-native-ios-context-menu).
 *
 * PLATFORM-ONLY: iOS.
 * Reason: ActionSheetIOS has no Android equivalent; there the card renders
 * exactly as it did, without the long press.
 */
export default function ModuleCard({
  children,
  title,
  onDelete,
}: {
  children: React.ReactElement;
  /** Named in the sheet, so the reader knows which card they are throwing away. */
  title: string;
  onDelete: () => void;
}) {
  if (Platform.OS !== "ios") return children;

  const ask = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: ["Delete", "Cancel"],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (index) => {
        if (index === 0) onDelete();
      },
    );

  // A press that lands on something inside the card — a ticker, the arrow —
  // is claimed by that control, so this only fires on the card's own surface.
  return (
    <Pressable onLongPress={ask} delayLongPress={400}>
      {children}
    </Pressable>
  );
}
