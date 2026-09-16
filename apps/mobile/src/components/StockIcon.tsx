import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { getStockLogoUrl } from "@/lib/stock-catalog";

/**
 * Ticker logo — same CDN as desktop StockIcon / mobile StockSearch.
 * Falls back to a quiet tile when the image fails.
 */
export default function StockIcon({
  symbol,
  size = 20,
}: {
  symbol: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [symbol]);

  if (failed) {
    return (
      <View
        style={[
          styles.fallback,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      />
    );
  }

  return (
    <Image
      source={{ uri: getStockLogoUrl(symbol) }}
      accessible={false}
      onError={() => setFailed(true)}
      resizeMode="contain"
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: "#E3E3E0",
  },
});
