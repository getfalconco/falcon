import { playfair } from "../fonts";
import FullscreenLock from "../components/FullscreenLock";
import "../auth-theme.css";

/** Same shell as /login: light auth theme, viewport locked. */
export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${playfair.variable} auth-theme auth-theme-light auth-fullscreen font-sans`}>
      <FullscreenLock background="#fdfdfd" />
      {children}
    </div>
  );
}
