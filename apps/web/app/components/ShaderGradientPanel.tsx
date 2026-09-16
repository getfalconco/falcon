"use client";

import { Canvas } from "@react-three/fiber";
import { AUTH_PANEL_LINES } from "@/lib/marketing-copy";
import GradientTestimonials from "./GradientTestimonials";
import GrainyGradient from "./ui/gradient-shader-card";
import GradientErrorBoundary from "./GradientErrorBoundary";

// Turkish blue, in the same light → dark structure as the shader's shipped
// greyscale ramp. Same family as the homepage pattern (#6fddee → #05262f), so
// the login panel reads as one product with the landing page.
const TURKISH_BLUE_RAMP = [
  "#d9f6fa",
  "#9fe6f0",
  "#63d2e2",
  "#34a8bd",
  "#1a7f95",
  "#0f5468",
  "#093b49",
  "#05262f",
  "#02141a",
] as const;

export default function ShaderGradientPanel() {
  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <GradientErrorBoundary>
        <div className="absolute inset-0">
          <Canvas
            camera={{ position: [0, 0, 1] }}
            gl={{ preserveDrawingBuffer: true, antialias: true }}
            style={{ width: "100%", height: "100%" }}
          >
            <GrainyGradient colors={TURKISH_BLUE_RAMP} />
          </Canvas>
        </div>
      </GradientErrorBoundary>

      <div className="pointer-events-none absolute inset-0 z-10">
        <GradientTestimonials testimonials={AUTH_PANEL_LINES} />
      </div>
    </div>
  );
}
