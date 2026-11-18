import type { ReactNode } from "react";
import { currencySymbol } from "@/lib/workspace/positions-view";

/**
 * A currency's round flag for the Portfolio Overview's Cash group, drawn
 * here as simple inline SVG (no image host, no third-party assets): the
 * artwork on a 20x20 viewBox (drawn at 16px, like the logos), clipped to a circle, with a faint hairline ring
 * so white areas hold their edge on a white card. USD, EUR, GBP, CAD and JPY
 * have flags; any other currency gets a quiet circle with its symbol.
 */

const ART: Record<string, ReactNode> = {
  USD: (
    <>
      <rect width={20} height={20} fill="#FFFFFF" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={(i * 2 * 20) / 13} width={20} height={20 / 13} fill="#B22234" />
      ))}
      <rect width={10} height={(7 * 20) / 13} fill="#3C3B6E" />
      {[2, 4.6, 7.2].flatMap((cy, row) => (row === 1 ? [3.2, 6.6] : [1.6, 5, 8.4]).map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.6} fill="#FFFFFF" />))}
    </>
  ),
  EUR: (
    <>
      <rect width={20} height={20} fill="#003399" />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <circle key={i} cx={10 + Math.sin(a) * 5.6} cy={10 - Math.cos(a) * 5.6} r={0.85} fill="#FFCC00" />;
      })}
    </>
  ),
  GBP: (
    <>
      <rect width={20} height={20} fill="#012169" />
      <path d="M0,0L20,20M20,0L0,20" stroke="#FFFFFF" strokeWidth={4} />
      <path d="M0,0L20,20M20,0L0,20" stroke="#C8102E" strokeWidth={1.4} />
      <path d="M10,0V20M0,10H20" stroke="#FFFFFF" strokeWidth={6} />
      <path d="M10,0V20M0,10H20" stroke="#C8102E" strokeWidth={3.4} />
    </>
  ),
  CAD: (
    <>
      <rect width={20} height={20} fill="#FFFFFF" />
      <rect width={5} height={20} fill="#D52B1E" />
      <rect x={15} width={5} height={20} fill="#D52B1E" />
      <path
        d="M10,4.2L11,6.2L12.5,5.6L12.1,8.6L14.1,7.3L13.8,8.9L15.1,9.3L12.7,11.5L13.1,12.7L10.4,12.3L10.4,15H9.6L9.6,12.3L6.9,12.7L7.3,11.5L4.9,9.3L6.2,8.9L5.9,7.3L7.9,8.6L7.5,5.6L9,6.2Z"
        fill="#D52B1E"
      />
    </>
  ),
  JPY: (
    <>
      <rect width={20} height={20} fill="#FFFFFF" />
      <circle cx={10} cy={10} r={4.8} fill="#BC002D" />
    </>
  ),
};

/** The fallback's mark: the app's own symbol, else a common one, else the code's first letter. */
const MARK: Record<string, string> = { CHF: "Fr", INR: "₹", KRW: "₩", CNY: "¥", HKD: "$", SGD: "$", NZD: "$", MXN: "$", BRL: "R$", SEK: "kr", NOK: "kr", DKK: "kr", ILS: "₪", PLN: "zł", ZAR: "R" };

function mark(currency: string): string {
  const sym = currencySymbol(currency);
  if (sym) return sym.length > 1 && sym.endsWith("$") ? "$" : sym;
  return MARK[currency] ?? currency.slice(0, 1);
}

export function CurrencyFlag({ currency, size = 16 }: { currency: string; size?: number }) {
  const art = ART[currency];
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-line/10" style={{ width: size, height: size }}>
      {art ? (
        <svg width={size} height={size} viewBox="0 0 20 20" className="block">
          {art}
        </svg>
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[8.5px] font-semibold leading-none text-fore-4">
          {mark(currency)}
        </span>
      )}
    </span>
  );
}
