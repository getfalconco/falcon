import type { ReactNode } from "react";
import Link from "next/link";
import { LEGAL_CONFIG, isPlaceholder, type LegalConfigKey } from "@/lib/legal-config";

/**
 * The building blocks the Privacy Policy and Terms of Service are written in.
 * Kept small and server-only: a paragraph, a list, a table, a link, and a
 * value read from the legal config that stands out while it is a placeholder.
 */

export type LegalSectionDef = {
  /** Stable anchor; other pages and the desktop app link to these. Never rename one that shipped. */
  id: string;
  title: string;
  body: ReactNode;
};

export function P({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-[1.75] text-[#3f3f3f] print:text-[11pt] print:text-black">{children}</p>;
}

/** A short heading inside a section. */
export function H3({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3
      id={id}
      className="scroll-mt-28 pt-2 text-[15px] font-medium leading-6 text-[#1d1b1b] print:text-[11.5pt] print:text-black"
    >
      {children}
    </h3>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-[15px] leading-[1.75] text-[#3f3f3f] marker:text-[#a3a39f] print:text-[11pt] print:text-black">
      {children}
    </ul>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

/** Bold lead-in for a list item or paragraph ("Account data."). */
export function Term({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-[#1d1b1b] print:text-black">{children}</strong>;
}

/**
 * Text that must be conspicuous to be enforceable in some jurisdictions
 * (warranty disclaimers, liability caps). Set in capitals by convention.
 */
export function Conspicuous({ children }: { children: ReactNode }) {
  return (
    <p className="text-[14px] font-medium uppercase leading-[1.75] tracking-[0.01em] text-[#1d1b1b] print:text-[10.5pt] print:text-black">
      {children}
    </p>
  );
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const className =
    "text-[#1d1b1b] underline decoration-[#c9c9c4] underline-offset-[3px] transition-colors hover:decoration-[#1d1b1b] print:text-black";
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** A placeholder, highlighted so it cannot be missed on screen or on paper. */
function Placeholder({ value }: { value: string }) {
  return (
    <mark className="rounded-[3px] bg-[#fff1b8] px-1 py-px font-medium text-[#6b4e00] [box-decoration-break:clone] print:bg-transparent print:underline">
      {value}
    </mark>
  );
}

/** A value from the legal config. */
export function Fact({ k }: { k: LegalConfigKey }) {
  const value = LEGAL_CONFIG[k];
  if (typeof value !== "string") return null;
  return isPlaceholder(value) ? <Placeholder value={value} /> : <>{value}</>;
}

/** An email address from the legal config, as a mailto link once it is real. */
export function Mail({ k }: { k: "contactEmail" | "privacyEmail" }) {
  const value = LEGAL_CONFIG[k];
  if (isPlaceholder(value)) return <Placeholder value={value} />;
  return <A href={`mailto:${value}`}>{value}</A>;
}

export function Table({ head, rows }: { head: readonly string[]; rows: ReadonlyArray<readonly ReactNode[]> }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 print:overflow-visible">
      <table
        className={`w-full ${head.length > 2 ? "min-w-[620px]" : ""} border-collapse text-left text-[13.5px] leading-relaxed print:min-w-0 print:text-[9.5pt]`}
      >
        <thead>
          <tr className="border-b border-[#e4e4e0]">
            {head.map((h) => (
              <th key={h} scope="col" className="py-2.5 pr-4 align-bottom font-medium text-[#1d1b1b] print:text-black">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[#efefeb] align-top">
              {row.map((cell, j) => (
                <td key={j} className="py-2.5 pr-4 text-[#3f3f3f] print:text-black">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
