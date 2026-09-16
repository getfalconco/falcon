import { Playfair_Display } from "next/font/google";
import FullscreenLock from "../components/FullscreenLock";
import "../auth-theme.css";

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${playfair.variable} auth-theme auth-theme-light auth-fullscreen font-sans`}>
      <FullscreenLock background="#fdfdfd" />
      {children}
    </div>
  );
}
