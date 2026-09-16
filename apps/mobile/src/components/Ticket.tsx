import { useMemo } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { WebView } from "react-native-webview";
import { buildTicketHtml, TICKET_RATIO } from "./ticket-html";

export { TICKET_RATIO };

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function grantedDateLabel(iso?: string | null): string {
  if (!iso) return "Granted";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Granted";
  return `Granted ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

type Props = {
  width: number;
  /** Shown top-left only after we know the member. Leave empty on the apply screen. */
  firstName?: string;
  lastName?: string;
  title?: string;
  memberLabel?: string;
  dateLabel?: string;
  grantedAt?: string;
  cutoutColor?: string;
  style?: ViewStyle;
};

export default function Ticket({
  width,
  firstName,
  lastName,
  title = "Early Access",
  memberLabel = "Member #001",
  dateLabel,
  grantedAt,
  style,
}: Props) {
  const height = width * TICKET_RATIO;
  const presenter = [firstName, lastName].filter(Boolean).join(" ").trim();
  const resolvedDate = dateLabel ?? grantedDateLabel(grantedAt);
  const html = useMemo(
    () =>
      buildTicketHtml({
        width,
        presenter,
        title,
        memberLabel,
        dateLabel: resolvedDate,
      }),
    [width, presenter, title, memberLabel, resolvedDate],
  );

  return (
    <View style={[{ width, height }, styles.root, style]}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        style={[styles.web, { width, height }]}
        containerStyle={styles.web}
        // Without this, iOS paints an opaque rectangle behind the ticket
        // (visible in the transparent notches / outside the clip-path).
        opaque={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        javaScriptEnabled
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: "transparent",
  },
  web: {
    backgroundColor: "transparent",
  },
});
