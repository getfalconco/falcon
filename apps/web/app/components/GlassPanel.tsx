"use client";

import dynamic from "next/dynamic";

const ShaderBackground = dynamic(
  () => import("./ui/fluted-glass-folds").then((m) => m.ShaderBackground),
  { ssr: false },
);

// The site's Turkish blue, same stops as the hero glass.
const TURKISH_BLUE: [number, number, number][] = [
  [0.31, 0.847, 0.902], // #4fd8e6
  [0.059, 0.49, 0.573], // #0f7d92
  [0.02, 0.149, 0.184], // #05262f
  [0.435, 0.867, 0.933], // #6fddee
];

/**
 * A framed slab of the fluted glass, for pages that want it beside their copy
 * rather than under the hero. Children float on top (a screenshot, later).
 */
export default function GlassPanel({
  className = "",
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-[#05262f] ${className}`}
    >
      <ShaderBackground
        className="absolute inset-0"
        colors={TURKISH_BLUE}
        colorCount={4}
      />
      {children ? (
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      ) : null}
    </div>
  );
}
