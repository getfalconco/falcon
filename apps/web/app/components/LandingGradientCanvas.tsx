"use client";

import { Canvas } from "@react-three/fiber";
import GrainyGradient from "./ui/gradient-shader-card";
import GradientErrorBoundary from "./GradientErrorBoundary";

export default function LandingGradientCanvas() {
  return (
    <GradientErrorBoundary>
      <div className="absolute inset-0">
        <Canvas
          camera={{ position: [0, 0, 1] }}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          style={{ width: "100%", height: "100%" }}
        >
          <GrainyGradient gradientRotationDegrees={45} />
        </Canvas>
      </div>
    </GradientErrorBoundary>
  );
}
