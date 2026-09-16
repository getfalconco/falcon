"use client";

import dynamic from "next/dynamic";

const ShaderGradientPanel = dynamic(() => import("./ShaderGradientPanel"), {
  ssr: false,
  // Matches the dark end of the panel's Turkish blue ramp, so the placeholder
  // doesn't flash grey before the shader mounts.
  loading: () => <div className="h-full min-h-[240px] bg-[#05262f]" aria-hidden />,
});

export default function AnimatedGradientPanel() {
  return <ShaderGradientPanel />;
}
