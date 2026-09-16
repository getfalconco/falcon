"use client";

import { useEffect } from "react";

/** Locks document scroll and fills the viewport for auth screens. */
export default function FullscreenLock({
  background = "hsl(0 0% 3.5%)",
}: {
  background?: string;
}) {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    const previous = {
      htmlOverflow: html.style.overflow,
      htmlHeight: html.style.height,
      bodyOverflow: body.style.overflow,
      bodyHeight: body.style.height,
      bodyMargin: body.style.margin,
      bodyPadding: body.style.padding,
      bodyBackground: body.style.backgroundColor,
    };

    html.style.overflow = "hidden";
    html.style.height = "100%";
    body.style.overflow = "hidden";
    body.style.height = "100dvh";
    body.style.margin = "0";
    body.style.padding = "0";
    body.style.backgroundColor = background;

    return () => {
      html.style.overflow = previous.htmlOverflow;
      html.style.height = previous.htmlHeight;
      body.style.overflow = previous.bodyOverflow;
      body.style.height = previous.bodyHeight;
      body.style.margin = previous.bodyMargin;
      body.style.padding = previous.bodyPadding;
      body.style.backgroundColor = previous.bodyBackground;
    };
  }, [background]);

  return null;
}
