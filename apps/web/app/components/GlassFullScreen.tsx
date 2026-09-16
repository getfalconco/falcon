"use client";

import dynamic from "next/dynamic";

const ShaderBackground = dynamic(
  () => import("./ui/fluted-glass-folds").then((m) => m.ShaderBackground),
  { ssr: false },
);

// Turkish blue: bright turquoise → deep teal → near-black, with a pale tip.
// Same four-stop structure the shader ships with, just a warmer-cyan family.
const TURKISH_BLUE: [number, number, number][] = [
  [0.31, 0.847, 0.902], // #4fd8e6
  [0.059, 0.49, 0.573], // #0f7d92
  [0.02, 0.149, 0.184], // #05262f
  // The brightest stop stays blue instead of washing out to white.
  [0.435, 0.867, 0.933], // #6fddee
];

export default function GlassFullScreen() {
  return (
    <div className="fixed inset-0 overflow-hidden bg-[#05262f]">
      <ShaderBackground
        className="absolute inset-0"
        colors={TURKISH_BLUE}
        colorCount={4}
      />
    </div>
  );
}
