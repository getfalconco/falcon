import type { SVGProps } from "react";

/** Design coordinates of the SVG frame (paths are authored for this box). */
const VB_W = 200;
const VB_H = 400;

/** Screen inset inside the bezel, in design units. */
const SCREEN = { x: 14.08, y: 12.81, w: 171.98, h: 374.37, r: 24.62 };

export interface Iphone16ProProps
  extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  width?: number;
  height?: number;
  /** Full-bleed screenshot shown in the screen area (HTML img for crisp retina). */
  src?: string;
  alt?: string;
}

export function Iphone16Pro({
  width = 200,
  height = 400,
  src,
  alt = "",
  className,
  style,
  ...props
}: Iphone16ProProps) {
  const screenLeft = `${(SCREEN.x / VB_W) * 100}%`;
  const screenTop = `${(SCREEN.y / VB_H) * 100}%`;
  const screenWidth = `${(SCREEN.w / VB_W) * 100}%`;
  const screenHeight = `${(SCREEN.h / VB_H) * 100}%`;
  // A single percentage would resolve its horizontal radius against the screen
  // width and its vertical radius against the height, bending the corner into
  // an ellipse that cuts inside the bezel's circular arc and leaves a gap. The
  // two-value form pins both axes to the same absolute radius at any size.
  const screenRadius = `${(SCREEN.r / SCREEN.w) * 100}% / ${(SCREEN.r / SCREEN.h) * 100}%`;

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width,
        maxWidth: "100%",
        aspectRatio: `${VB_W} / ${VB_H}`,
        ...style,
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          width={1206}
          height={2622}
          decoding="async"
          className="absolute object-cover"
          style={{
            left: screenLeft,
            top: screenTop,
            width: screenWidth,
            height: screenHeight,
            borderRadius: screenRadius,
          }}
        />
      ) : (
        <div
          aria-hidden
          className="absolute"
          style={{
            left: screenLeft,
            top: screenTop,
            width: screenWidth,
            height: screenHeight,
            borderRadius: screenRadius,
            background: "currentColor",
          }}
        />
      )}

      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden
        {...props}
      >
        <path
          fill="#303333"
          d="M196.11,128.09c0-.25-.2-.45-.45-.45-.11.04-.37.03-.69,0V36.69c0-17.84-14.46-32.31-32.31-32.31H37.48C19.63,4.39,5.17,18.85,5.17,36.69v48.99c-.3.02-.55.03-.66-.02-.25,0-.45.2-.45.45,0,0,0,17.29,0,17.29-.03.41.5.49,1.11.48v13.63c-.61,0-1.14.08-1.11.48,0,0,0,28.54,0,28.54-.03.42.5.49,1.11.48v7.95c-.61,0-1.14.08-1.11.48,0,0,0,28.54,0,28.54-.03.42.5.49,1.11.48v178.86c0,17.84,14.46,32.31,32.31,32.31h125.2c17.84,0,32.31-14.46,32.31-32.31v-188.87c.32-.02.58-.03.69.04,1.26.1.03-45.94.45-46.38ZM186.07,362.63c0,13.56-10.99,24.56-24.56,24.56H38.64c-13.56,0-24.56-10.99-24.56-24.56V37.37c0-13.56,10.99-24.56,24.56-24.56h122.87c13.56,0,24.56,10.99,24.56,24.56v325.26Z"
        />
        <path
          fill="#000000"
          d="M161.38,7.29H38.78c-16.54,0-29.95,13.41-29.95,29.95v325.52c0,16.54,13.41,29.95,29.95,29.95h122.6c16.54,0,29.95-13.41,29.95-29.95V37.24c0-16.54-13.41-29.95-29.95-29.95ZM186.07,362.57c0,13.6-11.02,24.62-24.62,24.62H38.7c-13.6,0-24.62-11.02-24.62-24.62V37.43c0-13.6,11.02-24.62,24.62-24.62h122.75c13.6,0,24.62,11.02,24.62,24.62v325.14Z"
        />
        <path
          fill="#000000"
          d="M119.61,33.86h-38.93c-10.48-.18-10.5-15.78,0-15.96,0,0,38.93,0,38.93,0,4.41,0,7.98,3.57,7.98,7.98,0,4.41-3.57,7.98-7.98,7.98Z"
        />
        <path
          fill="#080d4c"
          d="M118.78,29.21c-4.32.06-4.32-6.73,0-6.66,4.32-.06,4.32,6.73,0,6.66Z"
        />
      </svg>
    </div>
  );
}
