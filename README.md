# Falcon

The Falcon website (getfalcon.co). Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/).

## Structure

```
apps/
  web/                 Marketing site + auth/waitlist + admin panel (Next.js 14)
packages/
  ui/                  Shared React components + design tokens (@meridian/ui)
  tailwind-config/     Shared Tailwind preset (@meridian/tailwind-config)
emails/supabase/       Supabase auth email templates
```

## Getting started

```bash
pnpm install        # install all workspace deps
pnpm dev:web        # run the site (http://localhost:3000)
pnpm build:web      # production build of the site
```

## Deploy

Pushes to `main` that touch the site build it on Linux in GitHub Actions
(`.github/workflows/deploy-web.yml`) and publish it to Netlify. Don't deploy
from a Windows build; `scripts/netlify-windows/` is the fallback only.

## Supabase auth emails

Paste the token-only templates from `emails/supabase/` into **Authentication → Email Templates** in the Supabase dashboard.

## Discord git notes

On `git push` / `git pull`, Discord gets one Turkish line: `<sha> · <kişi> push/pull etti (<branch>) · <özet>`. Webhook is in `.env.discord`. Hooks auto-enable via `pnpm install`.
