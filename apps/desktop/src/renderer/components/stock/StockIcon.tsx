import { useState } from "react";
import { cn } from "@/lib/utils";
import { getStockLogoUrl } from "../../../shared/stock-catalog";

type Props = {
  symbol: string;
  companyName?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
};

const SIZE_CLASS = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
  lg: "h-10 w-10",
} as const;

export default function StockIcon({ symbol, className, size = "md" }: Props) {
  const [failed, setFailed] = useState(false);
  const dimension = SIZE_CLASS[size];

  if (failed) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 rounded-md bg-white/[0.06]",
          dimension,
          className,
        )}
      />
    );
  }

  return (
    <img
      src={getStockLogoUrl(symbol)}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn("shrink-0 object-contain", dimension, className)}
    />
  );
}
