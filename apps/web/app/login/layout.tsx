import { playfair } from "../fonts";
import FullscreenLock from "../components/FullscreenLock";
import "../auth-theme.css";


export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${playfair.variable} auth-theme auth-theme-light auth-fullscreen font-sans`}>
      <FullscreenLock background="#fdfdfd" />
      {children}
    </div>
  );
}
