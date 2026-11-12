import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Plus, X } from "lucide-react-native";
import type { Direction, RippleCard } from "@falcon/ripple";
import { PrimaryButton } from "@/components/Buttons";
import { Group, GroupLabel } from "@/components/List";
import { Reveal } from "@/components/Reveal";
import { TabScreen } from "@/components/TabScreen";
import { hydrateFocusList, syncFocusList } from "@/lib/focusList";
import { haptics } from "@/lib/haptics";
import { removeHolding } from "@/lib/holdings";
import { cardsForTicker, tickerDirection, useSightings } from "@/lib/sightings";
import { DirectionIcon } from "@/features/sightings/SightingCard";
import { DIRECTION, directionColor, directionSoft } from "@/features/sightings/format";
import { EmptyTitle, RoundButton, ScreenTitle, SkeletonCard } from "@/features/sightings/parts";
import { colors, fonts } from "@/theme";

type Exposure = { count: number; direction: Direction | null };

/** The day's Sightings on one ticker and which way their hits lean. */
function exposureOf(cards: RippleCard[], ticker: string): Exposure {
  return { count: cardsForTicker(cards, ticker).length, direction: tickerDirection(cards, ticker) };
}

function ExposureMark({ exposure, pending }: { exposure: Exposure; pending: boolean }) {
  if (pending) return <View style={styles.bone} />;
  if (exposure.count === 0) return <Text style={styles.none}>0</Text>;
  // Only the event company on the day's cards: a count, no lean.
  if (!exposure.direction) {
    return (
      <View style={[styles.mark, styles.markPlain]}>
        <Text style={[styles.markCount, { color: colors.body }]}>{exposure.count}</Text>
      </View>
    );
  }
  const direction = exposure.direction;
  return (
    <View style={[styles.mark, { backgroundColor: directionSoft(direction) }]}>
      <DirectionIcon direction={direction} size={13} />
      <Text style={[styles.markCount, { color: directionColor(direction) }]}>{exposure.count}</Text>
    </View>
  );
}

function HoldingRow({
  ticker,
  name,
  exposure,
  pending,
  editing,
  onOpen,
  onRemove,
}: {
  ticker: string;
  name: string;
  exposure: Exposure;
  pending: boolean;
  editing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const sightings = `${exposure.count} ${exposure.count === 1 ? "sighting" : "sightings"} today`;
  const lean = exposure.count > 0 && exposure.direction ? `, ${DIRECTION[exposure.direction]}` : "";
  const text = (
    <View style={styles.rowText}>
      <Text style={styles.ticker}>{ticker}</Text>
      <Text style={styles.name} numberOfLines={1}>
        {name || " "}
      </Text>
    </View>
  );

  // Editing: the row itself does nothing, only its remove button.
  if (editing) {
    return (
      <View style={styles.row}>
        {text}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${ticker}`}
          onPress={onRemove}
          hitSlop={10}
          style={({ pressed }) => [styles.remove, pressed ? styles.removePressed : null]}
        >
          <X size={15} strokeWidth={2} color={colors.body} />
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ticker}${name ? `, ${name}` : ""}. ${pending ? "" : `${sightings}${lean}`}`}
      onPress={onOpen}
    >
      {({ pressed }) => (
        <View style={[styles.row, pressed ? styles.rowPressed : null]}>
          {text}
          <ExposureMark exposure={exposure} pending={pending} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Portfolio: the member's focus list, each ticker with the number of today's
 * Sightings that reach it and which way they lean. Tap opens the ticker;
 * add from the search sheet, remove in Edit.
 */
export default function Portfolio() {
  const router = useRouter();
  const sightings = useSightings();
  const [editing, setEditing] = useState(false);
  const holdings = sightings.holdings;
  const stocks = useMemo(() => holdings?.stocks ?? [], [holdings]);
  const cards = useMemo(() => sightings.feed?.cards ?? [], [sightings.feed]);
  const pending = sightings.status === "loading";

  // A new phone takes the website's focus list; missing names get filled in.
  useEffect(() => {
    void hydrateFocusList();
  }, []);

  useEffect(() => {
    if (stocks.length === 0) setEditing(false);
  }, [stocks.length]);

  const add = () => {
    haptics.select();
    router.push("/add-ticker");
  };

  return (
    <TabScreen onRefresh={sightings.refresh}>
      <Reveal order={0}>
        <ScreenTitle
          title="Portfolio"
          right={
            <RoundButton label="Add a ticker" onPress={add}>
              <Plus size={19} strokeWidth={1.7} color={colors.ink} />
            </RoundButton>
          }
        />
      </Reveal>

      {holdings === undefined ? (
        <View style={styles.list}>
          <SkeletonCard />
        </View>
      ) : stocks.length === 0 ? (
        <Reveal order={1}>
          <EmptyTitle title="No holdings added yet" />
          <PrimaryButton label="Add a ticker" onPress={add} style={styles.emptyButton} />
        </Reveal>
      ) : (
        <Reveal order={1} style={styles.list}>
          <GroupLabel
            right={
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  haptics.select();
                  setEditing((e) => !e);
                }}
                hitSlop={10}
              >
                {({ pressed }) => (
                  <Text style={[styles.edit, pressed ? styles.editPressed : null]}>{editing ? "Done" : "Edit"}</Text>
                )}
              </Pressable>
            }
          >
            {`${stocks.length} ${stocks.length === 1 ? "holding" : "holdings"}`}
          </GroupLabel>
          <Group>
            {stocks.map((stock) => (
              <HoldingRow
                key={stock.ticker}
                ticker={stock.ticker}
                name={stock.name}
                exposure={exposureOf(cards, stock.ticker)}
                pending={pending}
                editing={editing}
                onOpen={() => {
                  haptics.select();
                  router.push({ pathname: "/ticker/[symbol]", params: { symbol: stock.ticker } });
                }}
                onRemove={() => {
                  haptics.select();
                  removeHolding(stock.ticker);
                  syncFocusList();
                }}
              />
            ))}
          </Group>
        </Reveal>
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 28 },
  emptyButton: { marginTop: 4, alignSelf: "center", paddingHorizontal: 28 },
  edit: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  editPressed: { opacity: 0.5 },
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  rowPressed: { backgroundColor: "rgba(0, 0, 0, 0.03)" },
  rowText: { flex: 1, minWidth: 0 },
  ticker: { fontFamily: fonts.mono, fontSize: 15, lineHeight: 20, color: colors.ink },
  name: { marginTop: 2, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 18, color: colors.muted },
  mark: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 28,
    minWidth: 46,
    justifyContent: "center",
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: 14,
  },
  markPlain: { paddingLeft: 10, backgroundColor: "rgba(0, 0, 0, 0.05)" },
  markCount: { fontFamily: fonts.mono, fontSize: 13 },
  none: { minWidth: 46, textAlign: "center", fontFamily: fonts.mono, fontSize: 13, color: colors.placeholder },
  bone: { width: 46, height: 28, borderRadius: 14, backgroundColor: "rgba(0, 0, 0, 0.05)" },
  remove: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.05)",
  },
  removePressed: { backgroundColor: "rgba(0, 0, 0, 0.1)" },
});
