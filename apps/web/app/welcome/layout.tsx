import { playfair } from "../fonts";
import FullscreenLock from "../components/FullscreenLock";
import "../auth-theme.css";
import "./welcome.css";

export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${playfair.variable} auth-theme auth-theme-light auth-fullscreen font-sans`}>
      <FullscreenLock background="#f8fbfb" />
      {children}
    </div>
  );
}
