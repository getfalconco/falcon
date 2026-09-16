"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";

const LandingGradientCanvas = dynamic(() => import("./LandingGradientCanvas"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#111111]" aria-hidden />,
});

// TEST: Fluted Glass shader swapped in for the liquid gradient. The liquid
// (LandingGradientCanvas above) is kept intact — to revert, flip the two lines
// in the JSX below.
const ShaderBackground = dynamic(
  () => import("./ui/fluted-glass-folds").then((m) => m.ShaderBackground),
  {
    ssr: false,
    loading: () => <div className="absolute inset-0 bg-[#111111]" aria-hidden />,
  },
);

const PREVIEW_SRC = "/landing-app-preview.png";

// Turkish blue: bright turquoise → deep teal → near-black, with a pale tip.
// Same four-stop structure the shader ships with, just a warmer-cyan family.
const TURKISH_BLUE: [number, number, number][] = [
  [0.31, 0.847, 0.902], // #4fd8e6
  [0.059, 0.49, 0.573], // #0f7d92
  [0.02, 0.149, 0.184], // #05262f
  // The brightest stop stays blue instead of washing out to white.
  [0.435, 0.867, 0.933], // #6fddee
];

function markImageReady(
  img: HTMLImageElement | null,
  setImageReady: (ready: boolean) => void,
) {
  if (img?.complete && img.naturalWidth > 0) {
    setImageReady(true);
  }
}

export default function LandingDesktopPreview() {
  const [imageReady, setImageReady] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    markImageReady(imgRef.current, setImageReady);

    const fallback = window.setTimeout(() => {
      setImageReady(true);
    }, 1500);

    return () => window.clearTimeout(fallback);
  }, []);

  return (
    <div className="mx-auto mt-14 w-[97%] overflow-hidden rounded-xl bg-[#0d0d0d] sm:mt-16">
      {/* Mobile keeps a fixed height: pairing aspect-ratio with a min-height
          made the box grow sideways (880px) instead of taller. */}
      <div className="relative h-[480px] overflow-hidden rounded-xl sm:aspect-[16/10] sm:h-auto sm:min-h-[560px]">
        {/* Liquid gradient kept — temporarily swapped for the Fluted Glass test.
        <LandingGradientCanvas /> */}
        <ShaderBackground
          className="absolute inset-0"
          colors={TURKISH_BLUE}
          colorCount={4}
        />

        {/* App preview image hidden for now — gradient background kept.
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4 sm:p-6">
          <motion.div
            initial={{ opacity: 0, scale: 1.12, filter: "blur(20px)" }}
            animate={
              imageReady
                ? { opacity: 1, scale: 1, filter: "blur(0px)" }
                : { opacity: 0, scale: 1.12, filter: "blur(20px)" }
            }
            transition={{
              duration: 1.1,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="h-auto w-[74%] min-w-[320px] max-w-[1150px] will-change-[transform,opacity,filter]"
          >
            <img
              ref={imgRef}
              src={PREVIEW_SRC}
              alt="Falcon app preview showing market analysis"
              width={1553}
              height={937}
              decoding="async"
              onLoad={() => setImageReady(true)}
              className="h-auto w-full shadow-[0_20px_60px_rgba(0,0,0,0.65)]"
            />
          </motion.div>
        </div>
        */}
      </div>
    </div>
  );
}
