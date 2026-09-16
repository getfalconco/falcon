import { useState } from "react";
import InstallScreen from "./components/InstallScreen";
import WelcomeScreen from "./components/WelcomeScreen";

type Screen = "welcome" | "install";

/** Must match the .fade-out duration in globals.css. */
const FADE_OUT_MS = 260;

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [leaving, setLeaving] = useState(false);

  // One window throughout: the welcome screen fades out, then the install
  // screen mounts and rises in on its own stagger.
  const goToInstall = () => {
    // Start the real run now, so the download is already moving by the time
    // the install screen finishes fading in.
    void window.falconInstaller?.startInstall();
    setLeaving(true);
    window.setTimeout(() => {
      setScreen("install");
      setLeaving(false);
    }, FADE_OUT_MS);
  };

  return (
    <div className={`h-full ${leaving ? "fade-out" : ""}`}>
      {screen === "welcome" ? (
        <WelcomeScreen onContinue={goToInstall} />
      ) : (
        <InstallScreen />
      )}
    </div>
  );
}
