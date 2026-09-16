"use client";

import { useState } from "react";
import { ThemeSwitcher } from "@/components/ui/apple-liquid-glass-switcher";

type Theme = "light" | "dark" | "dim";

export default function LiquidGlassSwitcherDemoPage() {
  const [theme, setTheme] = useState<Theme>("light");

  return (
    <div className="theme-provider" data-theme={theme}>
      <ThemeSwitcher value={theme} onValueChange={setTheme} />
      <article className="article">
        <h1>Soft UI theme</h1>
        <p>
          Neumorphic three-way switcher — recessed track, raised thumb, thin
          line icons. Cycle light, dark, and dim.
        </p>
        <p className="box">
          Component: <code>@/components/ui/apple-liquid-glass-switcher</code>
        </p>
      </article>
    </div>
  );
}
