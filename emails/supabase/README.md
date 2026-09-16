# Falcon — Supabase Auth email templates (token-only, dark)

Paste-ready HTML for Authentication → Email Templates. Every template shows an **8-digit OTP** in digit boxes — no confirmation links or Verify buttons.

Design: dark canvas (`#090909` / card `#121212`), Falcon mark + Playfair Display wordmark top-left, left-aligned copy.

Logo URL used in templates: `https://getfalcon.co/brand/falcon-icon-on-dark.png`  
(source file: `apps/web/public/brand/falcon-icon-on-dark.png`)

## Required Supabase settings

1. **Authentication → Providers → Email → Confirm email: ON**
2. Paste each template + subject below into the matching dashboard category
3. **Authentication → URL Configuration → Site URL** set correctly
4. Deploy web so the logo URL resolves (or host the PNG elsewhere and update `src`)

## Subjects

| Dashboard category | Subject |
| --- | --- |
| Confirm sign up | `Confirm your Falcon email` |
| Invite user | `You are invited to Falcon` |
| Magic link or OTP | `Your Falcon sign-in code` |
| Change email address | `Confirm your new Falcon email` |
| Reset password | `Reset your Falcon password` |
| Reauthentication | `{{ .Token }} is your Falcon verification code` |

## Files

| Category | File |
| --- | --- |
| Confirm sign up | `confirm-signup.html` |
| Invite user | `invite-user.html` |
| Magic link or OTP | `magic-link.html` |
| Change email address | `change-email.html` |
| Reset password | `reset-password.html` |
| Reauthentication | `reauthentication.html` |

## Variables used

- `{{ .Token }}` — 8-digit OTP (split into boxes via `{{ slice .Token n n+1 }}`)
- `{{ .Email }}` / `{{ .NewEmail }}` — address context in copy

Users verify with `supabase.auth.verifyOtp({ email, token, type })` in the app. Do not include `{{ .ConfirmationURL }}`.
