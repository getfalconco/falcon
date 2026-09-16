import Image from "next/image";
import { cn } from "@/lib/utils";

type BrandMarkProps = {
  className?: string;
  size?: number;
};

/**
 * Falcon mark that swaps for light vs dark theme.
 * - on-light: black mark (for light backgrounds)
 * - on-dark: light mark (for dark backgrounds)
 */
export default function BrandMark({ className, size = 28 }: BrandMarkProps) {
  return (
    <span className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <Image
        src="/brand/falcon-icon-on-light.png"
        alt=""
        width={size}
        height={size}
        className="h-full w-full dark:hidden"
        priority
      />
      <Image
        src="/brand/falcon-icon-on-dark.png"
        alt=""
        width={size}
        height={size}
        className="hidden h-full w-full dark:block"
        priority
      />
    </span>
  );
}
