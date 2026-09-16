import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        "ink",
        "fg",
        { fg: ["muted", "faint"] },
        "gain",
        { gain: ["soft", "muted", "bright", "deep"] },
        "loss",
        { loss: ["soft", "muted"] },
        "accent",
        "background-100",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
