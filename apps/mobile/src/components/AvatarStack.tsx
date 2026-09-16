import { Image, StyleSheet, View, type ImageSourcePropType } from "react-native";
import { COLORS } from "@/theme";

/** Team portraits from apps/web/public/team (About page). */
export const TEAM_AVATARS: { name: string; source: ImageSourcePropType }[] = [
  { name: "Kuzey Kovalak", source: require("../../assets/team/kuzey.png") },
  { name: "Umut Toprak Uslu", source: require("../../assets/team/umut.png") },
  { name: "Can Kovalak", source: require("../../assets/team/can.png") },
  { name: "Vaibhav Bhaskar", source: require("../../assets/team/vaibhav.jpg") },
];

type Props = {
  /** How many portraits to show (default 4). */
  count?: number;
  size?: number;
};

/**
 * Overlapping avatar row — same idea as the shadcn demo
 * (`flex -space-x-3` + ring), adapted for React Native.
 */
export default function AvatarStack({ count = 4, size = 44 }: Props) {
  const faces = TEAM_AVATARS.slice(0, count);
  const overlap = Math.round(size * 0.3);

  return (
    <View
      style={[styles.row, { height: size }]}
      accessibilityRole="image"
      accessibilityLabel={faces.map((f) => f.name).join(", ")}
    >
      {faces.map((face, i) => (
        <View
          key={face.name}
          style={[
            styles.ring,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              marginLeft: i === 0 ? 0 : -overlap,
              zIndex: faces.length - i,
            },
          ]}
        >
          <Image
            source={face.source}
            style={{ width: size, height: size, borderRadius: size / 2 }}
            resizeMode="cover"
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  ring: {
    borderWidth: 2,
    borderColor: COLORS.bg,
    overflow: "hidden",
    backgroundColor: COLORS.dash,
  },
});
