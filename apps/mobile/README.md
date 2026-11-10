# Falcon iPhone app

Expo (SDK 58) + React Native + TypeScript, routes in `src/app` (expo-router).
It is a development build app (`expo-dev-client`), not an Expo Go project.

- Name: Falcon
- Bundle id: `co.getfalcon.app`
- iOS deployment target: 16.4

## What is in it

- `src/app/index.tsx`: the loading screen (white, the Falcon mark small and
  centered). It matches the native launch screen (`expo-splash-screen` in
  `app.json`, same image, 64 pt), which it replaces, then hands off.
- `src/app/login.tsx`: email, then the emailed code (Supabase OTP on the
  website's project, 6-digit codes; `OTP_LENGTH` in login.tsx).
- `src/app/welcome.tsx`: the website's /welcome funnel, step for step. The
  ticker names, SEC filings count and screenshot reading come from the site's
  API routes (`EXPO_PUBLIC_API_URL`, default https://getfalcon.co). In the
  browser preview those calls go through the Metro dev server's proxy
  (`metro.config.js`) because the site sends no CORS headers.

## Google and Apple sign-in

`src/lib/oauth.ts`. Google (and Apple on web) runs Supabase OAuth in an auth
session browser and comes back on `falcon://auth/callback` (PKCE code
exchanged for a session). Apple on iOS uses the native Sign in with Apple
sheet and `signInWithIdToken`. In Supabase, enable both providers and add
`falcon://**` (and `http://localhost:8081/**` for the browser preview)
under Authentication > URL Configuration > Redirect URLs. In Xcode the target
needs the Sign in with Apple capability (`usesAppleSignIn` in app.json adds
it on prebuild).

## Environment

Copy `.env.example` to `.env` (gitignored) and fill in the Supabase URL and
anon key from `apps/web/.env.local`. `EXPO_PUBLIC_FUNNEL_TEST_MODE` is `1`
by default, as on the site: no session is kept, the funnel always starts at
step 1 and answers are not saved. Set it to `0` to turn that off.

## Test on Windows (browser)

From the repo root:

```bash
pnpm install
pnpm dev:mobile     # http://localhost:8081
```

The web build draws the app inside an iPhone-sized frame (393 x 852, with
the Dynamic Island and home indicator safe areas), so it looks like the phone.
That frame exists only on web (`src/components/PhoneFrame.web.tsx`); on the
iPhone the app fills the screen.

## Install on an iPhone (Mac with Xcode)

You need:

- A Mac with Xcode (from the App Store) and Node 20+ with pnpm (`corepack enable`).
- CocoaPods: `brew install cocoapods` (or `sudo gem install cocoapods`).
- An Apple ID signed in under Xcode > Settings > Accounts. A free Apple ID
  can install on your own iPhone, but the app expires after 7 days and must be
  run again from Xcode. A paid Apple Developer Program membership ($99/year)
  removes that limit and is needed for TestFlight and the App Store.
- On the iPhone: Settings > Privacy & Security > Developer Mode on (iOS 16+),
  and trust the Mac when you plug it in.

Steps (in a clone of this repo):

```bash
pnpm install
cd apps/mobile
npx expo prebuild -p ios        # generates ios/ (gitignored)
open ios/*.xcworkspace
```

In Xcode:

1. Select the `Falcon` target > Signing & Capabilities > Team: your Apple ID.
   If `co.getfalcon.app` is taken for a free account, change the bundle id
   there (and in `app.json`) to something unique.
2. Plug in the iPhone and pick it as the run destination at the top.
3. Press Run. On first launch with a free Apple ID, allow the developer app on
   the phone under Settings > General > VPN & Device Management.

Or skip Xcode's UI and build straight to the plugged-in phone:

```bash
cd apps/mobile
npx expo run:ios --device
```

A debug build loads its JavaScript from the Mac's dev server (`pnpm mobile
start`, the phone and Mac on the same Wi-Fi). For a build that runs on its own,
choose Product > Scheme > Edit Scheme > Run > Build Configuration: Release, or
`npx expo run:ios --device --configuration Release`.

After changing `app.json` or adding a native package, run
`npx expo prebuild -p ios --clean` again.
