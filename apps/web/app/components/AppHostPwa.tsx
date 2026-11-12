"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isAppHost } from "@/lib/app-host";
import { APPLE_TOUCH_ICON, MANIFEST_PATH, PWA_THEME_COLOR, STARTUP_IMAGES, SW_PATH } from "@/lib/pwa";

const MARK = "data-falcon-pwa";

function addTag(tag: "link" | "meta", attrs: Record<string, string>) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.setAttribute(MARK, "");
  document.head.appendChild(el);
}

/**
 * Install tags for app-host pages that are shared with the marketing host
 * (login, welcome): static metadata can't tell the hosts apart without making
 * those pages dynamic. `/app` has them statically; on a client-side move
 * between the two the injected copy is added or dropped so there is always
 * exactly one manifest link.
 */
function syncInstallTags() {
  const ownManifest = document.querySelector(`link[rel="manifest"]:not([${MARK}])`);
  const injected = document.head.querySelectorAll(`[${MARK}]`);
  if (ownManifest) {
    injected.forEach((el) => el.remove());
    return;
  }
  if (injected.length) return;
  addTag("link", { rel: "manifest", href: MANIFEST_PATH });
  addTag("link", { rel: "apple-touch-icon", href: APPLE_TOUCH_ICON, sizes: "180x180" });
  addTag("meta", { name: "theme-color", content: PWA_THEME_COLOR });
  addTag("meta", { name: "mobile-web-app-capable", content: "yes" });
  addTag("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
  addTag("meta", { name: "apple-mobile-web-app-title", content: "Falcon" });
  addTag("meta", { name: "apple-mobile-web-app-status-bar-style", content: "default" });
  for (const img of STARTUP_IMAGES) addTag("link", { rel: "apple-touch-startup-image", href: img.url, media: img.media });
}

/**
 * Makes the app host installable and registers the service worker there in
 * production builds. In `next dev` it unregisters any worker left by a local
 * production run and its caches, so dev assets are never served from a cache.
 */
export default function AppHostPwa() {
  const pathname = usePathname();

  useEffect(() => {
    if (!isAppHost(window.location.host)) return;
    // After the new route's metadata has been committed to <head>.
    const frame = requestAnimationFrame(syncInstallTags);
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    if (!isAppHost(window.location.host)) return;
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .then(() => caches.keys())
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith("falcon-")).map((k) => caches.delete(k))))
        .catch(() => {});
      return;
    }

    const register = () => {
      navigator.serviceWorker.register(SW_PATH, { scope: "/" }).catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
