"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FOOTER,
  FOOTER_LEGAL_LINKS,
  FOOTER_PRODUCT_LINKS,
  NAV_RESOURCES,
} from "@/lib/marketing-copy";
import { resourceHref } from "@/lib/nav-utils";

function FooterLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const resolvedHref = resourceHref(href, pathname);

  return (
    <Link href={resolvedHref} className="text-[13px] text-[#505050] transition hover:text-[#707070]">
      {label}
    </Link>
  );
}

export default function Footer() {
  return (
    <footer className="border-t border-white/[0.08] bg-[#090909] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <Link href="/" aria-label="Falcon home" className="inline-flex shrink-0">
              <span
                className="inline-flex h-7 w-7 items-center justify-center bg-gradient-to-br from-white/25 to-white/5 ring-1 ring-white/20"
                aria-hidden
              >
                <span className="h-2.5 w-2.5 bg-white/80" />
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-[#505050]">{FOOTER.tagline}</p>
            <p className="mt-4 text-[12px] text-[#505050]">{FOOTER.copyright}</p>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/50">Product</p>
            <ul className="mt-4 space-y-2.5">
              {FOOTER_PRODUCT_LINKS.map((link) => (
                <li key={link.label}>
                  <FooterLink href={link.href} label={link.label} />
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/50">Resources</p>
            <ul className="mt-4 space-y-2.5">
              {NAV_RESOURCES.map((link) => (
                <li key={link.label}>
                  <FooterLink href={link.href} label={link.label} />
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/50">Legal</p>
            <ul className="mt-4 space-y-2.5">
              {FOOTER_LEGAL_LINKS.map((link) => (
                <li key={link.label}>
                  <FooterLink href={link.href} label={link.label} />
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-10 border-t border-white/[0.08] pt-6 text-[11px] leading-relaxed text-[#505050]">
          {FOOTER.disclaimer}
        </p>
      </div>
    </footer>
  );
}
