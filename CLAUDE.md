# Falcon website and iPhone app

This repo holds the Falcon website (getfalcon.co) and a fresh iPhone app. The
old desktop app, mobile app, research engine, workers and their data were
removed on 2026-11-08 for a fresh start; they remain in git history before
that date.

## Layout (pnpm + Turborepo)

```
apps/web                  Next.js 14 marketing + auth/waitlist + admin site (Netlify)
apps/mobile               iPhone app: Expo SDK 58 + expo-router + TypeScript (dev build, no Expo Go)
packages/ui               Shared React components + design tokens
packages/tailwind-config  Shared Tailwind preset
emails/supabase           Supabase auth email templates
```

## Commands

```bash
pnpm install
pnpm dev:web     # http://localhost:3000
pnpm build:web
pnpm dev:mobile  # iPhone app in the browser, http://localhost:8081
pnpm mobile <script>   # any apps/mobile script, e.g. pnpm mobile lint
pnpm lint
```

## Mobile testing

- Windows: the app runs in the browser via react-native-web (`pnpm dev:mobile`,
  launch config "mobile-web"). On web only it renders inside an iPhone-sized
  frame (393 x 852, simulated safe areas, `src/components/PhoneFrame.web.tsx`).
  Expo Go is not used.
- iPhone: built and installed from a Mac with Xcode (`npx expo prebuild -p ios`,
  then Run in Xcode, or `npx expo run:ios --device`). Steps in `apps/mobile/README.md`.
- pnpm stays on isolated installs (Expo SDK 54+ supports them; Metro config is
  Expo's default, which handles the monorepo). `.pnpmfile.cjs` drops
  @react-three/fiber's optional react-native/expo peers so apps/web never
  resolves the mobile React Native stack.

## Deploy

GitHub Actions `.github/workflows/deploy-web.yml` builds on Linux and publishes
to Netlify on pushes to main that touch the site. Never deploy from a Windows
build (the Netlify Next.js handler breaks); `scripts/netlify-windows/` is the
manual fallback.

## Conventions

- Secrets stay in `apps/web/.env.local` and Netlify env; never commit them.
- Line endings: repo is LF; CRLF warnings on Windows are harmless.
- On `git push`/`pull`, a Discord webhook posts one Turkish line (`.githooks`, `.env.discord`).
