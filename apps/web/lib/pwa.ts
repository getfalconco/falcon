/**
 * Installable app (PWA) settings for the app host (app.getfalcon.co).
 *
 * The manifest and the service worker are route handlers that answer only on
 * the app host (`app/falcon.webmanifest`, `app/sw.js`), so getfalcon.co never
 * advertises an install. `/app` carries the tags statically; the other app-host
 * pages (login, welcome) get them from `app/components/AppHostPwa.tsx`.
 */
import type { Metadata, Viewport } from "next";

/** Page background of the app and the auth screens. */
export const PWA_THEME_COLOR = "#fdfdfd";
export const PWA_BACKGROUND_COLOR = "#fdfdfd";

export const MANIFEST_PATH = "/falcon.webmanifest";
export const SW_PATH = "/sw.js";
export const APPLE_TOUCH_ICON = "/pwa/apple-touch-icon.png";

/** iPhone launch images (portrait), sized from the screen in points and its scale. */
const LAUNCH_SCREENS: Array<[w: number, h: number, scale: number]> = [
  [375, 667, 2], // SE 2nd/3rd gen, 8
  [414, 896, 2], // XR, 11
  [375, 812, 3], // X, XS, 11 Pro, 12/13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [390, 844, 3], // 12, 13, 14
  [428, 926, 3], // 12/13 Pro Max, 14 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [420, 912, 3], // Air
];

export const STARTUP_IMAGES = LAUNCH_SCREENS.map(([w, h, s]) => ({
  url: `/pwa/splash/launch-${w * s}x${h * s}.png`,
  media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${s}) and (orientation: portrait)`,
}));

/** Metadata for pages that only exist on the app host. */
export const APP_HOST_METADATA: Metadata = {
  manifest: MANIFEST_PATH,
  icons: {
    icon: "/brand/logo-black-glass.png",
    shortcut: "/brand/logo-black-glass.png",
    apple: { url: APPLE_TOUCH_ICON, sizes: "180x180" },
  },
  appleWebApp: {
    capable: true,
    title: "Falcon",
    statusBarStyle: "default",
    startupImage: STARTUP_IMAGES,
  },
  other: { "mobile-web-app-capable": "yes" },
};

/** Content runs edge to edge in the installed app; layouts pad with env(safe-area-inset-*). */
export const APP_HOST_VIEWPORT: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: PWA_THEME_COLOR,
};

export function webManifest() {
  return {
    id: "/app",
    name: "Falcon",
    short_name: "Falcon",
    description: "See how news at one company ripples into the stocks you follow.",
    lang: "en",
    dir: "ltr",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    categories: ["finance", "business"],
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The mark fills the middle half of the art, inside the maskable safe zone.
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
