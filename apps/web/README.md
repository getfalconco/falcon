# Meridian — Waitlist Landing Page

Pre-launch waitlist site for **Meridian**, an institutional-grade market
intelligence platform for individual investors. Single-page, dark, premium.

## Stack

- [Next.js 14](https://nextjs.org/) (App Router) + TypeScript
- [Tailwind CSS](https://tailwindcss.com/)
- [Framer Motion](https://www.framer.com/motion/) for subtle animation
- [lucide-react](https://lucide.dev/) icons
- `Inter` via `next/font`

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Things to wire up

- **Waitlist endpoint** — set `WAITLIST_ENDPOINT` in
  [`app/components/WaitlistForm.tsx`](app/components/WaitlistForm.tsx). While it
  is `"REPLACE_ME"`, submissions are simulated and the email is logged to the
  console. Once a real URL is set, the form POSTs `{ email }` as JSON.
- **Product screenshot** — drop `meridian-preview.png` into [`public/`](public).
  The path is the `PREVIEW_SRC` constant at the top of
  [`app/components/MacbookMockup.tsx`](app/components/MacbookMockup.tsx). A faux
  dashboard placeholder renders until the file exists.

## Structure

```
app/
  layout.tsx            Root layout, Inter font, metadata
  page.tsx              Assembles all sections
  globals.css           Tailwind layers + base theme
  components/
    Navbar.tsx           Transparent -> blurred on scroll
    Hero.tsx             Badge, headline, inline waitlist form
    MacbookMockup.tsx    CSS MacBook frame + glow + parallax
    HowItWorks.tsx       3 feature cards
    WaitlistSection.tsx  Secondary CTA
    Footer.tsx           Wordmark, socials, copyright
    WaitlistForm.tsx     Reusable form (used by all CTAs)
    Wordmark.tsx         Brand mark
    Reveal.tsx           Scroll reveal wrapper
```
