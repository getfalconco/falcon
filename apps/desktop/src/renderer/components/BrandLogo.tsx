import { useSyncExternalStore, type ImgHTMLAttributes } from "react";
import logoBlack from "@/assets/brand/logo-black.png";
import logoWhite from "@/assets/brand/logo-white.png";
import { getThemeSnapshot, subscribeTheme, type Theme } from "@/lib/theme";

/**
 * The Falcon mark in the ink of the theme in force: black on the light
 * canvas, white on the dark one. It watches `data-theme` on <html>, so it
 * follows Settings, Appearance and, while that is set to System, the OS.
 *
 * For a mark that always sits on a dark tile (the update pill) import
 * `logo-white.png` directly; this is for a mark on the page's own surface.
 */
export function useBrandLogoSrc(): string {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, (): Theme => "light");
  return theme === "dark" ? logoWhite : logoBlack;
}

export default function BrandLogo({ alt = "Falcon", ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  return <img src={useBrandLogoSrc()} alt={alt} {...rest} />;
}
