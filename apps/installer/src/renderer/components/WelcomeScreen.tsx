import BrandMark from "./BrandMark";
import WindowControls from "./WindowControls";

const COPY = {
  subtitle: "See the next move, right from your desktop.",
  action: "Get started",
} as const;

/** The installer names the platform it is running on, like the app store does. */
function platformName(platform: NodeJS.Platform | undefined): string {
  if (platform === "darwin") return "Mac";
  if (platform === "win32") return "Windows";
  return "Desktop";
}

export default function WelcomeScreen({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const platform = window.falconInstaller?.platform;

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
            Falcon <span className="italic">for</span> {platformName(platform)}
          </h1>

          <p
            className="rise-in mt-3 max-w-[400px] text-[14px] font-light leading-[20px] text-[#6b7280]"
            style={{ animationDelay: "0.08s" }}
          >
            {COPY.subtitle}
          </p>
        </main>

        <footer className="shrink-0 px-[4.5rem] pb-14">
          <button
            type="button"
            onClick={onContinue}
            className="rise-in app-no-drag flex h-[45px] w-full cursor-pointer items-center justify-center rounded-[10px] bg-[#1c1917] text-[14px] leading-5 text-[rgb(231,231,231)] transition-colors hover:bg-[#0f0d0b]"
            style={{ animationDelay: "0.12s" }}
          >
            {COPY.action}
          </button>
        </footer>
      </div>
    </div>
  );
}
