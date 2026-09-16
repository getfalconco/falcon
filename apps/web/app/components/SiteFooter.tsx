import Link from "next/link";

const GEIST = "var(--font-geist-sans), sans-serif";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";

type FooterLink = { label: string; href: string; external?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "FAQ", href: "/faq" },
      { label: "Careers", href: "/careers" },
      { label: "Early Access", href: "/early-access" },
      { label: "Log in", href: "/login" },
    ],
  },
  {
    title: "Features",
    links: [
      { label: "Relationship graph", href: "#" },
      { label: "Second-order signals", href: "#" },
      { label: "Daily top signal", href: "#" },
      { label: "Company reports", href: "#" },
      { label: "Desktop app", href: "/early-access" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
    ],
  },
  {
    title: "Social",
    links: [
      { label: "X", href: "#", external: true },
      { label: "LinkedIn", href: "#", external: true },
    ],
  },
];

function FooterAnchor({ link }: { link: FooterLink }) {
  const className =
    "text-[14px] leading-[20px] text-[#8a8a8a] transition-colors hover:text-[#1d1b1b]";
  if (link.external) {
    return (
      <a href={link.href} className={className} target="_blank" rel="noreferrer">
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

/**
 * Light site footer: four link columns with the mark at the far right, the
 * copyright line, and a giant wordmark running off the bottom of the page.
 */
export default function SiteFooter() {
  return (
    <footer
      className="relative overflow-hidden bg-[#fdfdfd] pt-24"
      style={{ fontFamily: GEIST }}
    >
      <div className="mx-auto max-w-7xl px-6 sm:px-10">
        <div className="flex items-start justify-between gap-10">
          <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-4">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="text-[15px] font-medium leading-[20px] text-[#1d1b1b]">
                  {col.title}
                </h3>
                <ul className="mt-6 space-y-3.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <FooterAnchor link={link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <Link href="/" aria-label="Falcon home" className="hidden shrink-0 sm:block">
            <span
              aria-hidden
              className="block h-7 w-7"
              style={{
                backgroundColor: "rgb(29, 27, 27)",
                WebkitMaskImage: "url(/brand/falcon-icon-on-light.png)",
                maskImage: "url(/brand/falcon-icon-on-light.png)",
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
          </Link>
        </div>

        <p className="mt-28 text-[13px] text-[#a3a39f]">&copy; 2026 Falcon</p>
      </div>

      {/* The wordmark: huge, barely-there, and cut off by the bottom edge. */}
      <div aria-hidden className="relative mt-2 h-[clamp(110px,16vw,230px)] select-none">
        <span
          className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap leading-none text-[#ececea]"
          style={{
            fontFamily: SERIF,
            fontSize: "clamp(180px, 26vw, 380px)",
            letterSpacing: "-0.02em",
          }}
        >
          Falcon
        </span>
      </div>
    </footer>
  );
}
