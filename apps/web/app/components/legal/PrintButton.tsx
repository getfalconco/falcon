"use client";

/** Opens the browser's print dialog; the page's print styles do the rest. */
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="text-[13px] text-[#8a8a8a] underline decoration-[#d6d6d1] underline-offset-[3px] transition-colors hover:text-[#1d1b1b] hover:decoration-[#1d1b1b]"
    >
      Print or save as PDF
    </button>
  );
}
