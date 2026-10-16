import { useState } from "react";
import { cn } from "@/lib/utils";
import { getStockLogoUrl } from "../../../shared/stock-catalog";

/**
 * A company's logo in the Earnings tab, its drawer and the Earnings card: the
 * same source the stock view and the Positions card use (`getStockLogoUrl`),
 * on the same small round tile the Positions card draws (20px, a 14px mark).
 *
 * The tile is sized before the image arrives, so nothing moves while it
 * loads, and the image is lazy. When there is no logo the tile shows the
 * ticker's first letter instead of a broken image.
 *
 * On the dark theme the tile stays light: many logos are dark marks on a
 * transparent ground and vanish on a dark tile. The colours are written as
 * arbitrary values on purpose, so the dark theme's translation of the app's
 * named greys does not turn the tile dark again.
 */
export default function EarningsLogo({ ticker, className, size }: { ticker: string; className?: string; /** Pixels across; the 20px tile when left out. */ size?: number }) {
  const box = size ? { width: size, height: size } : undefined;
  const mark = size ? { width: Math.round(size * 0.7), height: Math.round(size * 0.7) } : undefined;
  const [failed, setFailed] = useState(false);
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[rgb(227,227,224)] [[data-theme=dark]_&]:bg-[rgb(214,214,210)]",
        className,
      )}
      style={box}
    >
      {failed ? (
        <span className={cn(size ? "font-sans" : "font-['Geist_Mono']", "font-semibold leading-none text-[rgb(75,85,99)]")} style={{ fontSize: size ? Math.max(7, size * 0.48) : 9.5 }}>{ticker.slice(0, 1)}</span>
      ) : (
        <img
          src={getStockLogoUrl(ticker)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-3.5 w-3.5 object-contain"
          style={mark}
        />
      )}
    </span>
  );
}
