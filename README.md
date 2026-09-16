# Meridian

Monorepo for the Meridian product. Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/).

## Structure

```
apps/
  desktop/             Desktop app (Electron + Vite + React) — the product
  mobile/              Mobile app (Expo / React Native) — the product, on a phone
  web/                 Marketing site + auth/waitlist + admin panel (Next.js 14)
  news-worker/         Always-on news → propagation engine (Railway)
  research-worker/     Local dev HTTP server for the step1 engine
packages/
  research/            Core engine (@meridian/research) — all LLM/data logic
  ui/                  Shared React components + design tokens (@meridian/ui)
  tailwind-config/     Shared Tailwind preset (@meridian/tailwind-config)
```

Web and desktop consume the same Tailwind preset and shared components. Mobile
cannot (React Native has no DOM), so it mirrors the same tokens by hand in
`apps/mobile/src/theme.ts`.

**Desktop and mobile are the same product and must stay in sync** — a feature
added, removed or changed on one belongs on the other in the same PR, unless it
is explicitly marked platform-only. See
**[docs/PLATFORM_PARITY.md](docs/PLATFORM_PARITY.md)** for the rules, the
current gaps, and the pre-merge checklist.

## Getting started

```bash
pnpm install        # install all workspace deps
pnpm dev:web        # run the web app (http://localhost:3000)
pnpm build:web      # production build of the web app
pnpm dev:desktop    # run the Electron desktop app
pnpm build:desktop  # production build of the desktop app
pnpm --filter mobile start   # run the mobile app (Expo)
pnpm --filter mobile ios     # …and open it in the iOS Simulator
```

## Desktop app setup

1. Copy `apps/desktop/.env.example` to `apps/desktop/.env`
2. Add your Supabase **anon key** from the project dashboard (`Settings → API`)
3. In Supabase Dashboard, enable email confirmation: **Authentication → Providers → Email → Confirm email** (on). Paste the token-only templates from `emails/supabase/` into **Authentication → Email Templates**.
4. Optionally set `DATABASE_URL` with your Postgres pooler password for future server-side use
5. Run `pnpm dev:desktop`

Auth uses `@supabase/supabase-js` in the renderer. The Postgres connection string is for direct database access only — never expose it in the client.

## Discord git notes

On `git push` / `git pull`, Discord gets one Turkish line: `<sha> · <kişi> push/pull etti (<branch>) · <özet>`. Webhook is in `.env.discord`. Hooks auto-enable via `pnpm install`.
