"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "./lib/utils";

const buttonVariantsOuter = cva("", {
  variants: {
    variant: {
      primary:
        "w-full border border-[1px] border-black/10 bg-gradient-to-b from-black/70 to-black p-[1px] transition duration-300 ease-in-out disabled:opacity-50 disabled:pointer-events-none",
      secondary:
        "w-full border border-[1px] border-black/10 bg-gradient-to-b from-neutral-200/50 to-neutral-300/40 p-[1px] transition duration-300 ease-in-out disabled:opacity-50 disabled:pointer-events-none",
    },
    size: {
      sm: "rounded-[6px]",
      default: "rounded-[12px]",
      lg: "rounded-[12px]",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "default",
  },
});

const innerDivVariants = cva("w-full h-full flex items-center justify-center", {
  variants: {
    variant: {
      primary:
        "gap-2 bg-gradient-to-b from-neutral-800 to-black text-sm text-white/90 transition duration-300 ease-in-out hover:from-stone-800 hover:to-neutral-800/70 active:from-black active:to-black",
      secondary:
        "gap-2.5 bg-gradient-to-b from-white to-neutral-50 text-sm font-semibold text-ink transition duration-300 ease-in-out hover:from-white hover:to-neutral-100 active:from-neutral-50 active:to-neutral-100",
    },
    size: {
      sm: "text-xs rounded-[4px] px-4 py-1.5",
      default: "text-sm rounded-[10px] px-4 py-2.5",
      lg: "text-base rounded-[10px] px-6 py-2.5",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "default",
  },
});

export interface TextureButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  size?: "default" | "sm" | "lg";
  asChild?: boolean;
}

export const TextureButton = React.forwardRef<HTMLButtonElement, TextureButtonProps>(
  (
    {
      children,
      variant = "primary",
      size = "default",
      asChild = false,
      className,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        className={cn(buttonVariantsOuter({ variant, size }), className)}
        ref={ref}
        {...props}
      >
        <div className={cn(innerDivVariants({ variant, size }))}>
          <span className="inline-flex items-center gap-2.5 font-medium">
            {children}
          </span>
        </div>
      </Comp>
    );
  },
);

TextureButton.displayName = "TextureButton";
