"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import GetStartedButton from "./GetStartedButton";

const FEATURE_MENU: { title: string; href: string }[] = [
  {
    title: "Portfolio tracking",
    href: "/portfolio",
  },
  {
    title: "Relationship graph",
    href: "#",
  },
  {
    title: "Second-order effects",
    href: "#",
  },
  {
    title: "Market observation",
    href: "#",
  },
  {
    title: "Risk score",
    href: "#",
  },

];

const TABS: { label: string; href: string }[] = [
  { label: "Product", href: "/" },
  { label: "Features", href: "#" },
  { label: "Download", href: "/download" },
  // The full plans page lives at /membership until tiers open up.
  { label: "Early Access", href: "/early-access" },
  { label: "FAQ", href: "/faq" },
  { label: "About", href: "/about" },
];

export default function Navbar({
  theme = "light",
}: {
  theme?: "light" | "dark";
}) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  // Closing waits a beat, so the pointer can cross the strip of bar between
  // the tab and the panel without the menu flickering shut mid-journey.
  const featuresCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFeatures = () => {
    if (featuresCloseTimer.current) clearTimeout(featuresCloseTimer.current);
    featuresCloseTimer.current = null;
    setFeaturesOpen(true);
  };
  const scheduleCloseFeatures = () => {
    if (featuresCloseTimer.current) clearTimeout(featuresCloseTimer.current);
    featuresCloseTimer.current = setTimeout(() => setFeaturesOpen(false), 180);
  };
  useEffect(
    () => () => {
      if (featuresCloseTimer.current) clearTimeout(featuresCloseTimer.current);
    },
    [],
  );
  const pathname = usePathname();
  const dark = theme === "dark";

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 24);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // The sheet covers the viewport, so the page behind it shouldn't scroll.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const isActive = (href: string) => {
    if (href === "#") return false;
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const logoColor = dark ? "rgb(245, 245, 247)" : "rgb(29, 27, 27)";
  const tabActive = dark ? "#f5f5f5" : "#1d1b1b";
  const tabInactive = dark ? "rgba(255, 255, 255, 0.5)" : "#8f8f8f";

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 ${dark ? "bg-transparent" : "bg-[#fdfdfd]"}`}
    >
      {!dark && (
        <>
          {/* Polka-dot texture, fades in only once the bar is scrolled. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{
              backgroundImage:
                "radial-gradient(rgba(0,0,0,var(--polka-alpha)) var(--polka-dot), transparent var(--polka-dot))",
              backgroundSize: "var(--polka-gap) var(--polka-gap)",
              opacity: scrolled ? 1 : 0,
            }}
          />
          {/* Soft white fade from the bar into the page (instead of a shadow). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-full h-16 transition-opacity duration-300"
            style={{
              background:
                "linear-gradient(to bottom, #fdfdfd 0%, rgba(253, 253, 253,0) 100%)",
              opacity: scrolled ? 1 : 0,
            }}
          />
        </>
      )}

      <nav className="relative flex h-12 items-center justify-between px-5 sm:h-14 sm:px-8">
        <Link href="/" aria-label="Falcon home" className="relative z-10 shrink-0">
          <span
            aria-hidden
            className="block h-8 w-8"
            style={{
              backgroundColor: logoColor,
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

        <ul
          className="pointer-events-none absolute inset-x-0 hidden items-center justify-center gap-6 md:flex"
          style={{
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "11px",
            lineHeight: "15px",
          }}
        >
          {TABS.map((tab) => {
            const active = isActive(tab.href);
            const hasMenu = tab.label === "Features";
            return (
              <li
                key={tab.label}
                className="pointer-events-auto relative"
                onMouseEnter={hasMenu ? openFeatures : undefined}
                onMouseLeave={hasMenu ? scheduleCloseFeatures : undefined}
              >
                <Link
                  href={tab.href}
                  className="transition-colors"
                  style={{
                    color: active || (hasMenu && featuresOpen) ? tabActive : tabInactive,
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {tab.label}
                </Link>
                {/* Anchored to this tab, so it hangs centred under
                    "Features" no matter how many tabs sit beside it. */}
                {hasMenu ? (
                <AnimatePresence>
                  {featuresOpen ? (
                    <motion.div
                      key="features-menu"
                      // x lives in the animation, not a class: framer writes its own
                      // inline transform, which would wipe a Tailwind -translate-x-1/2.
                      initial={{ opacity: 0, y: -6, x: "-50%" }}
                      animate={{ opacity: 1, y: 0, x: "-50%" }}
                      exit={{ opacity: 0, y: -6, x: "-50%", transition: { duration: 0.15 } }}
                      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                      onMouseEnter={openFeatures}
                      onMouseLeave={scheduleCloseFeatures}
                      className="absolute left-1/2 top-full z-50 hidden w-[248px] pt-3 md:block"
                    >
                      {/* Plain white list, one name per row — no descriptions. */}
                      <div className="rounded-2xl border border-black/[0.06] bg-[#fdfdfd] p-2 shadow-[0_14px_40px_rgba(8,12,18,0.12)]">
                        <ul>
                          {FEATURE_MENU.map((item) => (
                            <li key={item.title}>
                              {/* Hover: an inset grey pill, and the arrow fades in on the right. */}
                              <Link
                                href={item.href}
                                onClick={() => setFeaturesOpen(false)}
                                className="group flex items-center justify-between rounded-lg px-3 py-[9px] text-[14px] leading-[20px] text-[#5c5c5a] transition-colors hover:bg-[#efefec] hover:text-[#1d1b1b]"
                                style={{ fontFamily: "var(--font-geist-sans), sans-serif" }}
                              >
                                <span>{item.title}</span>
                                <ArrowUpRight
                                  aria-hidden
                                  strokeWidth={1.75}
                                  className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a] opacity-0 transition-opacity group-hover:opacity-100"
                                />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                ) : null}
              </li>
            );
          })}
        </ul>

        {/* Right side: Get started button reveals once scrolled past the hero. */}
        <div
          className={`relative z-10 hidden transition-opacity duration-300 md:block ${
            scrolled ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <GetStartedButton />
        </div>

        {/* Phones get the tabs behind a hamburger instead. */}
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="relative z-10 -mr-2 flex h-10 w-10 items-center justify-center md:hidden"
          style={{ color: logoColor }}
        >
          {menuOpen ? (
            <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          ) : (
            <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </nav>

      {/* Mobile menu: a full-screen sheet, sitting under the bar so the logo
          and the close button stay usable. */}
      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            key="mobile-menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            // z-0 keeps the sheet under the bar itself (whose contents sit at
            // z-10), so the logo and the close button stay on top of it.
            className={`fixed inset-0 z-0 flex flex-col md:hidden ${
              dark ? "bg-[#0b0b0d]" : "bg-[#fdfdfd]"
            }`}
          >
            <ul
              className="flex flex-1 flex-col justify-center gap-2 px-8 pb-24"
              style={{ fontFamily: "var(--font-geist-mono), monospace" }}
            >
              {TABS.map((tab, i) => (
                <motion.li
                  key={tab.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    delay: 0.05 + i * 0.04,
                    duration: 0.3,
                    ease: [0.4, 0, 0.2, 1],
                  }}
                >
                  <Link
                    href={tab.href}
                    onClick={() => setMenuOpen(false)}
                    className="block py-3 text-[22px] transition-colors"
                    style={{
                      color: isActive(tab.href) ? tabActive : tabInactive,
                      fontWeight: isActive(tab.href) ? 500 : 400,
                    }}
                  >
                    {tab.label}
                  </Link>
                </motion.li>
              ))}
            </ul>

            <motion.div
              className="px-8 pb-12"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.28, duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            >
              <GetStartedButton className="h-[48px] w-full pl-5 pr-4" />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
