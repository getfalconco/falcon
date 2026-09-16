import type { Metadata } from "next";
import { Inter, Playfair_Display, Libre_Baskerville } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { SEO } from "@/lib/marketing-copy";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

const libreBaskerville = Libre_Baskerville({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-libre-baskerville",
  display: "swap",
});

export const metadata: Metadata = {
  // Browser tabs get the bare name; the full line still goes to search and
  // social cards below.
  title: "Falcon",
  description: SEO.description,
  icons: {
    icon: "/brand/logo-black-glass.png",
    shortcut: "/brand/logo-black-glass.png",
    apple: "/brand/logo-black-glass.png",
  },
  openGraph: {
    title: SEO.title,
    description: SEO.openGraphDescription,
    type: "website",
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO.title,
    description: SEO.openGraphDescription,
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${libreBaskerville.variable} ${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-[#fdfdfd] font-sans text-[#111111] antialiased">
        {children}
      </body>
    </html>
  );
}
