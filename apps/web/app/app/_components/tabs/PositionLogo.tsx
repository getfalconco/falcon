"use client";

import { useState } from "react";
import { logoLook, logoUrl, type LogoLook } from "@/lib/logo";
import { monogram } from "@/lib/workspace/positions-view";

/**
 * A holding's logo through Falcon's own /api/logo route (lib/logo.ts: never a
 * third-party URL in the browser), on its own: no tile, fill or border.
 *
 * In order: the brand-colour logo, shown as it is; when it has none, or it
 * sits on its own opaque box, the light mono mark drawn as a dark silhouette
 * in the light theme (as it is in the dark one); else muted letters. A
 * colour logo that is near white is drawn as a silhouette in the light theme
 * only, and a near-black one gets a faint glow in the dark theme only, so
 * neither vanishes. The look is read from the image itself on a small canvas
 * (same origin) once it loads; the image stays hidden until then. Options use
 * their underlying's logo, crypto its coin's.
 */

type Stage = "color" | "mono" | "letters";

/** Reads the loaded image's look; null when it cannot be read. */
function readLook(img: HTMLImageElement): LogoLook | null {
  try {
    const n = 24;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, n, n);
    return logoLook(ctx.getImageData(0, 0, n, n).data, n, n);
  } catch {
    return null;
  }
}

const SILHOUETTE = "opacity-80 [filter:brightness(0)]";

export function PositionLogo({ row, size = 18 }: { row: { kind: string; ticker: string | null; symbol: string; label: string }; size?: number }) {
  const color = logoUrl(row, "color");
  const mono = logoUrl(row, "mono");
  // Per source URL, so a different row never inherits another's stage.
  const [state, setState] = useState<{ url: string | null; stage: Stage; look: LogoLook | null }>({ url: color, stage: "color", look: null });
  const current = state.url === color ? state : { url: color, stage: "color" as Stage, look: null };
  const stage: Stage = !color ? "letters" : current.stage;
  const src = stage === "color" ? color : stage === "mono" ? mono : null;

  const next = (from: Stage) => setState({ url: color, stage: from === "color" && mono ? "mono" : "letters", look: null });
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (stage !== "color") return;
    const look = readLook(e.currentTarget);
    if (look?.background) next("color");
    else setState({ url: color, stage: "color", look: look ?? { background: false, dark: false, light: false } });
  };

  let className = "object-contain";
  if (stage === "mono") className += ` ${SILHOUETTE} dark:opacity-100 dark:[filter:drop-shadow(0_0_1px_rgba(255,255,255,0.35))]`;
  else if (!current.look) className += " opacity-0";
  else if (current.look.light) className += ` ${SILHOUETTE} dark:opacity-100 dark:[filter:none]`;
  else if (current.look.dark) className += " dark:[filter:drop-shadow(0_0_1px_rgba(255,255,255,0.55))]";

  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a tiny same-origin icon; next/image adds nothing here.
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onLoad={onLoad}
          onError={() => next(stage)}
          className={className}
          style={{ width: size, height: size }}
        />
      ) : (
        <span className="text-[9.5px] font-semibold tracking-[0.02em] text-faint">{monogram(row.label)}</span>
      )}
    </span>
  );
}
