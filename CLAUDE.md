# Falcon website

This repo now holds only the Falcon website (getfalcon.co). The desktop app,
mobile app, research engine, workers and their data were removed on
2026-11-08 for a fresh start; they remain in git history before that date.

## Layout (pnpm + Turborepo)

```
apps/web                  Next.js 14 marketing + auth/waitlist + admin site (Netlify)
packages/ui               Shared React components + design tokens
packages/tailwind-config  Shared Tailwind preset
emails/supabase           Supabase auth email templates
```

## Commands

```bash
pnpm install
pnpm dev:web     # http://localhost:3000
pnpm build:web
pnpm lint
```

## Deploy

GitHub Actions `.github/workflows/deploy-web.yml` builds on Linux and publishes
to Netlify on pushes to main that touch the site. Never deploy from a Windows
build (the Netlify Next.js handler breaks); `scripts/netlify-windows/` is the
manual fallback.

## Conventions

- Secrets stay in `apps/web/.env.local` and Netlify env; never commit them.
- Line endings: repo is LF; CRLF warnings on Windows are harmless.
- On `git push`/`pull`, a Discord webhook posts one Turkish line (`.githooks`, `.env.discord`).
