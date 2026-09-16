import { useState } from "react";
import { useInstallProgress } from "@/hooks/useInstallProgress";
import BrandMark from "./BrandMark";
import { ProgressBar } from "./ui/progress-bar";
import WindowControls from "./WindowControls";

export default function InstallScreen() {
  const { value, label, done, failed, error } = useInstallProgress();
  // A launch that quietly does nothing is worse than one that says why.
  const [launchError, setLaunchError] = useState<string | null>(null);
  const problem = error ?? launchError;

  return (
    <div className="app-drag-region relative h-full w-full overflow-hidden rounded-[12px] bg-[#fcfcfa]">
      <div className="flex h-full flex-col">
        <header className="flex h-11 shrink-0 items-center justify-end pr-3">
          <WindowControls />
        </header>

        <main className="flex flex-1 flex-col items-center justify-center px-12 pb-10 text-center">
          <BrandMark className="rise-in h-12 w-12" />

          <h1
            className="rise-in mt-10 font-serif text-[30px] font-normal leading-[1.15] text-[rgb(29,27,27)]"
            style={{ animationDelay: "0.04s" }}
          >
            {failed ? "Something went wrong" : done ? "Falcon is ready" : "Setting up Falcon"}
          </h1>

          {problem ? (
            <p className="mt-5 max-w-[400px] font-mono text-[11px] leading-[17px] text-[#b3453f]">
              {problem}
            </p>
          ) : null}
        </main>

        {/* The bar sits where the launch button will be, and the two crossfade
            in place, so nothing on the screen shifts when the run finishes. */}
        <footer className="shrink-0 px-[4.5rem] pb-14">
          <div className="rise-in relative h-[46px]" style={{ animationDelay: "0.08s" }}>
            <div
              className={`absolute inset-x-0 top-0 transition-opacity duration-500 ${
                done || failed ? "opacity-0" : "opacity-100"
              }`}
            >
              {/* The pending label shares a grid cell with the percentage, so
                  its width is reserved even while hidden. Keep it short, or it
                  eats into the file name beside it. */}
              <ProgressBar
                value={value}
                label={label}
                pendingLabel="Connecting"
                completeLabel="Falcon is installed"
              />
            </div>

            <button
              type="button"
              disabled={!done}
              onClick={() => {
                void window.falconInstaller?.launchFalcon().then((res) => {
                  if (!res.ok) {
                    setLaunchError(
                      "Falcon was installed but could not be started. Open it from the Start menu.",
                    );
                  }
                });
              }}
              className={`app-no-drag absolute inset-x-0 bottom-0 flex h-[45px] items-center justify-center rounded-[10px] bg-[#1c1917] text-[14px] leading-5 text-[rgb(231,231,231)] transition-all duration-500 hover:bg-[#0f0d0b] ${
                done
                  ? "cursor-pointer opacity-100"
                  : "pointer-events-none opacity-0"
              }`}
            >
              Launch Falcon
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
